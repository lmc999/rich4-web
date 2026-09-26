/**
 * 房间：大厅状态机、座位、观战者、房主、聊天；对局中持有 GameRunner（design/net.md §3、§5、§9）。
 *
 * - 所有方法同步执行并返回 Result；身份一律用 tokenHash（服务端只见 sha256(token)）。
 * - 发送经 RoomBroadcaster（按观察者投影与分组），Room 本身不接触 Socket.IO，可以直接单测。
 * - 房主必须是座位上的真人；没有座位真人时房主为空，第一个坐下的真人接任。
 * - 本里程碑持久化为内存实现：存档、读档、认领座位留接口（M5）。
 */
import { applyTrusteeSettings, isValidTrusteeSettings, type TrusteeSettings } from '@rich4/shared/ai';
import {
  CHARACTER_IDS,
  type CharacterId,
  type DebugOp,
  type EngineApi,
  type GameConfig,
  type PlayerIntent,
  type PlayerSetup,
  RULE_PRESETS,
  type RuleConfig,
  type SeatAiConfig,
  type SeatIndex,
} from '@rich4/shared/engine';
import {
  type ChatMessage,
  type ChatSender,
  fail,
  IN_GAME_MUTABLE_SETTINGS,
  ok,
  type PublicRoomSummary,
  type Result,
  type RoomClosedReason,
  type RoomPhase,
  type RoomSettings,
  type RoomSettingsPatch,
  type RoomView,
  type RoomYou,
  type SeatView,
  type SystemMsgKey,
  sanitizeChatText,
} from '@rich4/shared/net';
import { isAutopilot, type SeatControl, type Viewer } from '@rich4/shared/view';
import type { MapCatalog } from '../data/DataRegistry';
import type { AiDriver } from '../game/AiDriver';
import type { TimingOptions } from '../game/Deadlines';
import { GameRunner, type RunnerSettings } from '../game/GameRunner';
import { type Clock, dateNumOf, type Scheduler, type TimerHandle } from '../infra/clock';
import type { Logger } from '../infra/logger';
import { ChatLog } from './ChatLog';
import type { RoomBroadcaster } from './RoomBroadcaster';

export interface HumanOcc {
  kind: 'human';
  tokenHash: string;
  nickname: string;
  socketId: string | null;
  ready: boolean;
}

export interface AiOcc {
  kind: 'ai';
  ai: SeatAiConfig;
  name: string;
}

export interface SeatSlot {
  index: SeatIndex;
  occupant: HumanOcc | AiOcc | null;
  characterId: CharacterId | null;
}

export interface Spectator {
  id: string;
  tokenHash: string;
  nickname: string;
  socketId: string | null;
  idleTimer: TimerHandle | null;
}

export type MemberRole = { kind: 'seat'; seat: SeatIndex } | { kind: 'spectator'; id: string };

export interface Identity {
  tokenHash: string;
  nickname: string;
  socketId: string;
}

/** 连接中的成员（发送用） */
export interface ConnectedMember {
  tokenHash: string;
  socketId: string;
  viewer: Viewer;
}

export interface RoomTtls {
  /** 大厅无人连接多久后回收 */
  lobbyEmptyMs: number;
  /** 结束后保留多久 */
  endedMs: number;
  /** 对局中全员离线多久后回收（M5 先自动存档） */
  abandonMs: number;
  /** 断线的观战者保留多久 */
  spectatorIdleMs: number;
}

export const DEFAULT_ROOM_TTLS: Readonly<RoomTtls> = Object.freeze({
  lobbyEmptyMs: 60_000,
  endedMs: 10 * 60_000,
  abandonMs: 30 * 60_000,
  spectatorIdleMs: 60_000,
});

export interface RoomDeps {
  clock: Clock;
  scheduler: Scheduler;
  log: Logger;
  out: RoomBroadcaster;
  engine: EngineApi | null;
  maps: MapCatalog;
  ai: AiDriver;
  timing: TimingOptions;
  publicUrl: string;
  testMode: boolean;
  ttl: RoomTtls;
  /** randomBytes(16) 的 hex */
  seedHex(): string;
  /** [0, n) 的随机整数 */
  randomInt(n: number): number;
  /** 观战者 id 等随机短 id */
  newId(): string;
  /** 成员离开、被踢、房间关闭时通知会话层清掉 roomCode */
  onMemberRemoved(tokenHash: string): void;
  onClosed(room: Room, reason: RoomClosedReason): void;
}

const SEATS: readonly SeatIndex[] = [0, 1, 2, 3];

function mergeRules(cur: RuleConfig, patch: Partial<RuleConfig> | undefined): RuleConfig {
  if (!patch) return cur;
  if (patch.preset === 'program' || patch.preset === 'manual') {
    const { preset, ...rest } = patch;
    const base: RuleConfig = { ...RULE_PRESETS[preset] };
    return Object.keys(rest).length > 0 ? { ...base, ...rest, preset: 'custom' } : base;
  }
  const next: RuleConfig = { ...cur, ...patch };
  const changed = Object.keys(patch).some((k) => k !== 'preset');
  return changed && patch.preset === undefined ? { ...next, preset: 'custom' } : next;
}

export class Room {
  readonly createdAt: number;
  phase: RoomPhase | 'closed' = 'lobby';
  epoch = 0;
  settings: RoomSettings;
  hostToken: string | null;
  readonly seats: SeatSlot[] = SEATS.map((index) => ({ index, occupant: null, characterId: null }));
  readonly spectators = new Map<string, Spectator>();
  readonly chat: ChatLog;
  runner: GameRunner | null = null;
  pausedInfo: { reason: 'host' | 'all_away'; since: number } | null = null;
  private lifeTimer: TimerHandle | null = null;
  private hostTimer: TimerHandle | null = null;

  constructor(
    readonly code: string,
    private readonly deps: RoomDeps,
    settings: RoomSettings,
    host: Identity,
  ) {
    this.createdAt = deps.clock.now();
    this.settings = settings;
    this.chat = new ChatLog(() => deps.clock.now());
    this.seats[0]!.occupant = {
      kind: 'human',
      tokenHash: host.tokenHash,
      nickname: host.nickname,
      socketId: host.socketId,
      ready: false,
    };
    this.hostToken = host.tokenHash;
  }

  get inviteUrl(): string {
    return `${this.deps.publicUrl.replace(/\/$/, '')}/r/${this.code}`;
  }

  get inGame(): boolean {
    return this.phase === 'playing' || this.phase === 'paused';
  }

  // ───────────────────────── 成员查询 ─────────────────────────

  roleOf(tokenHash: string): MemberRole | null {
    for (const s of this.seats) {
      if (s.occupant?.kind === 'human' && s.occupant.tokenHash === tokenHash) return { kind: 'seat', seat: s.index };
    }
    for (const sp of this.spectators.values()) if (sp.tokenHash === tokenHash) return { kind: 'spectator', id: sp.id };
    return null;
  }

  private human(seat: SeatIndex): HumanOcc | null {
    const o = this.seats[seat]!.occupant;
    return o?.kind === 'human' ? o : null;
  }

  private humanOf(tokenHash: string): HumanOcc | null {
    const r = this.roleOf(tokenHash);
    return r?.kind === 'seat' ? this.human(r.seat) : null;
  }

  connectedMembers(): ConnectedMember[] {
    const out: ConnectedMember[] = [];
    for (const s of this.seats) {
      const o = s.occupant;
      if (o?.kind === 'human' && o.socketId) {
        out.push({ tokenHash: o.tokenHash, socketId: o.socketId, viewer: { kind: 'seat', seat: s.index } });
      }
    }
    for (const sp of this.spectators.values()) {
      if (sp.socketId) out.push({ tokenHash: sp.tokenHash, socketId: sp.socketId, viewer: { kind: 'spectator' } });
    }
    return out;
  }

  /** 连接中的成员数（大厅回收判定） */
  private connectedCount(): number {
    return this.connectedMembers().length;
  }

  private isHost(tokenHash: string): boolean {
    return this.hostToken !== null && this.hostToken === tokenHash;
  }

  controlOf(seat: SeatIndex): SeatControl {
    const c = this.runner?.controlOf(seat);
    if (c) return c;
    return this.seats[seat]!.occupant?.kind === 'ai' ? 'ai' : 'human';
  }

  // ───────────────────────── 视图 ─────────────────────────

  viewFor(tokenHash: string): RoomView {
    const role = this.roleOf(tokenHash);
    const seats = this.seats.map((s): SeatView => {
      const o = s.occupant;
      return {
        index: s.index,
        occupant:
          o === null
            ? null
            : o.kind === 'human'
              ? {
                  kind: 'human',
                  nickname: o.nickname,
                  connected: o.socketId !== null,
                  ready: o.ready,
                  isYou: o.tokenHash === tokenHash,
                }
              : { kind: 'ai', ai: o.ai, name: o.name },
        characterId: s.characterId,
        control: this.controlOf(s.index),
        isHost: o?.kind === 'human' && this.isHost(o.tokenHash),
      };
    }) as RoomView['seats'];
    const you: RoomYou =
      role?.kind === 'seat'
        ? { role: 'player', seat: role.seat, isHost: this.isHost(tokenHash) }
        : { role: 'spectator', id: role?.kind === 'spectator' ? role.id : '', isHost: false };
    const view: RoomView = {
      code: this.code,
      inviteUrl: this.inviteUrl,
      phase: this.phase === 'closed' ? 'ended' : this.phase,
      epoch: this.epoch,
      seats,
      spectators: [...this.spectators.values()].map((sp) => ({ id: sp.id, nickname: sp.nickname })),
      settings: this.settings,
      you,
      serverNow: this.deps.clock.now(),
    };
    if (this.pausedInfo) view.paused = { ...this.pausedInfo };
    return view;
  }

  summary(): PublicRoomSummary {
    const hostName = this.hostToken ? (this.humanOf(this.hostToken)?.nickname ?? '') : '';
    return {
      code: this.code,
      hostName,
      phase: this.phase === 'closed' ? 'ended' : this.phase,
      mapId: this.settings.game.mapId,
      humans: this.seats.filter((s) => s.occupant?.kind === 'human').length,
      ais: this.seats.filter((s) => s.occupant?.kind === 'ai').length,
      spectators: this.spectators.size,
      allowSpectators: this.settings.allowSpectators,
      createdAt: this.createdAt,
    };
  }

  private broadcastState(): void {
    if (this.phase !== 'closed') this.deps.out.roomState(this);
  }

  private systemMsg(key: SystemMsgKey, params: Record<string, string | number> = {}): void {
    this.deps.out.chat(this, this.chat.system(key, params));
  }

  /** 新成员或恢复的成员：补发房间状态、聊天记录与对局快照 */
  private greet(
    tokenHash: string,
    socketId: string,
    mode: 'snapshot' | { lastSeq: number; epoch: number },
  ): 'lobby' | 'events' | 'snapshot' {
    const role = this.roleOf(tokenHash);
    let result: 'lobby' | 'events' | 'snapshot' = 'lobby';
    if (this.runner && this.phase !== 'lobby' && role) {
      const viewer: Viewer = role.kind === 'seat' ? { kind: 'seat', seat: role.seat } : { kind: 'spectator' };
      const cu = mode === 'snapshot' ? null : this.runner.catchupMsg(viewer, mode.lastSeq, mode.epoch);
      if (cu) {
        this.deps.out.toSocket(socketId, 'game:catchup', cu);
        result = 'events';
      } else {
        this.deps.out.toSocket(socketId, 'game:snapshot', this.runner.snapshotMsg(viewer));
        result = 'snapshot';
      }
      if (this.phase === 'ended') this.deps.out.toSocket(socketId, 'game:over', this.runner.gameOverMsg());
    }
    this.broadcastState();
    this.deps.out.toSocket(socketId, 'chat:history', { messages: this.chat.historyFor(role?.kind === 'spectator') });
    return result;
  }

  // ───────────────────────── 生命周期计时 ─────────────────────────

  private setLifeTimer(ms: number | null, reason: RoomClosedReason = 'idle'): void {
    this.lifeTimer?.cancel();
    this.lifeTimer = null;
    if (ms === null) return;
    this.lifeTimer = this.deps.scheduler.after(ms, () => {
      this.lifeTimer = null;
      this.close(reason);
    });
  }

  /** 大厅没有连接中的成员时开始回收倒计时，有人就取消 */
  private refreshLobbyTimer(): void {
    if (this.phase !== 'lobby') return;
    if (this.connectedCount() === 0) {
      if (!this.lifeTimer) this.setLifeTimer(this.deps.ttl.lobbyEmptyMs);
    } else {
      this.setLifeTimer(null);
    }
  }

  // ───────────────────────── 大厅操作 ─────────────────────────

  /**
   * 只读的可加入性检查（与 join 的判定一致）：handler 先用它确认目标房间能进，再离开原大厅房间，
   * 避免目标房间满员、对局中或禁止观战时白白丢掉原座位。
   */
  canJoin(tokenHash: string, role: 'player' | 'spectator'): Result<void> {
    if (this.phase === 'closed') return fail('ROOM_NOT_FOUND');
    if (this.roleOf(tokenHash)) return ok(undefined);
    if (role === 'player') {
      if (this.phase !== 'lobby') return fail('ROOM_IN_GAME');
      if (!this.seats.some((s) => s.occupant === null)) return fail('ROOM_FULL');
      return ok(undefined);
    }
    if (!this.settings.allowSpectators) return fail('SPECTATORS_DISABLED');
    if (this.spectators.size >= this.settings.maxSpectators) return fail('ROOM_FULL');
    return ok(undefined);
  }

  join(who: Identity, role: 'player' | 'spectator'): Result<{ you: RoomYou }> {
    if (this.phase === 'closed') return fail('ROOM_NOT_FOUND');
    const existing = this.roleOf(who.tokenHash);
    if (existing) {
      // 已是成员：视为刷新后重新进入（挂上新 socket，发快照）
      this.attachSocket(who.tokenHash, who.socketId, who.nickname);
      this.greet(who.tokenHash, who.socketId, 'snapshot');
      return ok({ you: this.viewFor(who.tokenHash).you });
    }
    if (role === 'player') {
      if (this.phase !== 'lobby') return fail('ROOM_IN_GAME');
      const slot = this.seats.find((s) => s.occupant === null);
      if (!slot) return fail('ROOM_FULL');
      slot.occupant = {
        kind: 'human',
        tokenHash: who.tokenHash,
        nickname: who.nickname,
        socketId: who.socketId,
        ready: false,
      };
      this.systemMsg('playerJoined', { nickname: who.nickname, seat: slot.index });
      this.claimOrphanedHost(who.tokenHash, who.nickname, slot.index);
    } else {
      if (!this.settings.allowSpectators) return fail('SPECTATORS_DISABLED');
      if (this.spectators.size >= this.settings.maxSpectators) return fail('ROOM_FULL');
      const id = this.deps.newId();
      this.spectators.set(id, {
        id,
        tokenHash: who.tokenHash,
        nickname: who.nickname,
        socketId: who.socketId,
        idleTimer: null,
      });
      this.systemMsg('spectatorJoined', { nickname: who.nickname });
    }
    this.refreshLobbyTimer();
    this.greet(who.tokenHash, who.socketId, 'snapshot');
    return ok({ you: this.viewFor(who.tokenHash).you });
  }

  resume(who: Identity, lastSeq: number, epoch: number): Result<{ mode: 'lobby' | 'events' | 'snapshot' }> {
    if (this.phase === 'closed') return fail('ROOM_NOT_FOUND');
    if (!this.roleOf(who.tokenHash)) return fail('NOT_IN_ROOM');
    this.attachSocket(who.tokenHash, who.socketId, who.nickname);
    const mode = this.greet(who.tokenHash, who.socketId, { lastSeq, epoch });
    return ok({ mode });
  }

  /** 把成员挂到新的 socket 上（重连、刷新、同 token 新标签页） */
  private attachSocket(tokenHash: string, socketId: string, nickname: string): void {
    const role = this.roleOf(tokenHash);
    if (!role) return;
    if (role.kind === 'spectator') {
      const sp = this.spectators.get(role.id)!;
      sp.socketId = socketId;
      sp.nickname = nickname;
      sp.idleTimer?.cancel();
      sp.idleTimer = null;
      this.refreshLobbyTimer();
      return;
    }
    const h = this.human(role.seat)!;
    const wasAway = h.socketId === null;
    h.socketId = socketId;
    h.nickname = nickname;
    if (this.isHost(tokenHash)) {
      this.hostTimer?.cancel();
      this.hostTimer = null;
    } else {
      this.claimOrphanedHost(tokenHash, nickname, role.seat);
    }
    if (this.runner && this.phase !== 'lobby') {
      this.runner.setConnected(role.seat, true);
      if (wasAway && this.phase !== 'ended') this.systemMsg('reconnected', { nickname, seat: role.seat });
    }
    if (this.phase === 'paused' && this.pausedInfo?.reason === 'all_away') this.resumeGame();
    this.setLifeTimerForPhase();
    this.refreshLobbyTimer();
  }

  /** socket 断开（不等于离开房间） */
  socketDisconnected(tokenHash: string, socketId: string): void {
    const role = this.roleOf(tokenHash);
    if (!role) return;
    if (role.kind === 'spectator') {
      const sp = this.spectators.get(role.id)!;
      if (sp.socketId !== socketId) return;
      sp.socketId = null;
      sp.idleTimer = this.deps.scheduler.after(this.deps.ttl.spectatorIdleMs, () => {
        if (sp.socketId === null && this.spectators.get(sp.id) === sp) {
          this.spectators.delete(sp.id);
          this.deps.onMemberRemoved(sp.tokenHash);
          this.broadcastState();
        }
      });
    } else {
      const h = this.human(role.seat)!;
      if (h.socketId !== socketId) return;
      h.socketId = null;
      if (this.runner && this.phase !== 'lobby') {
        this.runner.setConnected(role.seat, false);
        if (this.phase !== 'ended') this.systemMsg('disconnected', { nickname: h.nickname, seat: role.seat });
      }
      if (this.isHost(tokenHash)) this.startHostGrace();
      this.checkAllAway();
      this.setLifeTimerForPhase();
    }
    this.refreshLobbyTimer();
    this.broadcastState();
  }

  /** 房主已不可用：没有房主，或房主不是座位真人，或房主离线且没有正在进行的宽限计时 */
  private hostOrphaned(): boolean {
    if (this.hostToken === null) return true;
    const h = this.humanOf(this.hostToken);
    return h === null || (h.socketId === null && this.hostTimer === null);
  }

  /** 房主已不可用时（离线且宽限已过、对局中离开时没人可接任）交给这位刚上线或刚坐下的真人 */
  private claimOrphanedHost(tokenHash: string, nickname: string, seat: SeatIndex): void {
    if (!this.hostOrphaned()) return;
    const had = this.hostToken !== null;
    this.hostToken = tokenHash;
    if (had) this.systemMsg('hostChanged', { nickname, seat });
  }

  private startHostGrace(): void {
    this.hostTimer?.cancel();
    this.hostTimer = this.deps.scheduler.after(this.settings.reconnectGraceSec * 1000, () => {
      this.hostTimer = null;
      const h = this.hostToken ? this.humanOf(this.hostToken) : null;
      if (h && h.socketId === null) {
        const next = this.seats.find((s) => s.occupant?.kind === 'human' && s.occupant.socketId !== null);
        if (next && next.occupant?.kind === 'human') {
          this.hostToken = next.occupant.tokenHash;
          this.systemMsg('hostChanged', { nickname: next.occupant.nickname, seat: next.index });
          this.broadcastState();
        }
      }
    });
  }

  /** 房主离开或起身后移交给座位号最小的真人；没有则为空 */
  private migrateHost(except: string): void {
    const next = this.seats.find((s) => s.occupant?.kind === 'human' && s.occupant.tokenHash !== except);
    this.hostToken = next?.occupant?.kind === 'human' ? next.occupant.tokenHash : null;
    if (next?.occupant?.kind === 'human')
      this.systemMsg('hostChanged', { nickname: next.occupant.nickname, seat: next.index });
  }

  leave(tokenHash: string): Result<void> {
    const role = this.roleOf(tokenHash);
    if (!role) return fail('NOT_IN_ROOM');
    if (role.kind === 'spectator') {
      const sp = this.spectators.get(role.id)!;
      sp.idleTimer?.cancel();
      this.spectators.delete(role.id);
      this.systemMsg('spectatorLeft', { nickname: sp.nickname });
    } else if (this.inGame && this.runner) {
      // 对局中：座位转 autopilot:left，tokenHash 保留，同一 token 可以 room:resume 拿回
      const h = this.human(role.seat)!;
      h.socketId = null;
      this.runner.leave(role.seat);
      this.systemMsg('playerLeft', { nickname: h.nickname, seat: role.seat });
      if (this.isHost(tokenHash)) this.migrateHostOnline(tokenHash);
      this.checkAllAway();
      this.setLifeTimerForPhase();
    } else {
      const h = this.human(role.seat)!;
      this.seats[role.seat]!.occupant = null;
      this.seats[role.seat]!.characterId = null;
      this.systemMsg('playerLeft', { nickname: h.nickname, seat: role.seat });
      if (this.isHost(tokenHash)) this.migrateHost(tokenHash);
    }
    this.deps.onMemberRemoved(tokenHash);
    this.refreshLobbyTimer();
    this.broadcastState();
    return ok(undefined);
  }

  /** 对局中房主离开：转给第一个在线真人 */
  private migrateHostOnline(except: string): void {
    const next = this.seats.find(
      (s) => s.occupant?.kind === 'human' && s.occupant.tokenHash !== except && s.occupant.socketId !== null,
    );
    if (next?.occupant?.kind === 'human') {
      this.hostToken = next.occupant.tokenHash;
      this.systemMsg('hostChanged', { nickname: next.occupant.nickname, seat: next.index });
    }
  }

  dissolve(tokenHash: string): Result<void> {
    if (!this.roleOf(tokenHash)) return fail('NOT_IN_ROOM');
    if (!this.isHost(tokenHash)) return fail('NOT_HOST');
    this.close('dissolved');
    return ok(undefined);
  }

  updateSettings(tokenHash: string, patch: RoomSettingsPatch): Result<void> {
    if (!this.roleOf(tokenHash)) return fail('NOT_IN_ROOM');
    if (!this.isHost(tokenHash)) return fail('NOT_HOST');
    if (this.phase !== 'lobby') {
      const allowed = new Set<string>(IN_GAME_MUTABLE_SETTINGS);
      if (Object.keys(patch).some((k) => !allowed.has(k))) return fail('ROOM_IN_GAME');
    }
    const r = applySettingsPatch(this.settings, patch, this.deps.maps);
    if (!r.ok) return r;
    const gameChanged = patch.game !== undefined;
    this.settings = r.data;
    if (gameChanged) for (const s of this.seats) if (s.occupant?.kind === 'human') s.occupant.ready = false;
    this.broadcastState();
    return ok(undefined);
  }

  takeSeat(tokenHash: string, seat: SeatIndex): Result<void> {
    const role = this.roleOf(tokenHash);
    if (!role) return fail('NOT_IN_ROOM');
    if (this.phase !== 'lobby') return fail('ROOM_IN_GAME');
    const slot = this.seats[seat]!;
    if (role.kind === 'seat' && role.seat === seat) return ok(undefined);
    if (slot.occupant !== null) return fail('SEAT_TAKEN');
    if (role.kind === 'spectator') {
      const sp = this.spectators.get(role.id)!;
      sp.idleTimer?.cancel();
      this.spectators.delete(role.id);
      slot.occupant = { kind: 'human', tokenHash, nickname: sp.nickname, socketId: sp.socketId, ready: false };
      if (sp.socketId !== null) this.claimOrphanedHost(tokenHash, sp.nickname, seat);
      else if (this.hostToken === null) this.hostToken = tokenHash;
    } else {
      const from = this.seats[role.seat]!;
      slot.occupant = { ...(from.occupant as HumanOcc), ready: false };
      slot.characterId = from.characterId;
      from.occupant = null;
      from.characterId = null;
    }
    this.broadcastState();
    return ok(undefined);
  }

  toSpectator(tokenHash: string): Result<void> {
    const role = this.roleOf(tokenHash);
    if (!role) return fail('NOT_IN_ROOM');
    if (role.kind === 'spectator') return ok(undefined);
    if (this.phase !== 'lobby') return fail('ROOM_IN_GAME');
    if (!this.settings.allowSpectators) return fail('SPECTATORS_DISABLED');
    if (this.spectators.size >= this.settings.maxSpectators) return fail('ROOM_FULL');
    const h = this.human(role.seat)!;
    this.seats[role.seat]!.occupant = null;
    this.seats[role.seat]!.characterId = null;
    const id = this.deps.newId();
    this.spectators.set(id, { id, tokenHash, nickname: h.nickname, socketId: h.socketId, idleTimer: null });
    if (this.isHost(tokenHash)) this.migrateHost(tokenHash);
    this.broadcastState();
    return ok(undefined);
  }

  selectCharacter(tokenHash: string, characterId: CharacterId): Result<void> {
    const role = this.roleOf(tokenHash);
    if (!role) return fail('NOT_IN_ROOM');
    if (role.kind !== 'seat') return fail('NOT_A_PLAYER');
    if (this.phase !== 'lobby') return fail('ROOM_IN_GAME');
    if (this.seats.some((s) => s.index !== role.seat && s.characterId === characterId)) return fail('CHARACTER_TAKEN');
    this.seats[role.seat]!.characterId = characterId;
    this.broadcastState();
    return ok(undefined);
  }

  setReady(tokenHash: string, ready: boolean): Result<void> {
    const role = this.roleOf(tokenHash);
    if (!role) return fail('NOT_IN_ROOM');
    if (role.kind !== 'seat') return fail('NOT_A_PLAYER');
    if (this.phase !== 'lobby') return fail('ROOM_IN_GAME');
    this.human(role.seat)!.ready = ready;
    this.broadcastState();
    return ok(undefined);
  }

  setSeatAi(tokenHash: string, seat: SeatIndex, ai: SeatAiConfig | null): Result<void> {
    if (!this.roleOf(tokenHash)) return fail('NOT_IN_ROOM');
    if (!this.isHost(tokenHash)) return fail('NOT_HOST');
    if (this.phase !== 'lobby') return fail('ROOM_IN_GAME');
    const slot = this.seats[seat]!;
    if (slot.occupant?.kind === 'human') return fail('SEAT_TAKEN');
    if (ai === null) {
      slot.occupant = null;
      slot.characterId = null;
    } else {
      slot.occupant = {
        kind: 'ai',
        ai: { ...ai, ...(ai.overrides ? { overrides: { ...ai.overrides } } : {}) },
        name: `AI${seat + 1}`,
      };
    }
    this.broadcastState();
    return ok(undefined);
  }

  kick(tokenHash: string, target: { seat: SeatIndex } | { spectatorId: string }): Result<void> {
    if (!this.roleOf(tokenHash)) return fail('NOT_IN_ROOM');
    if (!this.isHost(tokenHash)) return fail('NOT_HOST');
    if ('spectatorId' in target) {
      const sp = this.spectators.get(target.spectatorId);
      if (!sp) return fail('BAD_REQUEST', { reason: 'noSuchSpectator' });
      sp.idleTimer?.cancel();
      this.spectators.delete(sp.id);
      if (sp.socketId) this.deps.out.toSocket(sp.socketId, 'room:closed', { reason: 'kicked' });
      this.deps.onMemberRemoved(sp.tokenHash);
      this.broadcastState();
      return ok(undefined);
    }
    const slot = this.seats[target.seat]!;
    const o = slot.occupant;
    if (o === null) return fail('BAD_REQUEST', { reason: 'emptySeat' });
    if (o.kind === 'ai') {
      if (this.phase !== 'lobby') return fail('ROOM_IN_GAME');
      slot.occupant = null;
      slot.characterId = null;
      this.broadcastState();
      return ok(undefined);
    }
    if (o.tokenHash === tokenHash) return fail('BAD_REQUEST', { reason: 'kickSelf' });
    if (this.inGame && this.runner) {
      slot.occupant = { kind: 'ai', ai: { preset: 'character' }, name: o.nickname };
      this.runner.kick(target.seat);
    } else {
      slot.occupant = null;
      slot.characterId = null;
    }
    if (o.socketId) this.deps.out.toSocket(o.socketId, 'room:closed', { reason: 'kicked' });
    this.deps.onMemberRemoved(o.tokenHash);
    this.systemMsg('kicked', { nickname: o.nickname, seat: target.seat });
    this.checkAllAway();
    this.setLifeTimerForPhase();
    this.refreshLobbyTimer();
    this.broadcastState();
    return ok(undefined);
  }

  transferHost(tokenHash: string, seat: SeatIndex): Result<void> {
    if (!this.roleOf(tokenHash)) return fail('NOT_IN_ROOM');
    if (!this.isHost(tokenHash)) return fail('NOT_HOST');
    const h = this.human(seat);
    if (!h) return fail('BAD_REQUEST', { reason: 'notHuman' });
    // 只能转给在线的真人：离线者拿到房主后没有任何机制再迁回，其余人会失去全部房主权限
    if (h.socketId === null) return fail('BAD_REQUEST', { reason: 'targetOffline' });
    this.hostToken = h.tokenHash;
    this.systemMsg('hostChanged', { nickname: h.nickname, seat });
    this.broadcastState();
    return ok(undefined);
  }

  // ───────────────────────── 开局与结束 ─────────────────────────

  start(tokenHash: string): Result<void> {
    if (!this.roleOf(tokenHash)) return fail('NOT_IN_ROOM');
    if (!this.isHost(tokenHash)) return fail('NOT_HOST');
    if (this.phase !== 'lobby') return fail('ROOM_IN_GAME');
    const parts = this.seats.filter((s) => s.occupant !== null);
    if (parts.length < 2) return fail('NOT_ENOUGH_PLAYERS');
    if (
      parts.some((s) => s.occupant?.kind === 'human' && !s.occupant.ready && s.occupant.tokenHash !== this.hostToken)
    ) {
      return fail('NOT_ALL_READY');
    }
    const chars = parts.map((s) => s.characterId).filter((c): c is CharacterId => c !== null);
    if (new Set(chars).size !== chars.length) return fail('CHARACTER_TAKEN');
    const mapId = this.settings.game.mapId;
    if (!this.deps.maps.isPlayable(mapId)) return fail('MAP_UNAVAILABLE', { mapId });
    const engine = this.deps.engine;
    if (!engine) return fail('INTERNAL', { reason: 'engineUnavailable' });

    const free = CHARACTER_IDS.filter((c) => !chars.includes(c));
    for (const s of parts) {
      if (s.characterId === null) s.characterId = free.splice(this.deps.randomInt(free.length), 1)[0]!;
    }
    const players: PlayerSetup[] = parts.map((s) => {
      const o = s.occupant!;
      const p: PlayerSetup = {
        seat: s.index,
        character: s.characterId!,
        controller: o.kind === 'human' ? 'human' : 'ai',
      };
      if (o.kind === 'ai') p.ai = o.ai;
      return p;
    });
    const config: GameConfig = {
      ...this.settings.game,
      rules: { ...this.settings.game.rules },
      startDate: dateNumOf(this.deps.clock.now()),
      debug: this.deps.testMode,
    };
    let state: ReturnType<EngineApi['createGame']>;
    try {
      state = engine.createGame(config, players, this.deps.seedHex());
    } catch (err) {
      this.deps.log.error({ err, code: this.code }, 'engine.createGame failed');
      return fail('INTERNAL', { reason: 'createGameFailed' });
    }
    this.epoch++;
    const runner = this.makeRunner(state, players);
    try {
      runner.begin();
    } catch (err) {
      runner.dispose();
      this.epoch--;
      this.deps.log.error({ err, code: this.code }, 'GameRunner.begin failed');
      return fail('INTERNAL', { reason: 'createGameFailed' });
    }
    this.phase = 'playing';
    this.pausedInfo = null;
    this.setLifeTimer(null);
    this.runner = runner;
    this.broadcastState();
    for (const m of this.connectedMembers()) {
      this.deps.out.toSocket(m.socketId, 'game:snapshot', runner.snapshotMsg(m.viewer));
    }
    this.checkAllAway();
    this.setLifeTimerForPhase();
    return ok(undefined);
  }

  private makeRunner(state: ReturnType<EngineApi['createGame']>, players: PlayerSetup[]): GameRunner {
    const runner: GameRunner = new GameRunner(
      {
        engine: this.deps.engine!,
        data: this.deps.maps.registry,
        clock: this.deps.clock,
        scheduler: this.deps.scheduler,
        log: this.deps.log.child({ room: this.code }),
        ai: this.deps.ai,
        timing: this.deps.timing,
        settings: () => this.runnerSettings(),
        hooks: {
          batch: (raw) => this.deps.out.gameBatch(this, runner, raw),
          pendingChanged: () => this.deps.out.gamePending(this, runner),
          controlChanged: (seat, control, prev) => this.onControlChanged(seat, control, prev),
          gameOver: (msg) => this.onGameOver(msg),
          timedOut: (seat, by) => {
            if (by === 'default') this.systemMsg('timeoutDefault', { seat });
          },
          aiStuck: (seat) => {
            this.deps.log.error({ room: this.code, seat }, 'AI 连续失败，暂停房间');
            this.systemMsg('aiPaused', { seat });
            this.pauseGame('host');
          },
          fault: (seat) => {
            this.deps.log.error({ room: this.code, seat }, '对局内部错误，暂停房间');
            this.systemMsg('internalError', seat === null ? {} : { seat });
            this.pauseGame('host');
          },
        },
      },
      {
        epoch: this.epoch,
        state,
        seats: players.map((p) => {
          const h = this.human(p.seat);
          return {
            seat: p.seat,
            control: p.controller === 'ai' ? 'ai' : 'human',
            connected: h ? h.socketId !== null : true,
          };
        }),
      },
    );
    return runner;
  }

  private runnerSettings(): RunnerSettings {
    const s = this.settings;
    return {
      handVisibility: s.handVisibility,
      timerPreset: s.timerPreset,
      timeoutPolicy: s.timeoutPolicy,
      aiPace: s.aiPace,
      allowMinigameDecline: s.allowMinigameDecline,
      reconnectGraceSec: s.reconnectGraceSec,
    };
  }

  private onControlChanged(seat: SeatIndex, control: SeatControl, prev: SeatControl): void {
    const nickname = this.human(seat)?.nickname ?? '';
    if (isAutopilot(control) && control !== 'autopilot:left') {
      this.systemMsg('autopilotOn', { seat, nickname, reason: control.slice('autopilot:'.length) });
    } else if (control === 'human' && isAutopilot(prev)) {
      this.systemMsg('autopilotOff', { seat, nickname });
    }
    this.broadcastState();
  }

  private onGameOver(msg: Parameters<RoomBroadcaster['gameOver']>[1]): void {
    this.phase = 'ended';
    this.pausedInfo = null;
    this.deps.out.gameOver(this, msg);
    this.broadcastState();
    this.setLifeTimer(this.deps.ttl.endedMs);
  }

  rematch(tokenHash: string): Result<void> {
    if (!this.roleOf(tokenHash)) return fail('NOT_IN_ROOM');
    if (!this.isHost(tokenHash)) return fail('NOT_HOST');
    if (this.phase !== 'ended') return fail('BAD_REQUEST', { reason: 'notEnded' });
    // 只释放对局中 room:leave 的座位（autopilot:left）；只是暂时断线（刷新、网络抖动）的保留座位，
    // 回到大厅后照常走断线与空房回收（net.md §3.1「座位和角色不变」）
    const leftSeats = new Set(this.seats.filter((s) => this.runner?.controlOf(s.index) === 'autopilot:left'));
    this.runner?.dispose();
    this.runner = null;
    this.phase = 'lobby';
    this.epoch++;
    for (const s of this.seats) {
      const o = s.occupant;
      if (o?.kind === 'human') {
        o.ready = false;
        if (leftSeats.has(s)) {
          s.occupant = null;
          s.characterId = null;
          this.deps.onMemberRemoved(o.tokenHash);
        }
      }
    }
    if (this.hostToken && !this.humanOf(this.hostToken)) this.migrateHost(this.hostToken);
    this.setLifeTimer(null);
    this.refreshLobbyTimer();
    this.broadcastState();
    return ok(undefined);
  }

  // ───────────────────────── 暂停 ─────────────────────────

  private pauseGame(reason: 'host' | 'all_away'): void {
    if (this.phase !== 'playing' || !this.runner) return;
    this.phase = 'paused';
    this.pausedInfo = { reason, since: this.deps.clock.now() };
    this.runner.pause();
    this.systemMsg('gamePaused', { reason });
    this.setLifeTimerForPhase();
    this.broadcastState();
  }

  private resumeGame(): void {
    if (this.phase !== 'paused' || !this.runner) return;
    this.phase = 'playing';
    this.pausedInfo = null;
    this.setLifeTimerForPhase();
    this.runner.resume();
    this.systemMsg('gameResumed');
    this.broadcastState();
  }

  /**
   * 对局中的回收计时与暂停原因无关（net.md §3.1）：没有在线的座位真人就开始 abandon 倒计时（房主暂停、AI 卡住暂停、
   * pauseWhenAllAway=false 仍在由 AI 代打，都一样），有真人上线就取消。
   */
  private setLifeTimerForPhase(): void {
    if (!this.inGame) return;
    if (this.onlineSeatHumans() === 0) {
      if (!this.lifeTimer) this.setLifeTimer(this.deps.ttl.abandonMs);
    } else {
      this.setLifeTimer(null);
    }
  }

  private onlineSeatHumans(): number {
    let n = 0;
    for (const s of this.seats) if (s.occupant?.kind === 'human' && s.occupant.socketId !== null) n++;
    return n;
  }

  /** 全员（座位上的真人）离线时暂停（pauseWhenAllAway） */
  private checkAllAway(): void {
    if (this.phase !== 'playing' || !this.settings.pauseWhenAllAway) return;
    const humans = this.seats.filter((s) => s.occupant?.kind === 'human');
    if (humans.length === 0) return;
    if (humans.every((s) => (s.occupant as HumanOcc).socketId === null)) this.pauseGame('all_away');
  }

  // ───────────────────────── 对局操作 ─────────────────────────

  private playerSeat(tokenHash: string): Result<SeatIndex> {
    const role = this.roleOf(tokenHash);
    if (!role) return fail('NOT_IN_ROOM');
    if (role.kind !== 'seat') return fail('NOT_A_PLAYER');
    return ok(role.seat);
  }

  private liveRunner(): Result<GameRunner> {
    if (!this.runner || this.phase === 'lobby') return fail('BAD_REQUEST', { reason: 'noGame' });
    if (this.phase === 'ended') return fail('GAME_OVER');
    if (this.phase === 'paused') return fail('GAME_PAUSED');
    return ok(this.runner);
  }

  act(tokenHash: string, decisionId: string, intent: PlayerIntent, clientActionId: string): Result<{ seq: number }> {
    const seat = this.playerSeat(tokenHash);
    if (!seat.ok) return seat;
    const r = this.liveRunner();
    if (!r.ok) return r;
    return r.data.submitPlayer(seat.data, decisionId, intent, clientActionId);
  }

  /** game:autopilot：settings 经 SYS_SET_AI_TRAITS 写入 state（随存档保存），再切换托管 */
  autopilot(tokenHash: string, on: boolean, settings: TrusteeSettings | undefined): Result<void> {
    const seat = this.playerSeat(tokenHash);
    if (!seat.ok) return seat;
    if (!this.runner || !this.inGame) return fail(this.phase === 'ended' ? 'GAME_OVER' : 'BAD_REQUEST');
    if (settings) {
      if (!isValidTrusteeSettings(settings)) return fail('BAD_REQUEST', { reason: 'trusteeSettings' });
      const p = this.runner.state.players.find((x) => x.seat === seat.data);
      if (!p) return fail('NOT_A_PLAYER');
      const traits = applyTrusteeSettings(p.aiTraits, settings);
      const r = this.runner.submitSystem({ type: 'SYS_SET_AI_TRAITS', seat: seat.data, traits });
      if (!r.ok) return r;
    }
    return this.runner.setAutopilot(seat.data, on);
  }

  pause(tokenHash: string, paused: boolean): Result<void> {
    if (!this.roleOf(tokenHash)) return fail('NOT_IN_ROOM');
    if (!this.isHost(tokenHash)) return fail('NOT_HOST');
    if (!this.runner || !this.inGame) return fail(this.phase === 'ended' ? 'GAME_OVER' : 'BAD_REQUEST');
    if (paused) this.pauseGame('host');
    else this.resumeGame();
    return ok(undefined);
  }

  resync(tokenHash: string, socketId: string): Result<void> {
    const role = this.roleOf(tokenHash);
    if (!role) return fail('NOT_IN_ROOM');
    if (!this.runner || this.phase === 'lobby') return fail('BAD_REQUEST', { reason: 'noGame' });
    const viewer: Viewer = role.kind === 'seat' ? { kind: 'seat', seat: role.seat } : { kind: 'spectator' };
    this.deps.out.toSocket(socketId, 'game:snapshot', this.runner.snapshotMsg(viewer));
    return ok(undefined);
  }

  debug(tokenHash: string, op: DebugOp): Result<{ seq: number }> {
    if (!this.roleOf(tokenHash)) return fail('NOT_IN_ROOM');
    if (!this.runner || !this.inGame) return fail('BAD_REQUEST', { reason: 'noGame' });
    return this.runner.submitSystem({ type: 'SYS_DEBUG', op });
  }

  // ───────────────────────── 聊天 ─────────────────────────

  chatSend(tokenHash: string, raw: string): Result<void> {
    const role = this.roleOf(tokenHash);
    if (!role) return fail('NOT_IN_ROOM');
    const text = sanitizeChatText(raw);
    if (text.length === 0) return fail('BAD_REQUEST', { reason: 'emptyText' });
    let from: ChatSender;
    let audience: ChatMessage['audience'] = 'all';
    if (role.kind === 'seat') {
      from = { kind: 'seat', seat: role.seat, nickname: this.human(role.seat)!.nickname };
    } else {
      const sp = this.spectators.get(role.id)!;
      if (this.settings.spectatorChat === 'off') return fail('CHAT_DISABLED');
      if (this.settings.spectatorChat === 'spectators') audience = 'spectators';
      from = { kind: 'spectator', id: sp.id, nickname: sp.nickname };
    }
    this.deps.out.chat(this, this.chat.text(from, text, audience));
    return ok(undefined);
  }

  emote(tokenHash: string, emoteId: string, targetSeat: SeatIndex | undefined): Result<void> {
    const role = this.roleOf(tokenHash);
    if (!role) return fail('NOT_IN_ROOM');
    const from: ChatSender =
      role.kind === 'seat'
        ? { kind: 'seat', seat: role.seat, nickname: this.human(role.seat)!.nickname }
        : { kind: 'spectator', id: role.id, nickname: this.spectators.get(role.id)!.nickname };
    if (role.kind === 'spectator' && this.settings.spectatorChat === 'off') return fail('CHAT_DISABLED');
    const msg = {
      id: this.deps.newId(),
      ts: this.deps.clock.now(),
      from,
      emoteId,
      ...(targetSeat !== undefined ? { targetSeat } : {}),
    };
    this.deps.out.emote(this, msg);
    return ok(undefined);
  }

  // ───────────────────────── 关闭 ─────────────────────────

  close(reason: RoomClosedReason): void {
    if (this.phase === 'closed') return;
    const members = this.connectedMembers();
    this.phase = 'closed';
    this.setLifeTimer(null);
    this.hostTimer?.cancel();
    this.runner?.dispose();
    for (const sp of this.spectators.values()) sp.idleTimer?.cancel();
    this.deps.out.closed(
      members.map((m) => m.socketId),
      reason,
    );
    const tokens = new Set<string>();
    for (const s of this.seats) if (s.occupant?.kind === 'human') tokens.add(s.occupant.tokenHash);
    for (const sp of this.spectators.values()) tokens.add(sp.tokenHash);
    for (const t of tokens) this.deps.onMemberRemoved(t);
    this.deps.onClosed(this, reason);
  }
}

/** 合并房间设置补丁（已通过 zod 校验）；地图必须存在 */
export function applySettingsPatch(
  cur: RoomSettings,
  patch: RoomSettingsPatch,
  maps: Pick<MapCatalog, 'has'>,
): Result<RoomSettings> {
  const { game: gamePatch, ...rest } = patch;
  const next: RoomSettings = { ...cur, ...stripUndefined(rest), game: { ...cur.game, rules: { ...cur.game.rules } } };
  if (gamePatch) {
    const { rules, ...g } = gamePatch;
    if (g.mapId !== undefined && !maps.has(g.mapId)) return fail('MAP_UNAVAILABLE', { mapId: g.mapId });
    next.game = {
      ...next.game,
      ...stripUndefined(g),
      rules: mergeRules(next.game.rules, rules ? stripUndefined(rules) : undefined),
    };
  }
  if (next.maxSpectators < 0) next.maxSpectators = 0;
  return ok(next);
}

function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
