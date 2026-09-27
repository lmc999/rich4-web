/**
 * 房间：大厅状态机、座位、观战者、房主、聊天；对局中持有 GameRunner（design/net.md §3、§5、§9）。
 *
 * - 所有方法同步执行并返回 Result；身份一律用 tokenHash（服务端只见 sha256(token)）。
 * - 发送经 RoomBroadcaster（按观察者投影与分组），Room 本身不接触 Socket.IO，可以直接单测。
 * - 房主必须是座位上的真人；没有座位真人时房主为空，第一个坐下的真人接任。
 * - 持久化（design/net.md §8.4–§8.5）：每个 action 经 persist.action 追加 journal；phase 变化、暂停、每 25 seq
 *   立即写快照，其余变化（大厅、聊天、进出）防抖写快照；房间关闭时删除。停机经 suspend 刷快照后释放，重启经
 *   Room.restore 恢复（epoch+1、全员视为断线并暂停）。
 * - 存档读档：game:save（房主）、DAY_END 自动存档覆盖 auto:<code>、room:loadSave（大厅锁定为存档座位，
 *   tokenHash 匹配的成员自动入座）、room:claimSeat；解散或无人回收前自动存档。
 * - 对局中座位上的真人全部 room:leave 后：自动存档并关闭房间（之后存档不再算「进行中」，可导出、可另开房间读档）；
 *   有人只是断线时仍暂停等人回来（abandon TTL 回收）。
 */
import { applyTrusteeSettings, isValidTrusteeSettings, type TrusteeSettings } from '@rich4/shared/ai';
import {
  CHARACTER_IDS,
  type CharacterId,
  type DebugOp,
  type EngineApi,
  type GameConfig,
  type GameState,
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
  DEFAULT_PACING,
  EMOTE_COOLDOWN_MS,
  fail,
  IN_GAME_MUTABLE_SETTINGS,
  isEmoteId,
  ok,
  type PublicRoomSummary,
  RECONNECT_GRACE_MAX_S,
  RECONNECT_GRACE_MIN_S,
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
  sanitizeSaveName,
} from '@rich4/shared/net';
import type { SaveSeat } from '@rich4/shared/save';
import { isAutopilot, type SeatControl, type Viewer } from '@rich4/shared/view';
import type { MapCatalog } from '../data/DataRegistry';
import type { AiDriver } from '../game/AiDriver';
import type { TimingOptions } from '../game/Deadlines';
import { GameRunner, type RunnerSettings, type SeatInit } from '../game/GameRunner';
import { type Clock, dateNumOf, type Scheduler, type TimerHandle } from '../infra/clock';
import type { Logger } from '../infra/logger';
import { NO_PERSISTENCE, type PersistableRoom, type RoomPersistence } from '../persistence/RoomPersister';
import { buildSaveFile, type LoadedSave, saveSeatsOf } from '../persistence/SaveService';
import type { PersistedSeat, RoomMetaV1, RoomSnapshotRecord, SaveKind, ServerSaveFile } from '../persistence/types';
import { ChatLog } from './ChatLog';
import { type ChatFilter, identityFilter } from './chatFilter';
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
  /** journal 与快照；缺省为空实现（单测） */
  persist?: RoomPersistence;
  /** 存档服务；缺省时 game:save / room:loadSave 返回 INTERNAL{persistenceUnavailable} */
  saves?: RoomSaves;
  /** 聊天敏感词过滤（DATA_DIR/badwords.txt） */
  chatFilter?: ChatFilter;
}

/** Room 需要的存档能力（SaveService 实现） */
export interface RoomSaves {
  store(
    file: ServerSaveFile,
    o: { kind: SaveKind; roomCode: string; owners: readonly string[]; verified?: boolean },
  ): Result<{ saveId: string }>;
  /** tokenHash=null 时不校验归属 */
  open(tokenHash: string | null, saveId: string): Result<LoadedSave>;
  addOwners(saveId: string, owners: readonly string[]): void;
}

/** 重启恢复时交给 Room.restore 的对局部分（快照 state + journal 重放之后） */
export interface RestoredGame {
  state: GameState;
  seq: number;
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

export class Room implements PersistableRoom {
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
  /** 大厅里已读取、尚未开局的存档（座位锁定为存档配置） */
  loaded: LoadedSave | null = null;
  /** 本局由哪个存档读档而来（该存档在对局进行中不可导出） */
  sourceSaveId: string | null = null;
  /**
   * 本局的来源是否可信：新开的对局为 true；由存档读档而来时取该存档的 verified。
   * 为 false 时本局产出的手动 / 自动存档一律不签名（net.md §6.2、§8.3「非官方存档」不能靠读档再存一次洗掉）
   */
  sourceVerified = true;
  private lifeTimer: TimerHandle | null = null;
  private hostTimer: TimerHandle | null = null;
  /** tokenHash → 上次发表情的时间（冷却 EMOTE_COOLDOWN_MS） */
  private readonly lastEmote = new Map<string, number>();

  constructor(
    readonly code: string,
    private readonly deps: RoomDeps,
    settings: RoomSettings,
    host: Identity | null,
    createdAt?: number,
  ) {
    this.createdAt = createdAt ?? deps.clock.now();
    this.settings = withSettingsDefaults(settings);
    this.chat = new ChatLog(() => deps.clock.now());
    this.hostToken = null;
    if (host) {
      this.seats[0]!.occupant = {
        kind: 'human',
        tokenHash: host.tokenHash,
        nickname: host.nickname,
        socketId: host.socketId,
        ready: false,
      };
      this.hostToken = host.tokenHash;
    }
  }

  private get persist(): RoomPersistence {
    return this.deps.persist ?? NO_PERSISTENCE;
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
      const view: SeatView = {
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
      const ss = this.savedSeat(s.index);
      if (ss) {
        view.savedSeat = {
          nickname: ss.nickname,
          characterId: ss.characterId,
          wasHuman: ss.kind === 'human',
          claimableByYou: this.canClaim(tokenHash, s.index),
        };
      }
      return view;
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
    if (this.loaded) {
      const m = this.loaded.file.meta;
      view.loadedSave = {
        saveId: this.loaded.saveId,
        name: this.loaded.name,
        gameDay: m.gameDay,
        date: m.date,
        verified: this.loaded.verified,
        ...(this.loaded.warnings.length > 0 ? { warnings: [...this.loaded.warnings] } : {}),
      };
    }
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

  /** 房间任何变化都广播全量 room:state，并安排一次防抖快照 */
  private broadcastState(): void {
    if (this.phase === 'closed') return;
    this.deps.out.roomState(this);
    this.persist.touch(this);
  }

  private systemMsg(key: SystemMsgKey, params: Record<string, string | number> = {}): void {
    this.deps.out.chat(this, this.chat.system(key, params));
    if (this.phase !== 'closed') this.persist.touch(this);
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
      if (this.loaded) return this.loadedJoinSeat(tokenHash) === null ? fail('ROOM_FULL') : ok(undefined);
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
      let slot: SeatSlot | undefined;
      if (this.loaded) {
        // 读档后：tokenHash 匹配的座位直接入座（占座者让到观战），否则先到先得未认领的真人座位
        const idx = this.loadedJoinSeat(who.tokenHash);
        slot = idx === null ? undefined : this.seats[idx];
        if (slot) this.vacateForOwner(slot);
      } else {
        slot = this.seats.find((s) => s.occupant === null);
      }
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
      this.startSpectatorIdle(sp);
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
    let leftInGame = false;
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
      leftInGame = true;
    } else {
      const h = this.human(role.seat)!;
      this.releaseSeat(this.seats[role.seat]!);
      this.systemMsg('playerLeft', { nickname: h.nickname, seat: role.seat });
      if (this.isHost(tokenHash)) this.migrateHost(tokenHash);
    }
    this.deps.onMemberRemoved(tokenHash);
    // 对局中座位上的真人全部 room:leave 了（没有在线的，也没有只是断线、可能回来的）：自动存档后关闭房间
    // （close('idle') 先写 auto:<code>）。房间一关，存档不再「正被进行中的对局使用」，所有 owner 都能立即导出或
    // 另开房间读档（手动存档与自动存档都行），不必等 abandon TTL（30 分钟）。有人只是断线时仍按原规则暂停等人回来。
    if (leftInGame && this.allSeatHumansLeft()) {
      this.close('idle');
      return ok(undefined);
    }
    this.refreshLobbyTimer();
    this.broadcastState();
    // 对局中座位归属变化立即落盘（同 kick），不等防抖
    if (leftInGame) this.persist.snapshot(this);
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
    // 读档后对局配置由存档决定
    if (this.loaded && patch.game !== undefined) return fail('BAD_REQUEST', { reason: 'saveLoaded' });
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
    if (this.loaded) return this.claimSeat(tokenHash, seat);
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
    this.releaseSeat(this.seats[role.seat]!);
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
    if (this.loaded) return fail('BAD_REQUEST', { reason: 'saveLoaded' });
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
    const ss = this.savedSeat(seat);
    if (this.loaded && !ss) return fail('BAD_REQUEST', { reason: 'notInSave' });
    if (ai === null) {
      this.releaseSeat(slot);
    } else if (ss?.kind === 'ai') {
      // 存档里本来就是电脑的座位：配置沿用存档（读档开局用存档 state 里的 aiTraits，大厅改预设不会生效，
      // 前端也只读显示原预设）；移除后再补上仍是原配置
      slot.occupant = {
        kind: 'ai',
        ai: ss.ai
          ? { ...ss.ai, ...(ss.ai.overrides ? { overrides: { ...ss.ai.overrides } } : {}) }
          : { preset: 'character' },
        name: ss.nickname || `AI${seat + 1}`,
      };
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
      this.releaseSeat(slot);
      this.broadcastState();
      return ok(undefined);
    }
    if (o.tokenHash === tokenHash) return fail('BAD_REQUEST', { reason: 'kickSelf' });
    const inGame = this.inGame && this.runner !== null;
    if (inGame) {
      slot.occupant = { kind: 'ai', ai: { preset: 'character' }, name: o.nickname };
      this.runner!.kick(target.seat);
    } else {
      this.releaseSeat(slot);
    }
    if (o.socketId) this.deps.out.toSocket(o.socketId, 'room:closed', { reason: 'kicked' });
    this.deps.onMemberRemoved(o.tokenHash);
    this.systemMsg('kicked', { nickname: o.nickname, seat: target.seat });
    this.checkAllAway();
    this.setLifeTimerForPhase();
    this.refreshLobbyTimer();
    this.broadcastState();
    // 对局中踢人已把 SYS_SET_CONTROLLER{ai} 写进 journal：座位归属必须同时落盘（不等 2 秒防抖），
    // 否则此时崩溃，重启后座位仍是被踢者（runner 与引擎 controller 不一致，被踢者还能 room:resume 拿回）
    if (inGame) this.persist.snapshot(this);
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
    if (this.loaded) return this.startLoaded(this.loaded);
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
    const r = this.launch(
      state,
      players.map((p) => this.seatInit(p.seat, p.controller === 'ai' ? 'ai' : 'human')),
    );
    if (!r.ok) return r;
    this.sourceSaveId = null;
    this.sourceVerified = true;
    this.greetGame();
    return ok(undefined);
  }

  private seatInit(seat: SeatIndex, control: SeatControl): SeatInit {
    const h = this.human(seat);
    return { seat, control, connected: h ? h.socketId !== null : true };
  }

  /** 开局或读档开局：epoch+1，建 runner 并开始计时；失败时回滚 epoch */
  private launch(state: GameState, seats: SeatInit[]): Result<void> {
    this.epoch++;
    const runner = this.makeRunner(state, seats);
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
    return ok(undefined);
  }

  /** 开局后：广播房间状态、写快照（phase 变化）、给每人发快照、处理全员离线 */
  private greetGame(): void {
    const runner = this.runner!;
    this.broadcastState();
    this.persist.snapshot(this);
    for (const m of this.connectedMembers()) {
      this.deps.out.toSocket(m.socketId, 'game:snapshot', runner.snapshotMsg(m.viewer));
    }
    this.checkAllAway();
    this.setLifeTimerForPhase();
  }

  private makeRunner(state: GameState, seats: SeatInit[], extra: { seq?: number; paused?: boolean } = {}): GameRunner {
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
          applied: (entry) => this.persist.action(this, entry),
          dayEnd: () => this.autoSave(),
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
      { epoch: this.epoch, state, seats, ...extra },
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
      pacing: s.pacing,
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
    this.persist.snapshot(this);
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
    this.sourceSaveId = null;
    this.sourceVerified = true;
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
    this.persist.snapshot(this);
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
    this.persist.snapshot(this);
  }

  private resumeGame(): void {
    if (this.phase !== 'paused' || !this.runner) return;
    this.phase = 'playing';
    this.pausedInfo = null;
    this.setLifeTimerForPhase();
    this.runner.resume();
    this.systemMsg('gameResumed');
    this.broadcastState();
    this.persist.snapshot(this);
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

  /** 座位上的真人都已在对局中 room:leave（离线且座位为 autopilot:left）；只是断线的不算 */
  private allSeatHumansLeft(): boolean {
    const humans = this.seats.filter((s) => s.occupant?.kind === 'human');
    return (
      humans.length > 0 &&
      humans.every(
        (s) => (s.occupant as HumanOcc).socketId === null && this.runner?.controlOf(s.index) === 'autopilot:left',
      )
    );
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
    const text = (this.deps.chatFilter ?? identityFilter)(sanitizeChatText(raw));
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
    this.persist.touch(this);
    return ok(undefined);
  }

  /**
   * 表情（design/net.md §9）：emoteId 必须在 EMOTES 表里；每人冷却 EMOTE_COOLDOWN_MS（另有 guard 的令牌桶）；
   * targetSeat 必须有人；观战者受 spectatorChat 约束（off 拒绝，spectators 只发给观战者）。
   */
  emote(tokenHash: string, emoteId: string, targetSeat: SeatIndex | undefined): Result<void> {
    const role = this.roleOf(tokenHash);
    if (!role) return fail('NOT_IN_ROOM');
    if (!isEmoteId(emoteId)) return fail('BAD_REQUEST', { reason: 'unknownEmote' });
    if (targetSeat !== undefined && this.seats[targetSeat]!.occupant === null) {
      return fail('BAD_REQUEST', { reason: 'emptySeat' });
    }
    const from: ChatSender =
      role.kind === 'seat'
        ? { kind: 'seat', seat: role.seat, nickname: this.human(role.seat)!.nickname }
        : { kind: 'spectator', id: role.id, nickname: this.spectators.get(role.id)!.nickname };
    if (role.kind === 'spectator' && this.settings.spectatorChat === 'off') return fail('CHAT_DISABLED');
    const now = this.deps.clock.now();
    const last = this.lastEmote.get(tokenHash);
    if (last !== undefined && now - last < EMOTE_COOLDOWN_MS) {
      return fail('RATE_LIMITED', { retryInMs: EMOTE_COOLDOWN_MS - (now - last) });
    }
    this.lastEmote.set(tokenHash, now);
    const audience = role.kind === 'spectator' && this.settings.spectatorChat === 'spectators' ? 'spectators' : 'all';
    const msg = {
      id: this.deps.newId(),
      ts: this.deps.clock.now(),
      from,
      emoteId: emoteId as string,
      ...(targetSeat !== undefined ? { targetSeat } : {}),
    };
    this.deps.out.emote(this, msg, audience);
    return ok(undefined);
  }

  // ───────────────────────── 存档 ─────────────────────────

  /** 座位上的真人（存档 owner） */
  humanTokens(): string[] {
    const out: string[] = [];
    for (const s of this.seats) if (s.occupant?.kind === 'human') out.push(s.occupant.tokenHash);
    return out;
  }

  private toSaveFile(name: string): ServerSaveFile {
    const runner = this.runner!;
    return buildSaveFile({
      name,
      savedAt: this.deps.clock.now(),
      engine: this.deps.engine!,
      settings: this.settings,
      seats: saveSeatsOf(runner.state, (seat) => this.seats[seat]!.occupant),
      state: runner.state,
      // 只写所有人可见的消息：观战者专属聊天（audience 'spectators'）不能落进玩家可导出的存档
      chat: this.chat.historyFor(false),
    });
  }

  /** game:save（房主）：写手动存档，所有真人参与者都是 owner */
  saveGame(tokenHash: string, rawName: string): Result<{ saveId: string }> {
    if (!this.roleOf(tokenHash)) return fail('NOT_IN_ROOM');
    if (!this.isHost(tokenHash)) return fail('NOT_HOST');
    if (!this.runner || !this.inGame)
      return fail(this.phase === 'ended' ? 'GAME_OVER' : 'BAD_REQUEST', { reason: 'noGame' });
    const saves = this.deps.saves;
    if (!saves) return fail('INTERNAL', { reason: 'persistenceUnavailable' });
    const d = this.runner.state.clock.date;
    const pad = (n: number) => String(n).padStart(2, '0');
    const name =
      sanitizeSaveName(rawName) || `存档 ${Math.trunc(d / 10000)}-${pad(Math.trunc(d / 100) % 100)}-${pad(d % 100)}`;
    const r = saves.store(this.toSaveFile(name), {
      kind: 'manual',
      roomCode: this.code,
      owners: this.humanTokens(),
      verified: this.sourceVerified,
    });
    if (r.ok) this.systemMsg('gameSaved', { name });
    return r;
  }

  /** 自动存档：覆盖 auto:<code>（DAY_END、对局中解散或无人回收、停机）；已结束或没有真人时跳过 */
  autoSave(): void {
    const saves = this.deps.saves;
    if (!saves || !this.runner || !this.inGame || this.runner.over) return;
    const owners = this.humanTokens();
    if (owners.length === 0) return;
    const r = saves.store(this.toSaveFile('自动存档'), {
      kind: 'auto',
      roomCode: this.code,
      owners,
      verified: this.sourceVerified,
    });
    if (!r.ok) this.deps.log.warn({ code: this.code, error: r.error }, 'auto save failed');
  }

  // ───────────────────────── 读档 ─────────────────────────

  /** 读档后该座位在存档里的配置（未读档或座位不在存档里时 undefined） */
  savedSeat(seat: SeatIndex): SaveSeat | undefined {
    return this.loaded?.file.seats.find((x) => x.index === seat);
  }

  /** 读档后空出的座位：角色仍锁定为存档角色 */
  private releaseSeat(slot: SeatSlot): void {
    slot.occupant = null;
    slot.characterId = this.savedSeat(slot.index)?.characterId ?? null;
  }

  private canClaim(tokenHash: string, seat: SeatIndex): boolean {
    const ss = this.savedSeat(seat);
    if (!ss || this.phase !== 'lobby') return false;
    const o = this.seats[seat]!.occupant;
    if (o?.kind === 'human' && o.tokenHash === tokenHash) return false;
    return ss.ownerTokenHash === tokenHash || o === null;
  }

  /** 读档后以 player 身份加入：自己的存档座位，否则第一个未认领的真人座位 */
  private loadedJoinSeat(tokenHash: string): SeatIndex | null {
    const seats = this.loaded?.file.seats ?? [];
    const own = seats.find((x) => x.kind === 'human' && x.ownerTokenHash === tokenHash);
    if (own) return own.index;
    const free = seats.find((x) => x.kind === 'human' && this.seats[x.index]!.occupant === null);
    return free ? free.index : null;
  }

  /** 把座位腾给存档 owner：电脑直接撤掉，占座的真人让到观战（不受观战人数限制） */
  private vacateForOwner(slot: SeatSlot): void {
    const o = slot.occupant;
    slot.occupant = null;
    if (o?.kind === 'human') this.addSpectator({ tokenHash: o.tokenHash, nickname: o.nickname, socketId: o.socketId });
  }

  private addSpectator(who: { tokenHash: string; nickname: string; socketId: string | null }): Spectator {
    const id = this.deps.newId();
    const sp: Spectator = {
      id,
      tokenHash: who.tokenHash,
      nickname: who.nickname,
      socketId: who.socketId,
      idleTimer: null,
    };
    this.spectators.set(id, sp);
    if (sp.socketId === null) this.startSpectatorIdle(sp);
    return sp;
  }

  private startSpectatorIdle(sp: Spectator): void {
    sp.idleTimer?.cancel();
    sp.idleTimer = this.deps.scheduler.after(this.deps.ttl.spectatorIdleMs, () => {
      if (sp.socketId === null && this.spectators.get(sp.id) === sp) {
        this.spectators.delete(sp.id);
        this.deps.onMemberRemoved(sp.tokenHash);
        this.broadcastState();
      }
    });
  }

  /**
   * room:loadSave（房主，大厅）：读取并校验存档，座位锁定为存档配置（design/net.md §8.4）。
   * 当前成员（座位上的与观战的）tokenHash 匹配 ownerTokenHash 的自动入座；存档里的电脑座位按原配置补上；
   * 其余座位上的真人依次坐进未认领的真人座位，坐不下的让到观战。
   */
  loadSave(tokenHash: string, saveId: string): Result<void> {
    if (!this.roleOf(tokenHash)) return fail('NOT_IN_ROOM');
    if (!this.isHost(tokenHash)) return fail('NOT_HOST');
    if (this.phase !== 'lobby') return fail('ROOM_IN_GAME');
    const saves = this.deps.saves;
    if (!saves) return fail('INTERNAL', { reason: 'persistenceUnavailable' });
    const r = saves.open(tokenHash, saveId);
    if (!r.ok) return r;
    this.applyLoadedSave(r.data);
    this.systemMsg('gameLoaded', {
      name: r.data.name,
      verified: r.data.verified ? 1 : 0,
      tablesMismatch: r.data.warnings.includes('tablesHashMismatch') ? 1 : 0,
    });
    this.broadcastState();
    return ok(undefined);
  }

  private applyLoadedSave(ls: LoadedSave): void {
    const file = ls.file;
    this.loaded = ls;
    const rs = withSettingsDefaults(file.roomSettings);
    this.settings = { ...rs, game: { ...rs.game, rules: { ...rs.game.rules } } };
    // 存档里的设置按完整 schema 校验（允许测试用的 0..600 小数秒）；客户端补丁只允许 5..120 整数秒，
    // 读档不能绕过这个限制（测试模式除外）
    if (!this.deps.testMode) this.settings.reconnectGraceSec = clampGraceSec(rs.reconnectGraceSec);
    // 座位上的真人（房主优先），用于重新安排
    const seated: HumanOcc[] = [];
    const host = this.hostToken ? this.humanOf(this.hostToken) : null;
    if (host) seated.push(host);
    for (const s of this.seats) if (s.occupant?.kind === 'human' && s.occupant !== host) seated.push(s.occupant);
    for (const s of this.seats) {
      s.occupant = null;
      s.characterId = this.savedSeat(s.index)?.characterId ?? null;
    }
    for (const ss of file.seats) {
      if (ss.kind === 'ai') {
        this.seats[ss.index]!.occupant = {
          kind: 'ai',
          ai: ss.ai ? { ...ss.ai } : { preset: 'character' },
          name: ss.nickname || `AI${ss.index + 1}`,
        };
      }
    }
    const place = (h: { tokenHash: string; nickname: string; socketId: string | null }): boolean => {
      const ss = file.seats.find((x) => x.kind === 'human' && x.ownerTokenHash === h.tokenHash);
      if (!ss || this.seats[ss.index]!.occupant !== null) return false;
      this.seats[ss.index]!.occupant = {
        kind: 'human',
        tokenHash: h.tokenHash,
        nickname: h.nickname,
        socketId: h.socketId,
        ready: false,
      };
      return true;
    };
    const unplaced = seated.filter((h) => !place(h));
    for (const sp of [...this.spectators.values()]) {
      if (place(sp)) {
        sp.idleTimer?.cancel();
        this.spectators.delete(sp.id);
      }
    }
    for (const h of unplaced) {
      const free = file.seats.find((x) => x.kind === 'human' && this.seats[x.index]!.occupant === null);
      if (free) this.seats[free.index]!.occupant = { ...h, ready: false };
      else this.addSpectator({ tokenHash: h.tokenHash, nickname: h.nickname, socketId: h.socketId });
    }
    if (this.hostToken && !this.humanOf(this.hostToken)) this.migrateHost(this.hostToken);
    this.refreshLobbyTimer();
  }

  /**
   * room:claimSeat：认领读档后的座位。ownerTokenHash 匹配则直接入座（电脑撤掉、占座者让到观战）；
   * 否则只有该座位无人时才可认领（先到先得，房主可以踢人）。
   */
  claimSeat(tokenHash: string, seat: SeatIndex): Result<void> {
    const role = this.roleOf(tokenHash);
    if (!role) return fail('NOT_IN_ROOM');
    if (!this.loaded) return fail('BAD_REQUEST', { reason: 'noLoadedSave' });
    if (this.phase !== 'lobby') return fail('ROOM_IN_GAME');
    const ss = this.savedSeat(seat);
    if (!ss) return fail('BAD_REQUEST', { reason: 'notInSave' });
    if (role.kind === 'seat' && role.seat === seat) return ok(undefined);
    const slot = this.seats[seat]!;
    const isOwner = ss.ownerTokenHash === tokenHash;
    if (slot.occupant !== null && !isOwner) return fail('SEAT_TAKEN');
    let who: { tokenHash: string; nickname: string; socketId: string | null };
    if (role.kind === 'seat') {
      const from = this.seats[role.seat]!;
      const h = from.occupant as HumanOcc;
      who = { tokenHash, nickname: h.nickname, socketId: h.socketId };
      this.releaseSeat(from);
    } else {
      const sp = this.spectators.get(role.id)!;
      sp.idleTimer?.cancel();
      this.spectators.delete(sp.id);
      who = { tokenHash, nickname: sp.nickname, socketId: sp.socketId };
    }
    this.vacateForOwner(slot);
    slot.occupant = { kind: 'human', ...who, ready: false };
    slot.characterId = ss.characterId;
    if (who.socketId !== null) this.claimOrphanedHost(tokenHash, who.nickname, seat);
    else if (this.hostToken === null) this.hostToken = tokenHash;
    this.broadcastState();
    return ok(undefined);
  }

  /** 读档开局：存档里的每个座位都要有人（真人认领或电脑），真人全部准备 */
  private startLoaded(ls: LoadedSave): Result<void> {
    const file = ls.file;
    const missing = file.seats.filter((x) => this.seats[x.index]!.occupant === null).map((x) => x.index);
    if (missing.length > 0) return fail('NOT_ENOUGH_PLAYERS', { reason: 'unclaimedSeats', seats: missing });
    if (
      this.seats.some(
        (s) => s.occupant?.kind === 'human' && !s.occupant.ready && s.occupant.tokenHash !== this.hostToken,
      )
    ) {
      return fail('NOT_ALL_READY');
    }
    if (!this.deps.maps.isPlayable(file.mapRef.id)) return fail('MAP_UNAVAILABLE', { mapId: file.mapRef.id });
    if (!this.deps.engine) return fail('INTERNAL', { reason: 'engineUnavailable' });
    // 未认领、由电脑补上的真人座位只在服务器层由 AI 代打（相当于永久托管），不改 state，读档后状态与存档完全一致
    const inits = file.seats.map((x) =>
      this.seatInit(x.index, this.seats[x.index]!.occupant!.kind === 'ai' ? 'ai' : 'human'),
    );
    const r = this.launch(file.game, inits);
    if (!r.ok) return r;
    this.loaded = null;
    this.sourceSaveId = ls.saveId;
    this.sourceVerified = ls.verified;
    this.deps.saves?.addOwners(ls.saveId, this.humanTokens());
    this.greetGame();
    // 存档里是电脑、现在由真人认领的座位：引擎 controller 改回 human（journal 里的 SYS_SET_CONTROLLER）
    for (const x of file.seats) {
      if (x.kind === 'ai' && this.seats[x.index]!.occupant?.kind === 'human') {
        const res = this.runner!.submitSystem({ type: 'SYS_SET_CONTROLLER', seat: x.index, controller: 'human' });
        if (!res.ok)
          this.deps.log.warn({ code: this.code, seat: x.index, error: res.error }, 'SYS_SET_CONTROLLER human failed');
      }
    }
    return ok(undefined);
  }

  // ───────────────────────── 持久化 ─────────────────────────

  private persistMeta(): RoomMetaV1 {
    const inGame = this.runner !== null && this.phase !== 'lobby';
    return {
      v: 1,
      createdAt: this.createdAt,
      settings: this.settings,
      hostToken: this.hostToken,
      seats: this.seats.map(
        (s): PersistedSeat => ({
          index: s.index,
          characterId: s.characterId,
          occupant:
            s.occupant === null
              ? null
              : s.occupant.kind === 'human'
                ? {
                    kind: 'human',
                    tokenHash: s.occupant.tokenHash,
                    nickname: s.occupant.nickname,
                    ready: s.occupant.ready,
                  }
                : { kind: 'ai', ai: s.occupant.ai, name: s.occupant.name },
          control: inGame ? (this.runner?.controlOf(s.index) ?? null) : null,
        }),
      ),
      spectators: [...this.spectators.values()].map((sp) => ({
        id: sp.id,
        tokenHash: sp.tokenHash,
        nickname: sp.nickname,
      })),
      chat: this.chat.all(),
      paused: this.pausedInfo ? { ...this.pausedInfo } : null,
      loadedSaveId: this.loaded?.saveId ?? null,
      sourceSaveId: this.sourceSaveId,
      sourceVerified: this.sourceVerified,
    };
  }

  /** 当前快照（RoomPersister 调用） */
  snapshotRecord(): RoomSnapshotRecord {
    const e = this.deps.engine;
    const inGame = this.runner !== null && this.phase !== 'lobby';
    return {
      code: this.code,
      epoch: this.epoch,
      seq: inGame ? this.runner!.seq : 0,
      phase: this.phase === 'closed' ? 'ended' : this.phase,
      engineVersion: e?.ENGINE_VERSION ?? 'unknown',
      stateVersion: e?.STATE_SCHEMA_VERSION ?? 0,
      meta: this.persistMeta(),
      state: inGame ? this.runner!.state : null,
      updatedAt: this.deps.clock.now(),
    };
  }

  /**
   * 重启恢复（design/net.md §8.5）：按快照元数据重建房间。对局中（含已结束）的房间 epoch+1，所有真人视为断线；
   * 进行中的对局以暂停状态恢复（原先是房主暂停的保持 host，其余为 all_away，第一个真人回来时自动继续）。
   * game 为快照 state + journal 尾部重放的结果；大厅阶段传 null，loaded 为大厅里已读取的存档。
   */
  static restore(deps: RoomDeps, rec: RoomSnapshotRecord, game: RestoredGame | null, loaded: LoadedSave | null): Room {
    const m = rec.meta;
    const room = new Room(rec.code, deps, m.settings, null, m.createdAt);
    room.hostToken = m.hostToken;
    room.epoch = rec.epoch;
    room.sourceSaveId = m.sourceSaveId;
    room.sourceVerified = sourceVerifiedOf(m);
    for (const ps of m.seats) {
      const slot = room.seats[ps.index];
      if (!slot) continue;
      slot.characterId = ps.characterId;
      const o = ps.occupant;
      slot.occupant =
        o === null
          ? null
          : o.kind === 'human'
            ? { kind: 'human', tokenHash: o.tokenHash, nickname: o.nickname, socketId: null, ready: o.ready }
            : { kind: 'ai', ai: o.ai, name: o.name };
    }
    for (const sp of m.spectators) {
      const s: Spectator = {
        id: sp.id,
        tokenHash: sp.tokenHash,
        nickname: sp.nickname,
        socketId: null,
        idleTimer: null,
      };
      room.spectators.set(sp.id, s);
      room.startSpectatorIdle(s);
    }
    room.chat.restore(m.chat);
    if (game !== null && rec.phase !== 'lobby') {
      room.epoch = rec.epoch + 1;
      const ended = rec.phase === 'ended';
      const inits: SeatInit[] = game.state.players.map((p) => {
        const ps = m.seats.find((x) => x.index === p.seat);
        const occ = room.seats[p.seat]!.occupant;
        const control: SeatControl = ps?.control ?? (occ?.kind === 'human' ? 'human' : 'ai');
        return { seat: p.seat, control, connected: occ?.kind !== 'human' };
      });
      room.runner = room.makeRunner(game.state, inits, { seq: game.seq, paused: !ended });
      room.runner.begin();
      if (ended) {
        room.phase = 'ended';
        room.setLifeTimer(deps.ttl.endedMs);
      } else {
        room.phase = 'paused';
        room.pausedInfo = { reason: m.paused?.reason === 'host' ? 'host' : 'all_away', since: deps.clock.now() };
        room.setLifeTimerForPhase();
      }
      room.systemMsg('serverRestored');
    } else {
      room.phase = 'lobby';
      room.loaded = loaded;
      room.refreshLobbyTimer();
    }
    // 原房主有一个断线宽限期可以回来，之后才由第一个上线的真人接任
    if (room.hostToken && room.humanOf(room.hostToken)) room.startHostGrace();
    return room;
  }

  // ───────────────────────── 关闭 ─────────────────────────

  close(reason: RoomClosedReason): void {
    if (this.phase === 'closed') return;
    // 对局中解散、无人回收：先自动存档（design/net.md §3.1、§8.4）
    if (reason === 'dissolved' || reason === 'idle') this.autoSave();
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
    this.persist.closed(this);
    this.deps.onClosed(this, reason);
  }

  /**
   * 停机（design/net.md §8.5）：可选自动存档与刷快照，然后停止全部计时器。不删除持久化数据、不通知成员
   * （客户端收到 server:notice 后自动重连，重启后按快照 + journal 恢复）。
   */
  suspend(o: { flush: boolean; autosave: boolean }): void {
    if (this.phase === 'closed') return;
    if (o.autosave) this.autoSave();
    if (o.flush) this.persist.snapshot(this);
    this.setLifeTimer(null);
    this.hostTimer?.cancel();
    this.hostTimer = null;
    this.runner?.dispose();
    for (const sp of this.spectators.values()) {
      sp.idleTimer?.cancel();
      sp.idleTimer = null;
    }
    this.phase = 'closed';
  }
}

/** 读档后的断线宽限按客户端补丁的范围夹取（整数秒） */
export function clampGraceSec(v: number): number {
  const n = Math.round(v);
  return Math.min(
    RECONNECT_GRACE_MAX_S,
    Math.max(RECONNECT_GRACE_MIN_S, Number.isFinite(n) ? n : RECONNECT_GRACE_MIN_S),
  );
}

/** 快照元数据里的来源可信度；旧快照没有该字段时：新开的对局可信，读档来的按不可信处理 */
export function sourceVerifiedOf(m: Pick<RoomMetaV1, 'sourceSaveId' | 'sourceVerified'>): boolean {
  return m.sourceVerified ?? m.sourceSaveId === null;
}

/**
 * 补齐后来加入的房间设置项：演出节奏（original-skin.md U3）之前的房间快照与存档没有 pacing，按默认节奏补上
 * （存档经 RoomSettingsSchema 解析时已有默认值；房间快照的 meta 不经 schema，这里兜底）。
 */
export function withSettingsDefaults(s: RoomSettings): RoomSettings {
  const pacing = (s as Partial<RoomSettings>).pacing;
  return pacing === 'original' || pacing === 'compact' ? s : { ...s, pacing: DEFAULT_PACING };
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
