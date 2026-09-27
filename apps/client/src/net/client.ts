// 客户端服务核心（design/client.md §10，按 architecture §5.8、§6 修订）：
// 持有 Transport、时钟校准、动画时钟与 EventPlayer；把 S2C 推送分发到各 store；提供大厅、房间、对局、聊天的操作。
// 与 React、Pixi 无关：棋盘由 BoardCanvas 挂载后 attachBoard 注入，地图由 GameScreen 加载后 setMap 注入。

import type { MapIndex } from '@rich4/shared/data';
import type { CharacterId, DebugOp, LotId, PlayerIntent, SeatAiConfig, SeatIndex } from '@rich4/shared/engine';
import {
  type AppError,
  appError,
  type C2SAckData,
  type C2SEventName,
  type C2SPayload,
  PROTOCOL_VERSION,
  type Result,
  type RoomSettingsPatch,
  type S2CPayload,
  type SaveSummary,
} from '@rich4/shared/net';
import type { GameView } from '@rich4/shared/view';
import { AnimClock } from '../game/anim/AnimClock';
import { EventPlayer } from '../presentation/EventPlayer';
import { HANDLERS } from '../presentation/handlers';
import { formatEvent } from '../presentation/logFormat';
import { type LooseT, makeNames } from '../presentation/names';
import { systemText, TOAST_SYSTEM_KEYS } from '../presentation/systemText';
import {
  type BoardPort,
  type HandlerMap,
  NULL_AUDIO,
  NULL_BOARD,
  NULL_UI,
  type PresentationContext,
} from '../presentation/types';
import { createUiPresenter } from '../presentation/UiPresenter';
import { useChatStore } from '../store/chatStore';
import { useConnectionStore } from '../store/connectionStore';
import { useGameStore } from '../store/gameStore';
import { mySeat, useRoomStore } from '../store/roomStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { ClockSync } from './clock';
import {
  base64url,
  clearLastRoom,
  type KeyValueStorage,
  loadLastRoom,
  loadToken,
  safeStorage,
  saveLastRoom,
} from './identity';
import { attachRouter } from './router';
import type { Transport } from './transport';

export interface GameClientOptions {
  transport: Transport;
  /** i18n 的 t（动态键） */
  t: LooseT;
  handlers?: HandlerMap;
  storage?: KeyValueStorage;
  /** 开发模式：批尾对账告警、handler 超预算告警 */
  dev?: boolean;
  /** 批尾对账不一致（缺省走 warn；测试构建 ?test=1 时走 console.error，E2E 据此判失败） */
  error?(msg: string, detail?: unknown): void;
  /** ?anim=instant：只提交不播放 */
  instant?: boolean;
  /** 单个 handler 的真实时间上限（ms） */
  maxHandlerMs?: number;
  /** 驱动动画时钟（缺省 requestAnimationFrame；测试传 false 手动推进） */
  driveClock?: boolean;
  warn?(msg: string, detail?: unknown): void;
}

export type EnterRole = 'player' | 'spectator';

/** 托管设置（类型取自协议，前端不依赖 shared/ai） */
export type TrusteeSettings = NonNullable<C2SPayload<'game:autopilot'>['settings']>;

/** 动画时钟单次推进上限（ms）与 rAF 被节流时的兜底间隔 */
export const CLOCK_MAX_STEP_MS = 1000;
export const CLOCK_FALLBACK_MS = 200;

/**
 * 小游戏模块安装前到达的观战票据与帧。刷新或中途加入时，服务器在 game:snapshot 之后、room:state 之前只补发一次，
 * 早于对局页（lazy）挂载与 installMinigames；GameClient 先按到达顺序缓存，安装时由 takeMinigameBacklog 交出。
 */
export type MinigameBacklogItem =
  | { event: 'game:minigameWatch'; payload: S2CPayload<'game:minigameWatch'> }
  | { event: 'game:minigameFrames'; payload: S2CPayload<'game:minigameFrames'> };

/** 缓存上限（超出丢最早的；每会话帧数约 1 秒 5 批 × 20 秒） */
export const MINIGAME_BACKLOG_MAX = 1200;

/** 构建号缺省值（只用于服务器日志） */
export const CLIENT_VERSION_FALLBACK = 'dev';

function newActionId(): string {
  const b = new Uint8Array(9);
  globalThis.crypto.getRandomValues(b);
  return base64url(b);
}

export class GameClient {
  readonly transport: Transport;
  readonly clock: ClockSync;
  /** 演出用动画时钟（倍速、中止、instant）；棋盘渲染器共用它 */
  readonly anim = new AnimClock();
  readonly player: EventPlayer;
  private board: BoardPort = NULL_BOARD;
  private map: MapIndex | null = null;
  private roomCode: string | null = null;
  private entering: { code: string; p: Promise<Result<{ role: EnterRole; fellBack: boolean }>> } | null = null;
  private started = false;
  private readonly storage: KeyValueStorage;
  private readonly offs: (() => void)[] = [];
  private rafId: number | null = null;
  private lastFrame = 0;
  private readonly ui = createUiPresenter({ wait: (ms, s) => this.anim.wait(ms, s) });
  private readonly t: LooseT;
  /** 小游戏模块接管前的缓存；null = 已被 installMinigames 接管（之后由它直接监听） */
  private mgBacklog: MinigameBacklogItem[] | null = [];

  constructor(private readonly o: GameClientOptions) {
    this.transport = o.transport;
    this.t = o.t;
    this.storage = o.storage ?? safeStorage();
    this.clock = new ClockSync(
      async (t0) => {
        const r = await this.transport.request('time:ping', { t0 }, { timeoutMs: 5000 });
        return r.ok ? r.data : null;
      },
      undefined,
      undefined,
      // 只在连接已打开时采样：否则 t0 之后还要等握手，RTT 与偏移都会偏大
      () => this.transport.status === 'open',
    );
    this.player = new EventPlayer({
      handlers: o.handlers ?? HANDLERS,
      clock: this.anim,
      dev: o.dev ?? false,
      maxHandlerMs: o.maxHandlerMs ?? 20_000,
      warn: o.warn ?? ((m, d) => console.warn(m, d ?? '')),
      ...(o.error ? { error: o.error } : {}),
      baseSpeed: useSettingsStore.getState().speed,
      requestResync: () => {
        void this.transport.request('game:resync', {});
      },
      syncBoard: (view) => this.board.syncView(view),
      onAbort: () => {
        this.board.clearFx();
        this.ui.closeTransient();
      },
      context: (signal, view) => this.makeContext(signal, view),
      sink: {
        reset: (s) => {
          useGameStore.getState().resetTo(s);
          this.rememberRoom();
        },
        beginBatch: (_seq, next) => useGameStore.getState().beginBatch(next),
        commitView: (view, e, seq) => {
          useGameStore.getState().commitView(view);
          const line = formatEvent(
            e,
            this.names(() => view),
          );
          if (line) useGameStore.getState().pushLog([{ seq, type: e.type, text: line, date: view.clock.date }]);
        },
        commitBatch: (b) => {
          useGameStore.getState().commitBatch(b);
          this.rememberRoom();
        },
        commitPending: (pending, decision) => useGameStore.getState().commitPending(pending, decision),
        setAnim: (a) => useGameStore.getState().setAnim(a),
      },
    });
    if (o.instant) this.player.setInstant(true);
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  /** 注册路由与状态监听并开始连接（幂等） */
  start(): void {
    if (this.started) return;
    this.started = true;
    const conn = useConnectionStore.getState();
    this.offs.push(
      this.transport.onStatus((s, info) => conn.setStatus(s, info.attempt, info.error ?? null)),
      this.transport.onConnect(() => {
        // 连上后连续补采几次，尽快得到可信的中位数（首个样本在 15 秒内是唯一样本）
        void this.clock.burst(3);
        void this.onConnected();
      }),
      this.clock.onChange((offset, rtt) => useConnectionStore.getState().setClock(offset, rtt)),
      useSettingsStore.subscribe((s, prev) => {
        if (s.speed !== prev.speed) this.player.setSpeed(s.speed);
        if (s.nickname !== prev.nickname) this.onNicknameChanged();
      }),
      attachRouter(this.transport, {
        'room:state': (v) => {
          this.clock.coarse(v.serverNow);
          if (this.roomCode === null || this.roomCode === v.code) {
            this.roomCode = v.code;
            useRoomStore.getState().setRoom(v);
            this.rememberRoom();
          }
        },
        'room:closed': (p) => this.onRoomClosed(p.reason),
        'game:snapshot': (p) => {
          this.clock.coarse(p.serverNow);
          this.player.reset(p);
        },
        'game:batch': (p) => {
          this.clock.coarse(p.serverNow);
          useGameStore.getState().setLatest(p.view, p.seq);
          this.player.enqueue(p);
          this.rememberRoom();
        },
        'game:catchup': (p) => {
          this.clock.coarse(p.serverNow);
          useGameStore.getState().setLatest(p.view, p.seq);
          this.player.catchup(p);
        },
        'game:pending': (p) => this.player.applyPending(p),
        'game:over': (p) => useGameStore.getState().setOver(p),
        // 小游戏的观战票据与输入帧由 minigames/index.ts 的 installMinigames 经 transport.on 直接监听
        // （对局页进入时安装）；安装之前到达的先缓存，安装时交出（takeMinigameBacklog）
        'game:minigameWatch': (p) => this.holdMinigame({ event: 'game:minigameWatch', payload: p }),
        'game:minigameFrames': (p) => this.holdMinigame({ event: 'game:minigameFrames', payload: p }),
        'chat:message': (m) => {
          useChatStore.getState().add(m);
          if (m.system && TOAST_SYSTEM_KEYS.has(m.system.key)) {
            const warn = m.system.key === 'internalError' || m.system.key === 'aiPaused';
            useUiStore.getState().toast(systemText(this.t, m), warn ? 'warn' : 'info', 4000);
          }
        },
        'chat:history': (p) => useChatStore.getState().setHistory(p.messages),
        'chat:emote': (e) => useChatStore.getState().emote(e),
        'session:replaced': () => useConnectionStore.getState().setReplaced(true),
        'server:notice': (n) => useUiStore.getState().toast(n.message, n.kind === 'info' ? 'info' : 'warn', 6000),
        'app:error': (e) => useUiStore.getState().toast(this.errorText(e), 'error'),
      }),
    );
    if (typeof document !== 'undefined') {
      const onVis = (): void => {
        this.player.setHidden(document.hidden);
        // 回到前台时发现掉线就立即重连（被别处顶替的会话不自动抢回，由用户在遮罩上确认）
        const st = this.transport.status;
        if (!document.hidden && st !== 'open' && st !== 'connecting' && !useConnectionStore.getState().replaced) {
          this.transport.connect();
        }
      };
      document.addEventListener('visibilitychange', onVis);
      this.offs.push(() => document.removeEventListener('visibilitychange', onVis));
      if (document.hidden) this.player.setHidden(true);
    }
    if (this.o.driveClock !== false) this.startClockDriver();
    this.clock.start();
    this.transport.connect();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.clock.stop();
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.player.dispose();
    this.transport.close();
    this.started = false;
  }

  /**
   * 棋盘挂载 / 卸载（null）。卸载时（浏览器后退、回大厅、换图）先中止正在播放的演出并跳到最新状态：
   * 当前 handler 的补间还挂在共享动画时钟上，棋盘销毁后再写 Pixi 对象会抛错；之后的事件用 NULL_BOARD。
   */
  attachBoard(board: BoardPort | null): void {
    if (board === null && this.board !== NULL_BOARD) this.player.skipAll();
    this.board = board ?? NULL_BOARD;
    const v = this.player.displayView;
    if (board && v) board.syncView(v);
  }

  setMap(map: MapIndex | null): void {
    this.map = map;
  }

  /** 镜头移到地块（信息面板「定位」） */
  focusLot(lot: LotId): void {
    void this.board.focus({ lot }, 400, new AbortController().signal);
  }

  get currentMap(): MapIndex | null {
    return this.map;
  }

  get currentRoom(): string | null {
    return this.roomCode;
  }

  // ───────────────────────── 大厅与房间 ─────────────────────────

  private req<E extends C2SEventName>(event: E, payload: C2SPayload<E>): Promise<Result<C2SAckData<E>>> {
    this.start();
    return this.transport.request(event, payload);
  }

  async createRoom(settings?: RoomSettingsPatch): Promise<Result<{ code: string; inviteUrl: string }>> {
    this.resetRoomState();
    const r = await this.req('room:create', settings ? { settings } : {});
    if (r.ok) {
      this.roomCode = r.data.code;
      this.rememberRoom();
    }
    return r;
  }

  /**
   * 进入房间（/r/:code、刷新、邀请链接）：本机记着这个房间就先 room:resume，否则 room:join；
   * 以玩家身份加入时满员或已开局，自动改为观战（autoSpectate）。
   */
  enterRoom(
    code: string,
    role: EnterRole,
    o: { autoSpectate?: boolean } = {},
  ): Promise<Result<{ role: EnterRole; fellBack: boolean }>> {
    // 同一房间的并发进入（StrictMode 双调用、快速重渲染）合并为一次
    if (this.entering?.code === code) return this.entering.p;
    const p = this.enterRoomInner(code, role, o).finally(() => {
      if (this.entering?.p === p) this.entering = null;
    });
    this.entering = { code, p };
    return p;
  }

  private async enterRoomInner(
    code: string,
    role: EnterRole,
    o: { autoSpectate?: boolean },
  ): Promise<Result<{ role: EnterRole; fellBack: boolean }>> {
    if (this.roomCode === code && useRoomStore.getState().room?.code === code) {
      return { ok: true, data: { role: useRoomStore.getState().room?.you.role ?? role, fellBack: false } };
    }
    if (this.roomCode !== code) this.resetRoomState();
    const last = loadLastRoom(this.storage);
    if (last?.code === code) {
      const r = await this.req('room:resume', { code, lastSeq: 0, epoch: 0 });
      if (r.ok) {
        this.roomCode = code;
        return { ok: true, data: { role, fellBack: false } };
      }
    }
    const j = await this.req('room:join', { code, role });
    if (j.ok) {
      this.roomCode = code;
      this.rememberRoom();
      return { ok: true, data: { role: j.data.you.role, fellBack: false } };
    }
    const fallback =
      (o.autoSpectate ?? true) &&
      role === 'player' &&
      (j.error.code === 'ROOM_FULL' || j.error.code === 'ROOM_IN_GAME');
    if (fallback) {
      const s = await this.req('room:join', { code, role: 'spectator' });
      if (s.ok) {
        this.roomCode = code;
        this.rememberRoom();
        return { ok: true, data: { role: 'spectator', fellBack: true } };
      }
      return s;
    }
    return j;
  }

  async leaveRoom(): Promise<void> {
    if (this.roomCode !== null) await this.req('room:leave', {});
    this.resetRoomState();
    clearLastRoom(this.storage);
  }

  /** 单机：私密房 + 3 个电脑 + 开局（architecture §5.8） */
  async startSolo(game?: RoomSettingsPatch['game']): Promise<Result<{ code: string }>> {
    const c = await this.createRoom({
      visibility: 'private',
      allowSpectators: false,
      timerPreset: 'off',
      ...(game ? { game } : {}),
    });
    if (!c.ok) return c;
    for (const seat of [1, 2, 3] as const) {
      const r = await this.req('room:setSeatAi', { seat, ai: { preset: 'character' } });
      if (!r.ok) return r;
    }
    const s = await this.req('room:start', {});
    if (!s.ok) return s;
    return { ok: true, data: { code: c.data.code } };
  }

  updateSettings(patch: RoomSettingsPatch) {
    return this.req('room:updateSettings', { patch });
  }
  takeSeat(seat: SeatIndex) {
    return this.req('room:takeSeat', { seat });
  }
  toSpectator() {
    return this.req('room:toSpectator', {});
  }
  selectCharacter(characterId: CharacterId) {
    return this.req('room:selectCharacter', { characterId });
  }
  setReady(ready: boolean) {
    return this.req('room:setReady', { ready });
  }
  setSeatAi(seat: SeatIndex, ai: SeatAiConfig | null) {
    return this.req('room:setSeatAi', { seat, ai });
  }
  kick(target: { seat: SeatIndex } | { spectatorId: string }) {
    return this.req('room:kick', { target });
  }
  transferHost(seat: SeatIndex) {
    return this.req('room:transferHost', { seat });
  }
  startGame() {
    return this.req('room:start', {});
  }
  rematch() {
    return this.req('room:rematch', {});
  }
  async dissolve(): Promise<Result<void>> {
    return this.req('room:dissolve', {});
  }
  listPublicRooms() {
    return this.req('lobby:list', {});
  }

  // ───────────────────────── 对局 ─────────────────────────

  /** 回答本人当前的决策；失败时解锁并提示。同一决策已在提交中（或已提交、等下一批）时直接忽略 */
  async act(intent: PlayerIntent, decisionId?: string): Promise<Result<{ seq: number }>> {
    const d = useGameStore.getState().decision;
    const id = decisionId ?? d?.decisionId;
    if (!id) return { ok: false, error: appError('STALE_DECISION') };
    if (useGameStore.getState().submitting === id) {
      return { ok: false, error: appError('STALE_DECISION', { reason: 'alreadySubmitted' }) };
    }
    useGameStore.getState().setSubmitting(id);
    const r = await this.req('game:act', { decisionId: id, intent, clientActionId: newActionId() });
    if (!r.ok) {
      if (useGameStore.getState().submitting === id) useGameStore.getState().setSubmitting(null);
      useUiStore
        .getState()
        .toast(r.error.code === 'STALE_DECISION' ? this.t('hud:toast.stale') : this.errorText(r.error), 'warn');
    }
    return r;
  }

  autopilot(on: boolean, settings?: TrusteeSettings) {
    return this.req('game:autopilot', settings ? { on, settings } : { on });
  }
  pause(paused: boolean) {
    return this.req('game:pause', { paused });
  }
  resync() {
    return this.req('game:resync', {});
  }
  save(name: string) {
    return this.req('game:save', { name });
  }
  async listSaves(): Promise<Result<{ saves: SaveSummary[] }>> {
    return this.req('saves:list', {});
  }
  deleteSave(saveId: string) {
    return this.req('saves:delete', { saveId });
  }
  loadSave(saveId: string) {
    return this.req('room:loadSave', { saveId });
  }
  claimSeat(seat: SeatIndex) {
    return this.req('room:claimSeat', { seat });
  }
  chat(text: string) {
    return this.req('chat:send', { text });
  }
  emote(emoteId: string, targetSeat?: SeatIndex) {
    return this.req('chat:emote', targetSeat === undefined ? { emoteId } : { emoteId, targetSeat });
  }
  debug(op: DebugOp) {
    return this.req('debug:act', { op });
  }

  /** 同一 token 在别处登录后，用户选择在本页接管 */
  reclaim(): void {
    useConnectionStore.getState().setReplaced(false);
    this.transport.connect();
  }

  errorText(e: AppError): string {
    // 传输层的本地错误（超时、断开、被顶替）都是 INTERNAL，按 details.reason 给出具体文案
    const reason = (e.details as { reason?: unknown } | undefined)?.reason;
    if (e.code === 'INTERNAL' && typeof reason === 'string') {
      const r = this.t(`hud:errorReason.${reason}`, { defaultValue: '' });
      if (r) return r;
    }
    const k = `hud:error.${e.code}`;
    return this.t(k, { defaultValue: e.message });
  }

  // ───────────────────────── 内部 ─────────────────────────

  private names(view: () => GameView | null) {
    return makeNames({ t: this.t, view, map: () => this.map });
  }

  private makeContext(signal: AbortSignal, view: () => GameView): PresentationContext {
    const room = useRoomStore.getState().room;
    const self = this;
    const epoch = this.player.abortEpoch;
    return {
      signal,
      wait: (ms) => this.anim.wait(ms, signal),
      // 每次访问取当前棋盘：handler 执行中棋盘被卸载后，后续调用落到 NULL_BOARD 而不是已销毁的棋盘；
      // 演出被中止（reset / skipAll / dispose）之后上下文失效，同样落到 NULL_BOARD——被中止的 handler 在之后的
      // 微任务里收尾时，不会用旧时间线的状态覆盖刚同步好的棋盘，也不再新建特效
      get board() {
        return signal.aborted || self.player.abortEpoch !== epoch ? NULL_BOARD : self.board;
      },
      get ui() {
        return signal.aborted || self.player.abortEpoch !== epoch ? NULL_UI : self.ui;
      },
      animSpeed: () => this.anim.speed,
      audio: NULL_AUDIO,
      me: mySeat(room),
      role: room?.you.role === 'player' ? 'player' : 'spectator',
      view,
      map: this.map,
      names: this.names(view),
      t: this.t,
    };
  }

  /**
   * 昵称只在握手时发给服务器（handshakeAuth）：不在对局中时断开重连，让新昵称立即用于建房、加入与所在房间大厅。
   * 对局中不重连（设置里的昵称输入在对局中隐藏）；新昵称在下次连接时生效。
   */
  private onNicknameChanged(): void {
    const st = this.transport.status;
    if (st !== 'open' && st !== 'connecting' && st !== 'reconnecting') return;
    if (useConnectionStore.getState().replaced) return;
    const room = useRoomStore.getState().room;
    if (room !== null && room.phase !== 'lobby') return;
    this.transport.close();
    this.transport.connect();
  }

  private async onConnected(): Promise<void> {
    const code = this.roomCode;
    if (code === null) return;
    const r = await this.transport.request('room:resume', {
      code,
      lastSeq: this.player.receivedSeq,
      epoch: this.player.currentEpoch ?? 0,
    });
    if (!r.ok && (r.error.code === 'ROOM_NOT_FOUND' || r.error.code === 'NOT_IN_ROOM')) {
      this.onRoomClosed('idle');
    }
  }

  private onRoomClosed(reason: 'dissolved' | 'kicked' | 'idle' | 'server'): void {
    const code = this.roomCode ?? useRoomStore.getState().room?.code ?? '';
    this.resetRoomState();
    clearLastRoom(this.storage);
    useRoomStore.getState().setClosed(code, reason);
  }

  private holdMinigame(m: MinigameBacklogItem): void {
    const b = this.mgBacklog;
    if (b === null) return;
    b.push(m);
    if (b.length > MINIGAME_BACKLOG_MAX) b.splice(0, b.length - MINIGAME_BACKLOG_MAX);
  }

  /** 小游戏模块接管：交出安装前缓存的票据与帧（按到达顺序），此后不再缓存 */
  takeMinigameBacklog(): MinigameBacklogItem[] {
    const b = this.mgBacklog ?? [];
    this.mgBacklog = null;
    return b;
  }

  private resetRoomState(): void {
    this.roomCode = null;
    if (this.mgBacklog !== null) this.mgBacklog = [];
    this.player.dispose();
    useGameStore.getState().clear();
    useChatStore.getState().clear();
    useRoomStore.getState().clear();
    useUiStore.getState().closeTransient();
  }

  private rememberRoom(): void {
    if (this.roomCode === null) return;
    saveLastRoom(
      { code: this.roomCode, epoch: this.player.currentEpoch ?? 0, lastSeq: this.player.receivedSeq },
      this.storage,
    );
  }

  /**
   * 驱动动画时钟：rAF 每帧按真实流逝推进（单次最多 1 秒）；rAF 被节流时（嵌入式视图、省电模式）
   * 再用 200ms 的定时器兜底，保证动画不会比服务器按 1x 估算的时长慢太多。
   */
  private startClockDriver(): void {
    const raf: ((cb: (t: number) => void) => number) | undefined =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined;
    const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.lastFrame = now();
    const step = (): void => {
      const t = now();
      const dt = Math.min(CLOCK_MAX_STEP_MS, t - this.lastFrame);
      this.lastFrame = t;
      if (dt > 0) this.anim.advance(dt);
    };
    // 先续订下一帧再推进：帧回调抛错也不会打断 rAF 链（否则整个会话只剩 200ms 兜底，动画掉到约 5fps）
    const tick = (): void => {
      this.rafId = raf ? raf(tick) : null;
      try {
        step();
      } catch (err) {
        console.error('[rich4] animation frame failed', err);
      }
    };
    if (raf) this.rafId = raf(tick);
    const fallback = setInterval(() => {
      if (now() - this.lastFrame < CLOCK_FALLBACK_MS) return;
      try {
        step();
      } catch (err) {
        console.error('[rich4] animation frame failed', err);
      }
    }, CLOCK_FALLBACK_MS);
    this.offs.push(() => clearInterval(fallback));
  }
}

/** 握手 auth：每次（重）连都重新读取 token 与昵称 */
export function handshakeAuth(storage: KeyValueStorage = safeStorage()) {
  return {
    token: loadToken(storage),
    nickname: useSettingsStore.getState().nickname,
    protocolVersion: PROTOCOL_VERSION,
    clientVersion: (import.meta.env.VITE_APP_VERSION as string | undefined) ?? CLIENT_VERSION_FALLBACK,
  };
}
