/**
 * 对局编排核心（design/net.md §5–§7；architecture §5.9、§6）。不做 IO：时钟、定时器、日志、AI、输出全部注入，
 * 不得引入 node:* 与 socket.io（将来可以原样搬进 Web Worker）。
 *
 * 职责：
 * - 调用引擎：applyAction、getResult、getPendingDecisions 全部放在 try/catch 里，都成功后才提交 state/seq/journal；
 *   EngineRuleError → INVALID_ACTION{rule}（STALE/NOT_YOUR/GAME_OVER 映射为同名错误码），其他异常 → INTERNAL，旧 state 不变。
 * - 定时器回调（超时、AI、断线宽限）与提交后的广播 hooks 抛异常时只记日志并通知房间（hooks.fault → 暂停），不外抛。
 * - 序号：每应用一个 action seq+1；epoch 由 Room 在开局、rematch、读档、重启时递增后传入。
 * - 待决策与截止时间：新出现的决策按 Deadlines 计算截止时间（budgetKey 链、拍卖每人独立计时、小游戏票据）。
 *   档位用「有效计时档位」（effectiveTimerPreset：真人座位 ≤ 1 时不限时；已淘汰的真人不算）；座位控制方式变化或
 *   对局进展使它改变时（离开、被踢、破产 / 投降后只剩一名真人，离开的真人回来）重新计算当前待决策的截止时间（retime），
 *   随 game:pending / batch 下发。
 * - 托管状态机（SeatControl）、断线宽限、连续超时进 AFK、暂停恢复、clientActionId 幂等（每座位 LRU 32）。
 * - 小游戏（MinigameReferee）：MINIGAME 决策出现时开会话；输入流与提交经 minigameInput / minigameSubmit，
 *   以服务器重放结果提交系统 action MINIGAME_RESULT；已开局后 MINIGAME_DECLINE 被拒、AI 不再代答，到期用已收到的输入结算；
 *   暂停恢复时已开局的会话按已收到的输入结算，未开局的换新窗口（新 sessionId、新种子）。
 * - RingBuffer 256 个原始 batch 供 catchup；内存 journal 供重放校验；每条 journal 经 hooks.applied 交给房间持久化。
 * - 重启恢复与读档：init.seq 为起始序号（恢复时沿用快照 + journal 重放后的 seq），init.paused 以暂停状态开局（不计时）。
 * - 按观察者组装 game:batch / snapshot / catchup / pending / over 消息（投影在这里做，发送在 RoomBroadcaster）。
 */
import type { DataRegistry, MapIndex } from '@rich4/shared/data';
import {
  type EngineApi,
  type GameAction,
  type GameEvent,
  type GameResult,
  type GameState,
  isIntentAllowed,
  isSystemAction,
  type PendingDecision,
  type PlayerIntent,
  type SeatIndex,
  type SystemAction,
  timingOf,
} from '@rich4/shared/engine';
import { MINIGAME_TIMING, type MinigameTicket } from '@rich4/shared/minigames';
import {
  type ActorBy,
  AFK_TIMEOUT_STREAK,
  type AiPace,
  type BatchCause,
  CLIENT_ACTION_LRU,
  type ErrorCode,
  effectiveTimerPreset,
  fail,
  type GameBatchMsg,
  type GameCatchupMsg,
  type GameOverMsg,
  type GameSnapshotMsg,
  isHumanSeatControl,
  type MinigameFramesMsg,
  type MinigameInputMsg,
  type MinigameSubmitMsg,
  NET_GRACE_MS,
  ok,
  type PacingProfile,
  type PendingChangedMsg,
  type Result,
  RING_BUFFER_BATCHES,
  type TimeoutPolicy,
  type TimerPreset,
  type YourDecision,
} from '@rich4/shared/net';
import { fnv1a32 } from '@rich4/shared/util';
import {
  estimateAnimMs,
  type GameView,
  type HandVisibility,
  isAutopilot,
  type PendingView,
  projectEvent,
  projectState,
  type SeatControl,
  type Viewer,
  viewerClassKey,
} from '@rich4/shared/view';
import type { Clock, Scheduler, TimerHandle } from '../infra/clock';
import type { Logger } from '../infra/logger';
import type { AiDriver } from './AiDriver';
import {
  type BudgetEntry,
  computeDeadline,
  effectiveDeadline,
  fireAt,
  minigameWindow,
  releaseDeadline,
  resumeDeadline,
  shiftBudget,
  type TimingOptions,
  visibleAt,
} from './Deadlines';
import { MinigameReferee } from './MinigameReferee';
import { RingBuffer } from './RingBuffer';

/** 房间设置里 GameRunner 关心的部分（每次读取，保证与房间一致） */
export interface RunnerSettings {
  handVisibility: HandVisibility;
  /** 房间设置的档位；实际计时用 effectiveTimerPreset()（真人座位 ≤ 1 时不限时） */
  timerPreset: TimerPreset;
  timeoutPolicy: TimeoutPolicy;
  aiPace: AiPace;
  allowMinigameDecline: boolean;
  reconnectGraceSec: number;
  /** 演出节奏：每批的 animMs（截止时间、AI 等待、补发）按它的预算表计算（original-skin.md U3） */
  pacing: PacingProfile;
}

/** 环形缓冲里的原始 batch（事件未脱敏） */
export interface RawBatch {
  seq: number;
  cause: BatchCause;
  events: GameEvent[];
  animMs: number;
}

export interface JournalEntry {
  seq: number;
  at: number;
  by: ActorBy;
  action: GameAction;
}

/** GameRunner 向房间报告的事情；全部同步调用 */
export interface RunnerHooks {
  /** 每应用一个 action 调用一次，先于 batch（房间据此追加持久化 journal） */
  applied?(entry: JournalEntry): void;
  /** 每应用一个 action 调用一次（先于 ack） */
  batch(raw: RawBatch): void;
  /** 截止时间或托管状态变了，但没有新的 action */
  pendingChanged(): void;
  controlChanged(seat: SeatIndex, control: SeatControl, prev: SeatControl): void;
  /**
   * 有效计时档位因对局进展变了（真人被淘汰后只剩一名真人，net.md §5.4），不经过 controlChanged：房间应广播 room:state。
   * 在这一批的 batch 之前调用；当前待决策的截止时间已经重新算好
   */
  timerPresetChanged?(preset: TimerPreset): void;
  gameOver(msg: GameOverMsg): void;
  /** 引擎发出 DAY_END（M5 用它触发自动存档） */
  dayEnd?(): void;
  /** 单次超时执行了 defaultIntent（系统消息） */
  timedOut?(seat: SeatIndex, by: 'default' | 'ai'): void;
  /** AI 连续失败或兜底 intent 也被引擎拒绝：房间应暂停 */
  aiStuck(seat: SeatIndex): void;
  /** 定时器回调或广播 hooks 抛出了非规则异常（已记日志）：房间应暂停并提示内部错误 */
  fault?(seat: SeatIndex | null): void;
}

export interface GameRunnerDeps {
  engine: EngineApi;
  data: DataRegistry;
  clock: Clock;
  scheduler: Scheduler;
  log: Logger;
  ai: AiDriver;
  timing: TimingOptions;
  settings: () => RunnerSettings;
  hooks: RunnerHooks;
}

export interface SeatInit {
  seat: SeatIndex;
  control: SeatControl;
  connected: boolean;
}

export interface RunnerInit {
  epoch: number;
  state: GameState;
  seats: SeatInit[];
  /** 起始 seq（默认 0；重启恢复时为快照 + journal 重放后的 seq） */
  seq?: number;
  /** 以暂停状态开局：begin() 不为待决策计时，resume() 时才开始（重启恢复） */
  paused?: boolean;
}

interface SeatRt {
  seat: SeatIndex;
  control: SeatControl;
  connected: boolean;
  disconnectedAt: number | null;
  graceTimer: TimerHandle | null;
  timeouts: number;
  aiFailures: number;
  /** clientActionId → 上次结果（插入顺序即新旧顺序） */
  recent: Map<string, Result<{ seq: number }>>;
}

interface DecisionRt {
  d: PendingDecision;
  /** 决策出现的时间与当时那批的动画时长：AI 接手时先等剩余动画（net.md §7） */
  shownAt: number;
  animMs: number;
  deadlineAt: number | null;
  ticket: MinigameTicket | null;
  timer: TimerHandle | null;
  /** 暂停时记下的剩余时间 */
  remaining: number | null;
}

/** 连续多少次 AI 失败后暂停房间 */
export const AI_FAILURE_LIMIT = 3;

const ENGINE_RULE_TO_CODE: Readonly<Record<string, ErrorCode>> = {
  STALE_DECISION: 'STALE_DECISION',
  NOT_YOUR_DECISION: 'NOT_YOUR_DECISION',
  GAME_OVER: 'GAME_OVER',
};

function ruleOf(e: unknown): string | null {
  if (e && typeof e === 'object' && (e as { name?: unknown }).name === 'EngineRuleError') {
    const rule = (e as { rule?: unknown }).rule;
    return typeof rule === 'string' ? rule : 'UNKNOWN';
  }
  return null;
}

/** 本批里「玩过」的小游戏结算：seat → 分数（关闭会话时记入已结算列表） */
/** 小游戏换窗口时的新种子（与引擎种子同范围 0..0x7fffffff；只由旧种子与新 sessionId 决定） */
export function renewSeed(seed: number, sessionId: string): number {
  return fnv1a32(`${seed}:${sessionId}`) & 0x7fffffff;
}

function playedMinigames(events: readonly GameEvent[]): Map<SeatIndex, number> {
  const out = new Map<SeatIndex, number>();
  for (const e of events) if (e.type === 'MINIGAME_ENDED' && e.mode === 'played') out.set(e.seat, e.score);
  return out;
}

export class GameRunner {
  readonly epoch: number;
  private st: GameState;
  private seqNo = 0;
  private readonly ring = new RingBuffer<RawBatch>(RING_BUFFER_BATCHES);
  private readonly journalList: JournalEntry[] = [];
  private readonly seatRts = new Map<SeatIndex, SeatRt>();
  private readonly decisions = new Map<string, DecisionRt>();
  private readonly budgets = new Map<string, BudgetEntry>();
  private pausedFlag = false;
  /** 正在通知 hooks.fault（防止重入） */
  private faulting = false;
  private overFlag = false;
  private disposed = false;
  private mapIndex: MapIndex | null = null;
  /** 小游戏裁判（会话随 MINIGAME 决策开关；网络层经它取观战票据与积压帧） */
  readonly minigames: MinigameReferee;
  /** 小游戏会话换窗口的次数（新 sessionId 的后缀） */
  private minigameGen = 0;

  constructor(
    private readonly deps: GameRunnerDeps,
    init: RunnerInit,
  ) {
    this.epoch = init.epoch;
    this.st = init.state;
    this.seqNo = init.seq ?? 0;
    this.pausedFlag = init.paused === true;
    this.minigames = new MinigameReferee({ log: deps.log, graceMs: NET_GRACE_MS * deps.timing.timerScale });
    for (const s of init.seats) {
      this.seatRts.set(s.seat, {
        seat: s.seat,
        control: s.control,
        connected: s.connected,
        disconnectedAt: s.connected ? null : deps.clock.now(),
        graceTimer: null,
        timeouts: 0,
        aiFailures: 0,
        recent: new Map(),
      });
    }
  }

  /** 开局后调用一次：为初始待决策计时（createGame 不产生事件；seq 从 init.seq 开始） */
  begin(): void {
    this.overFlag = this.deps.engine.getResult(this.st) !== null;
    this.syncPending(0, this.overFlag ? [] : this.deps.engine.getPendingDecisions(this.st));
    for (const rt of this.seatRts.values()) {
      if (!rt.connected && rt.control === 'human') this.startGrace(rt);
    }
  }

  // ───────────────────────── 只读 ─────────────────────────

  get seq(): number {
    return this.seqNo;
  }

  get state(): GameState {
    return this.st;
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  get over(): boolean {
    return this.overFlag;
  }

  get result(): GameResult | null {
    return this.deps.engine.getResult(this.st);
  }

  /** 本 runner 生命期内应用的 action（重启恢复的 runner 只含恢复之后的部分） */
  journal(): readonly JournalEntry[] {
    return this.journalList;
  }

  rawBatches(): readonly RawBatch[] {
    return this.ring.toArray();
  }

  controlOf(seat: SeatIndex): SeatControl | null {
    return this.seatRts.get(seat)?.control ?? null;
  }

  seats(): SeatIndex[] {
    return [...this.seatRts.keys()].sort((a, b) => a - b);
  }

  pendingDecisions(): PendingDecision[] {
    return [...this.decisions.values()].map((r) => r.d);
  }

  /** 某座位当前的截止时间（测试与诊断用） */
  deadlineOf(decisionId: string): number | null {
    return this.decisions.get(decisionId)?.deadlineAt ?? null;
  }

  /**
   * 有效计时档位（design/net.md §5.4）：房间设置的档位，但真人座位 ≤ 1 时不限时（同单机）。真人座位按控制方式数
   * （isHumanSeatControl：在线、断线宽限、托管都算，电脑补位 / 被踢 / 离开不算），并且引擎里这名玩家还在局中——
   * 已淘汰（破产、投降）的真人不再有决策，不算；观战者不在座位上，不影响。
   */
  effectiveTimerPreset(): TimerPreset {
    let humans = 0;
    for (const rt of this.seatRts.values()) if (this.isHumanSeat(rt)) humans++;
    return effectiveTimerPreset(this.deps.settings().timerPreset, humans);
  }

  /** 算作真人座位：控制方式是真人（含托管），且引擎里这名玩家没有被淘汰（破产 / 投降后 alive 为 false） */
  private isHumanSeat(rt: SeatRt): boolean {
    if (!isHumanSeatControl(rt.control)) return false;
    return this.st.players.find((p) => p.seat === rt.seat)?.alive !== false;
  }

  // ───────────────────────── 提交 ─────────────────────────

  /**
   * 真人提交（design/net.md §6.2 第 4–10 步；限流与 zod 校验在 guard 完成，seat 只从 session 取）。
   */
  submitPlayer(
    seat: SeatIndex,
    decisionId: string,
    intent: PlayerIntent,
    clientActionId: string | null,
  ): Result<{ seq: number }> {
    const rt = this.seatRts.get(seat);
    if (!rt) return fail('NOT_A_PLAYER');
    if (this.overFlag) return fail('GAME_OVER');
    if (this.pausedFlag) return fail('GAME_PAUSED');
    if (clientActionId !== null) {
      const cached = rt.recent.get(clientActionId);
      if (cached) return cached;
    }
    const res = this.submitPlayerInner(rt, decisionId, intent);
    if (clientActionId !== null) {
      rt.recent.set(clientActionId, res);
      while (rt.recent.size > CLIENT_ACTION_LRU) {
        const oldest = rt.recent.keys().next().value;
        if (oldest === undefined) break;
        rt.recent.delete(oldest);
      }
    }
    return res;
  }

  private submitPlayerInner(rt: SeatRt, decisionId: string, intent: PlayerIntent): Result<{ seq: number }> {
    const dr = this.decisions.get(decisionId);
    if (!dr) return fail('STALE_DECISION');
    if (dr.d.seat !== rt.seat) return fail('NOT_YOUR_DECISION');
    if (!isIntentAllowed(dr.d.kind, intent.type)) return fail('INVALID_ACTION', { rule: 'INTENT_NOT_ALLOWED' });
    if (intent.type === 'MINIGAME_DECLINE' && !this.deps.settings().allowMinigameDecline) {
      return fail('INVALID_ACTION', { rule: 'MINIGAME_DECLINE_DISABLED' });
    }
    // 开局后（已收到 seq 0）不能再跳过：按已收到的输入结算
    if (intent.type === 'MINIGAME_DECLINE' && this.minigames.started(decisionId)) {
      return fail('MINIGAME_INVALID', { reason: 'started' });
    }
    // 真人操作优先：托管中先解除（成功时后面马上有 batch，不单独发 game:pending）
    const released = isAutopilot(rt.control) && rt.control !== 'autopilot:left';
    if (released) this.setControl(rt, 'human', true);
    const res = this.apply({ ...intent, seat: rt.seat, decisionId } as GameAction, 'player', rt.seat);
    if (res.ok) rt.timeouts = 0;
    // 被引擎拒绝：没有 batch，补发 game:pending 让各端看到解除托管后的 control 与截止时间
    else if (released) this.hook('pendingChanged', rt.seat, () => this.deps.hooks.pendingChanged());
    return res;
  }

  /** 服务器产生的系统 action（SYS_SET_CONTROLLER、SYS_SET_AI_TRAITS、SYS_DEBUG、MINIGAME_RESULT） */
  submitSystem(action: SystemAction): Result<{ seq: number }> {
    if (this.overFlag) return fail('GAME_OVER');
    const seat = 'seat' in action ? action.seat : null;
    return this.apply(action, 'system', seat);
  }

  private apply(action: GameAction, by: ActorBy, seat: SeatIndex | null): Result<{ seq: number }> {
    const { engine, clock, log } = this.deps;
    let next: { state: GameState; events: GameEvent[] };
    let result: GameResult | null;
    let pending: PendingDecision[];
    // 所有引擎调用都在提交之前完成：任何一步抛异常，state/seq/journal/ring 都不变（net.md §6.2 第 9 步）
    try {
      next = engine.applyAction(this.st, action);
      result = engine.getResult(next.state);
      pending = result === null ? engine.getPendingDecisions(next.state) : [];
    } catch (e) {
      const rule = ruleOf(e);
      if (rule !== null) return fail(ENGINE_RULE_TO_CODE[rule] ?? 'INVALID_ACTION', { rule });
      log.error({ err: e, action: action.type, seat, seq: this.seqNo }, 'engine.applyAction failed');
      return fail('INTERNAL');
    }
    const presetBefore = this.effectiveTimerPreset();
    this.st = next.state;
    this.seqNo++;
    const raw: RawBatch = {
      seq: this.seqNo,
      cause: { seat, intentType: action.type, by },
      events: next.events,
      // 按房间节奏估算这批动画：计入截止时间（动画不占思考时间）与 AI 行动前的等待
      animMs: estimateAnimMs(next.events, this.deps.settings().pacing),
    };
    const entry: JournalEntry = { seq: this.seqNo, at: clock.now(), by, action };
    this.journalList.push(entry);
    this.ring.push(raw);
    // 持久化 journal 先于广播（崩溃时最多丢最后一个尚未写入的 action）
    if (this.deps.hooks.applied) this.hook('applied', seat, () => this.deps.hooks.applied?.(entry));
    // 真人被淘汰（破产、投降）使真人座位只剩一名：有效档位变为不限时，当前待决策重新计时（net.md §5.4）；
    // 新出现的决策随后在 syncPending 里按新档位计时。放在 SYS_SET_CONTROLLER 之前：踢人那条路径由 setControl 自己比较前后
    const presetAfter = this.effectiveTimerPreset();
    const presetChanged = result === null && presetAfter !== presetBefore;
    if (presetChanged) this.retime(presetAfter);
    if (isSystemAction(action) && action.type === 'SYS_SET_CONTROLLER') {
      const rt = this.seatRts.get(action.seat);
      if (rt && action.controller === 'ai') this.setControl(rt, 'ai', true);
    }
    if (result !== null) {
      this.overFlag = true;
      this.clearDecisions();
    } else {
      this.syncPending(raw.animMs, pending, playedMinigames(next.events));
    }
    // 提交之后的广播：投影或发送出错只记日志并暂停房间，不回滚已经生效的 action。
    // 有效档位变了先通知房间（room:state 带新的 effectiveTimerPreset），与 setControl 里 controlChanged 先于 batch 一致
    if (presetChanged) this.hook('timerPresetChanged', seat, () => this.deps.hooks.timerPresetChanged?.(presetAfter));
    this.hook('batch', seat, () => this.deps.hooks.batch(raw));
    if (next.events.some((e) => e.type === 'DAY_END')) this.hook('dayEnd', seat, () => this.deps.hooks.dayEnd?.());
    if (result !== null) {
      this.cancelAllTimers();
      const over = result;
      this.hook('gameOver', seat, () => this.deps.hooks.gameOver(this.gameOverMsg(over)));
    }
    return ok({ seq: this.seqNo });
  }

  /** 调用 hooks（广播等）：抛异常时记日志并报告 fault */
  private hook(what: string, seat: SeatIndex | null, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.deps.log.error({ err, seat, seq: this.seqNo, hook: what }, 'runner hook threw');
      this.fault(seat);
    }
  }

  /** 定时器回调包装：任何异常都不外抛（否则 setTimeout 里的异常会让整个进程退出） */
  private guarded(what: string, seat: SeatIndex | null, fn: () => void): () => void {
    return () => {
      if (this.disposed) return;
      try {
        fn();
      } catch (err) {
        this.deps.log.error({ err, seat, seq: this.seqNo, timer: what }, 'runner timer callback threw');
        this.fault(seat);
      }
    };
  }

  private fault(seat: SeatIndex | null): void {
    if (this.faulting || this.disposed) return;
    this.faulting = true;
    try {
      this.deps.hooks.fault?.(seat);
    } catch (err) {
      this.deps.log.error({ err, seat }, 'hooks.fault threw');
    } finally {
      this.faulting = false;
    }
  }

  // ───────────────────────── 待决策与计时 ─────────────────────────

  /** pending 由调用方在提交前取好（引擎调用集中在 try 里） */
  private syncPending(
    animMs: number,
    pending: readonly PendingDecision[],
    played: ReadonlyMap<SeatIndex, number> = new Map(),
  ): void {
    const { clock, timing } = this.deps;
    const live = new Set(pending.map((d) => d.id));
    for (const [id, dr] of this.decisions) {
      if (!live.has(id)) {
        dr.timer?.cancel();
        this.decisions.delete(id);
        if (dr.ticket) {
          const score = played.get(dr.d.seat);
          this.minigames.close(id, score === undefined ? undefined : { score });
        }
      }
    }
    const now = clock.now();
    const preset = this.effectiveTimerPreset();
    for (const d of pending) {
      const existing = this.decisions.get(d.id);
      if (existing) {
        existing.d = d;
        continue;
      }
      const dr: DecisionRt = { d, shownAt: now, animMs, deadlineAt: null, ticket: null, timer: null, remaining: null };
      if (d.kind === 'MINIGAME' && d.minigame) {
        const w = minigameWindow(now, animMs, d.minigame.minigameId, timing);
        dr.ticket = this.makeTicket(d, w.startsAt, w.deadlineAt);
        dr.deadlineAt = w.deadlineAt;
        this.minigames.open(dr.ticket);
      } else {
        const t = timingOf(d.kind);
        const key = d.budgetKey;
        const r = computeDeadline(
          {
            now,
            animMs,
            timing: t === 'minigame' ? 'pick' : t,
            preset,
            budget: key !== null ? (this.budgets.get(key) ?? null) : null,
            chained: key !== null,
          },
          timing,
        );
        dr.deadlineAt = r.deadlineAt;
        if (key !== null && r.budget) this.budgets.set(key, r.budget);
      }
      this.decisions.set(d.id, dr);
      if (this.pausedFlag) dr.remaining = dr.deadlineAt === null ? null : dr.deadlineAt - now;
      else this.schedule(dr);
    }
    // 只保留仍被引用的计时链
    const keys = new Set(pending.map((d) => d.budgetKey).filter((k): k is string => k !== null));
    for (const k of this.budgets.keys()) if (!keys.has(k)) this.budgets.delete(k);
  }

  private makeTicket(d: PendingDecision, startsAt: number, deadlineAt: number): MinigameTicket {
    const m = d.minigame!;
    const t = MINIGAME_TIMING[m.minigameId];
    return {
      sessionId: this.sessionIdOf(d),
      decisionId: d.id,
      seat: d.seat,
      minigameId: m.minigameId,
      seed: m.seed,
      params: { ...m.params },
      tickMs: t.tickMs,
      introTicks: t.introTicks,
      maxTicks: t.maxTicks,
      startsAt,
      deadlineAt,
      role: 'player',
    };
  }

  /** 会话 id：mg-<epoch>-<decisionId>，换窗口后加 .<n> */
  private sessionIdOf(d: PendingDecision, renew = false): string {
    const base = `mg-${this.epoch}-${d.id}`;
    return renew ? `${base}.${++this.minigameGen}` : base;
  }

  /** 已开局的小游戏：不再由 AI / 超时代答，只等提交或到期结算 */
  private minigameLocked(dr: DecisionRt): boolean {
    return dr.ticket !== null && this.minigames.started(dr.d.id);
  }

  /**
   * 按当前控制方为决策定时：真人 → 截止时间 + 网络宽限后超时；AI / 托管 → 等这批动画剩余的部分再加思考时间
   * （中途切到托管、离开、被踢时也不会抢在动画播完之前行动）。
   */
  private schedule(dr: DecisionRt): void {
    dr.timer?.cancel();
    dr.timer = null;
    if (this.pausedFlag || this.overFlag || this.disposed) return;
    const rt = this.seatRts.get(dr.d.seat);
    const { scheduler, clock, timing } = this.deps;
    const id = dr.d.id;
    const seat = dr.d.seat;
    if (!rt || rt.control === 'human' || this.minigameLocked(dr)) {
      if (dr.deadlineAt === null) return;
      dr.timer = scheduler.after(
        fireAt(dr.deadlineAt, timing) - clock.now(),
        this.guarded('deadline', seat, () => this.onDeadline(id)),
      );
      return;
    }
    const by: ActorBy = rt.control === 'ai' ? 'ai' : 'autopilot';
    const elapsed = Math.max(0, clock.now() - dr.shownAt);
    const delay = this.deps.ai.delayMs(dr.animMs, this.deps.settings().aiPace, timing, elapsed);
    dr.timer = scheduler.after(
      delay,
      this.guarded('ai', seat, () => this.aiAct(id, by)),
    );
  }

  private onDeadline(id: string): void {
    const dr = this.decisions.get(id);
    if (!dr || this.pausedFlag || this.overFlag || this.disposed) return;
    dr.timer = null;
    if (this.minigameLocked(dr)) {
      this.settleMinigame(dr);
      return;
    }
    const rt = this.seatRts.get(dr.d.seat);
    if (rt && rt.control !== 'human') {
      this.schedule(dr);
      return;
    }
    const seat = dr.d.seat;
    if (rt) rt.timeouts++;
    if (this.deps.settings().timeoutPolicy === 'ai') {
      this.deps.hooks.timedOut?.(seat, 'ai');
      this.aiAct(id, 'timeout');
    } else {
      this.deps.hooks.timedOut?.(seat, 'default');
      const r = this.apply({ ...dr.d.defaultIntent, seat, decisionId: id } as GameAction, 'timeout', seat);
      if (!r.ok) {
        this.deps.log.error({ seat, decisionId: id, error: r.error }, 'defaultIntent rejected on timeout');
        this.deps.hooks.aiStuck(seat);
        return;
      }
    }
    if (rt && rt.control === 'human' && rt.timeouts >= AFK_TIMEOUT_STREAK && !this.overFlag) {
      this.setControl(rt, 'autopilot:afk');
    }
  }

  private aiAct(id: string, by: ActorBy): void {
    const dr = this.decisions.get(id);
    if (!dr || this.pausedFlag || this.overFlag || this.disposed) return;
    dr.timer = null;
    // 玩家已开局：不代答 decline，改等提交或到期
    if (this.minigameLocked(dr)) {
      this.schedule(dr);
      return;
    }
    const seat = dr.d.seat;
    const rt = this.seatRts.get(seat);
    const you = this.decisionFor(seat);
    if (!you) return;
    let fallback = false;
    let intent: PlayerIntent = dr.d.defaultIntent;
    try {
      const out = this.deps.ai.decide({
        state: this.st,
        decision: dr.d,
        you,
        map: this.map(),
        handVisibility: this.deps.settings().handVisibility,
      });
      intent = out.intent;
      fallback = out.fallback !== null;
    } catch (err) {
      this.deps.log.error({ err, seat }, 'ai driver failed');
      fallback = true;
    }
    let r = this.apply({ ...intent, seat, decisionId: id } as GameAction, by, seat);
    if (!r.ok && intent !== dr.d.defaultIntent && this.decisions.has(id)) {
      this.deps.log.warn({ seat, type: intent.type, error: r.error }, 'ai intent rejected by engine');
      fallback = true;
      r = this.apply({ ...dr.d.defaultIntent, seat, decisionId: id } as GameAction, by, seat);
    }
    if (rt) rt.aiFailures = fallback || !r.ok ? rt.aiFailures + 1 : 0;
    if (!r.ok) {
      this.deps.log.error({ seat, decisionId: id, error: r.error }, 'ai defaultIntent rejected');
      this.deps.hooks.aiStuck(seat);
    } else if (rt && rt.aiFailures >= AI_FAILURE_LIMIT) {
      rt.aiFailures = 0;
      this.deps.hooks.aiStuck(seat);
    }
  }

  private map(): MapIndex {
    if (!this.mapIndex) {
      const ref = this.st.dataRef;
      this.mapIndex = this.deps.data.getMap(ref.mapId, ref.mapHash);
    }
    return this.mapIndex;
  }

  private clearDecisions(): void {
    for (const dr of this.decisions.values()) dr.timer?.cancel();
    this.decisions.clear();
    this.budgets.clear();
    this.minigames.clear();
  }

  private cancelAllTimers(): void {
    for (const dr of this.decisions.values()) {
      dr.timer?.cancel();
      dr.timer = null;
    }
    for (const rt of this.seatRts.values()) {
      rt.graceTimer?.cancel();
      rt.graceTimer = null;
    }
  }

  // ───────────────────────── 托管状态机 ─────────────────────────

  private setControl(rt: SeatRt, control: SeatControl, quiet = false): void {
    const prev = rt.control;
    if (prev === control || prev === 'ai') return;
    const presetBefore = this.effectiveTimerPreset();
    rt.control = control;
    if (control !== 'human') rt.timeouts = 0;
    const now = this.deps.clock.now();
    for (const dr of this.decisions.values()) {
      if (dr.d.seat !== rt.seat) continue;
      if (control === 'human') {
        const before = dr.deadlineAt;
        dr.deadlineAt = releaseDeadline(now, dr.deadlineAt, this.deps.timing);
        this.shiftChain(dr, before);
      }
      if (this.pausedFlag) dr.remaining = dr.deadlineAt === null ? null : dr.deadlineAt - now;
      else this.schedule(dr);
    }
    // 真人座位数跨过 1（离开 / 被踢后只剩一名真人，或离开的真人回来）：有效档位变了，当前待决策重新计时。
    // 先于 hooks：controlChanged 广播的 room:state 与随后的 game:pending（quiet 时是紧跟着的 batch）都带新的结果
    const presetAfter = this.effectiveTimerPreset();
    if (presetAfter !== presetBefore) this.retime(presetAfter);
    this.deps.hooks.controlChanged(rt.seat, control, prev);
    if (!quiet) this.deps.hooks.pendingChanged();
  }

  /**
   * 有效计时档位变了：重新计算当前待决策的截止时间。变为不限时 → 取消截止时间与超时定时器（计时链一并清掉）；
   * 从不限时变为有时限 → 从现在（这批动画还没播完则从播完时）起按档位重新给截止时间，计时链从头开始。
   * 小游戏窗口不受档位影响；由电脑 / 托管代打的决策只改截止时间，AI 定时器不动（它不看截止时间）。
   * 引擎状态里没有墙钟时间，这只是调度层的事，不影响确定性。
   */
  private retime(preset: TimerPreset): void {
    const { clock, timing } = this.deps;
    const now = clock.now();
    this.budgets.clear();
    const list = [...this.decisions.values()].sort(
      (a, b) => a.d.seat - b.d.seat || (a.d.id < b.d.id ? -1 : a.d.id > b.d.id ? 1 : 0),
    );
    for (const dr of list) {
      if (dr.ticket) continue;
      const t = timingOf(dr.d.kind);
      const key = dr.d.budgetKey;
      const r = computeDeadline(
        {
          now: Math.max(now, visibleAt(dr.shownAt, dr.animMs, timing)),
          animMs: 0,
          timing: t === 'minigame' ? 'pick' : t,
          preset,
          budget: key !== null ? (this.budgets.get(key) ?? null) : null,
          chained: key !== null,
        },
        timing,
      );
      dr.deadlineAt = r.deadlineAt;
      if (key !== null && r.budget) this.budgets.set(key, r.budget);
      if (this.pausedFlag) {
        dr.remaining = dr.deadlineAt === null ? null : dr.deadlineAt - now;
        continue;
      }
      const rt = this.seatRts.get(dr.d.seat);
      if (!rt || rt.control === 'human') this.schedule(dr);
    }
  }

  /** 决策截止时间从 before 挪到了 dr.deadlineAt（暂停恢复、解除托管）：同一 budgetKey 的计时链整体平移 */
  private shiftChain(dr: DecisionRt, before: number | null): void {
    const key = dr.d.budgetKey;
    if (key === null || before === null || dr.deadlineAt === null) return;
    const b = this.budgets.get(key);
    if (b) this.budgets.set(key, shiftBudget(b, dr.deadlineAt - before));
  }

  private startGrace(rt: SeatRt): void {
    rt.graceTimer?.cancel();
    const ms = this.deps.settings().reconnectGraceSec * 1000;
    rt.graceTimer = this.deps.scheduler.after(
      ms,
      this.guarded('grace', rt.seat, () => {
        rt.graceTimer = null;
        if (!rt.connected && rt.control === 'human' && !this.overFlag) this.setControl(rt, 'autopilot:disconnect');
      }),
    );
  }

  /** 房间通知：座位的真人连上或断开 */
  setConnected(seat: SeatIndex, connected: boolean): void {
    const rt = this.seatRts.get(seat);
    if (!rt || rt.connected === connected) return;
    rt.connected = connected;
    if (!connected) {
      rt.disconnectedAt = this.deps.clock.now();
      if (rt.control === 'human' && !this.overFlag) this.startGrace(rt);
      if (!this.overFlag) this.deps.hooks.pendingChanged();
      return;
    }
    rt.disconnectedAt = null;
    rt.graceTimer?.cancel();
    rt.graceTimer = null;
    if (rt.control === 'autopilot:disconnect' || rt.control === 'autopilot:left') this.setControl(rt, 'human');
    else if (!this.overFlag) this.deps.hooks.pendingChanged();
  }

  /** 对局中 room:leave：座位转 autopilot:left，tokenHash 由房间保留 */
  leave(seat: SeatIndex): void {
    const rt = this.seatRts.get(seat);
    if (!rt) return;
    rt.connected = false;
    rt.disconnectedAt = this.deps.clock.now();
    rt.graceTimer?.cancel();
    rt.graceTimer = null;
    if (rt.control !== 'ai') this.setControl(rt, 'autopilot:left');
  }

  /** game:autopilot：on=true 进入手动托管；on=false 解除任何托管（left 除外） */
  setAutopilot(seat: SeatIndex, on: boolean): Result<void> {
    const rt = this.seatRts.get(seat);
    if (!rt || rt.control === 'ai') return fail('NOT_A_PLAYER');
    if (this.overFlag) return fail('GAME_OVER');
    if (on) this.setControl(rt, 'autopilot:manual');
    else if (isAutopilot(rt.control)) this.setControl(rt, 'human');
    rt.timeouts = 0;
    return ok(undefined);
  }

  /** 被踢：转为纯电脑（SYS_SET_CONTROLLER），不可解除 */
  kick(seat: SeatIndex): void {
    const rt = this.seatRts.get(seat);
    if (!rt || rt.control === 'ai') return;
    rt.graceTimer?.cancel();
    rt.graceTimer = null;
    rt.connected = false;
    const r = this.submitSystem({ type: 'SYS_SET_CONTROLLER', seat, controller: 'ai' });
    if (!r.ok) {
      this.deps.log.warn({ seat, error: r.error }, 'SYS_SET_CONTROLLER rejected; switching control only');
      this.setControl(rt, 'ai');
    }
  }

  // ───────────────────────── 暂停 ─────────────────────────

  pause(): void {
    if (this.pausedFlag || this.overFlag) return;
    this.pausedFlag = true;
    const now = this.deps.clock.now();
    for (const dr of this.decisions.values()) {
      dr.timer?.cancel();
      dr.timer = null;
      dr.remaining = dr.deadlineAt === null ? null : dr.deadlineAt - now;
    }
    this.deps.hooks.pendingChanged();
  }

  resume(): void {
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    const { clock, timing } = this.deps;
    const now = clock.now();
    const settle: DecisionRt[] = [];
    for (const dr of this.decisions.values()) {
      if (dr.ticket && this.minigames.started(dr.d.id)) {
        // 已开局的小游戏按已收到的输入结算（暂停期间的输入一律被拒）
        settle.push(dr);
        dr.remaining = null;
        continue;
      }
      if (dr.ticket) {
        // 未开局：换新窗口、新 sessionId 与新种子（客户端据此重新倒计时）。旧种子已下发，暂停期间可能已被本地
        // 「空跑」过（喜从天降的掉落序列、企鹅的宝物布局），沿用它等于让玩家免费预演同一局
        const w = minigameWindow(now, 0, dr.ticket.minigameId, timing);
        const sessionId = this.sessionIdOf(dr.d, true);
        dr.ticket = {
          ...dr.ticket,
          sessionId,
          seed: renewSeed(dr.ticket.seed, sessionId),
          startsAt: w.startsAt,
          deadlineAt: w.deadlineAt,
        };
        dr.deadlineAt = w.deadlineAt;
        this.minigames.reopen(dr.ticket);
      } else if (dr.remaining !== null) {
        const before = dr.deadlineAt;
        dr.deadlineAt = resumeDeadline(now, dr.remaining, timing);
        // 暂停不消耗思考时间：TURN_MENU 计时链（首次可见时间与上一个截止时间）随之平移
        this.shiftChain(dr, before);
      }
      dr.remaining = null;
      this.schedule(dr);
    }
    this.deps.hooks.pendingChanged();
    for (const dr of settle) if (this.decisions.get(dr.d.id) === dr && !this.overFlag) this.settleMinigame(dr);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAllTimers();
    this.minigames.clear();
  }

  // ───────────────────────── 小游戏 ─────────────────────────

  /** 到期或恢复时结算：已开局 → MINIGAME_RESULT（服务器重放已收到的输入），未开局 → MINIGAME_DECLINE（超时） */
  private settleMinigame(dr: DecisionRt): void {
    const seat = dr.d.seat;
    const decisionId = dr.d.id;
    const s = this.minigames.settle(decisionId);
    const r =
      s.kind === 'result'
        ? this.apply({ type: 'MINIGAME_RESULT', seat, decisionId, score: s.score, logHash: s.logHash }, 'system', seat)
        : this.apply({ type: 'MINIGAME_DECLINE', seat, decisionId }, 'timeout', seat);
    if (!r.ok) {
      this.deps.log.error({ seat, decisionId, error: r.error }, 'minigame settlement rejected');
      this.deps.hooks.aiStuck(seat);
    }
  }

  /** game:minigameInput（seat 只从 session 取）：成功时返回转发给观战者的帧 */
  minigameInput(seat: SeatIndex, msg: MinigameInputMsg): Result<MinigameFramesMsg> {
    const rt = this.seatRts.get(seat);
    if (!rt) return fail('NOT_A_PLAYER');
    if (this.overFlag) return fail('GAME_OVER');
    if (this.pausedFlag) return fail('GAME_PAUSED');
    const s = this.minigames.sessionById(msg.sessionId);
    const wasStarted = s?.started === true;
    const r = this.minigames.input(seat, msg, this.deps.clock.now());
    if (!r.ok || !s) return r;
    const dr = this.decisions.get(s.ticket.decisionId);
    if (!wasStarted && dr) {
      // 真人开局：托管中先解除（离开除外），并把 AI 计时换成截止计时
      if (isAutopilot(rt.control) && rt.control !== 'autopilot:left') this.setControl(rt, 'human');
      else this.schedule(dr);
    }
    rt.timeouts = 0;
    return r;
  }

  /** game:minigameSubmit：校验并重放，以服务器结果提交 MINIGAME_RESULT；返回服务器分数 */
  minigameSubmit(seat: SeatIndex, msg: MinigameSubmitMsg): Result<{ score: number }> {
    if (!this.seatRts.has(seat)) return fail('NOT_A_PLAYER');
    if (this.overFlag) return fail('GAME_OVER');
    if (this.pausedFlag) return fail('GAME_PAUSED');
    const v = this.minigames.submit(seat, msg, this.deps.clock.now());
    if (!v.ok) return v;
    const { decisionId, score, logHash } = v.data;
    if (!this.decisions.has(decisionId)) return fail('STALE_DECISION');
    const r = this.apply({ type: 'MINIGAME_RESULT', seat, decisionId, score, logHash }, 'system', seat);
    if (!r.ok) return r;
    const rt = this.seatRts.get(seat);
    if (rt) rt.timeouts = 0;
    return ok({ score });
  }

  // ───────────────────────── 消息组装 ─────────────────────────

  private displayDeadline(dr: DecisionRt): number | null {
    if (this.pausedFlag) return null;
    const rt = this.seatRts.get(dr.d.seat);
    if (rt && rt.control === 'human' && !rt.connected) {
      return effectiveDeadline(dr.deadlineAt, rt.disconnectedAt, this.deps.settings().reconnectGraceSec * 1000);
    }
    return dr.deadlineAt;
  }

  pendingViews(): PendingView[] {
    return [...this.decisions.values()]
      .sort((a, b) => a.d.seat - b.d.seat || (a.d.id < b.d.id ? -1 : a.d.id > b.d.id ? 1 : 0))
      .map((dr) => ({
        decisionId: dr.d.id,
        seat: dr.d.seat,
        kind: dr.d.kind,
        timing: dr.d.timing,
        deadlineAt: this.displayDeadline(dr),
        control: this.seatRts.get(dr.d.seat)?.control ?? 'human',
        publicInfo: dr.d.publicInfo,
      }));
  }

  /** 本座位的决策（观战者永远拿不到） */
  decisionFor(seat: SeatIndex): YourDecision | undefined {
    for (const dr of this.decisions.values()) {
      if (dr.d.seat !== seat) continue;
      const out: YourDecision = {
        decisionId: dr.d.id,
        seat,
        kind: dr.d.kind,
        timing: dr.d.timing,
        options: dr.d.options,
        defaultIntent: dr.d.defaultIntent,
        deadlineAt: this.displayDeadline(dr),
      };
      if (dr.ticket) out.minigame = dr.ticket;
      return out;
    }
    return undefined;
  }

  private visibility(): { handVisibility: HandVisibility } {
    return { handVisibility: this.deps.settings().handVisibility };
  }

  viewFor(viewer: Viewer): GameView {
    return projectState(this.st, viewer, this.visibility());
  }

  classKey(viewer: Viewer): string {
    return viewerClassKey(viewer, this.visibility());
  }

  /**
   * 为一个 batch 生成按观察者组装的函数：view 与 events 按 viewerClassKey 缓存，pending 只算一次。
   * 必须在 hooks.batch 回调里同步调用（此时 state 就是这批之后的状态）。
   */
  composeBatch(raw: RawBatch): (viewer: Viewer) => GameBatchMsg {
    const pending = this.pendingViews();
    const serverNow = this.deps.clock.now();
    const cache = new Map<string, { view: GameView; events: GameEvent[] }>();
    const vis = this.visibility();
    return (viewer) => {
      const key = this.classKey(viewer);
      let c = cache.get(key);
      if (!c) {
        c = { view: this.viewFor(viewer), events: raw.events.map((e) => projectEvent(e, viewer, vis)) };
        cache.set(key, c);
      }
      const msg: GameBatchMsg = {
        epoch: this.epoch,
        seq: raw.seq,
        cause: raw.cause,
        events: c.events,
        animMs: raw.animMs,
        view: c.view,
        pending,
        serverNow,
      };
      const yd = viewer.kind === 'seat' ? this.decisionFor(viewer.seat) : undefined;
      if (yd) msg.yourDecision = yd;
      return msg;
    };
  }

  snapshotMsg(viewer: Viewer): GameSnapshotMsg {
    const msg: GameSnapshotMsg = {
      epoch: this.epoch,
      seq: this.seqNo,
      view: this.viewFor(viewer),
      pending: this.pendingViews(),
      serverNow: this.deps.clock.now(),
    };
    const yd = viewer.kind === 'seat' ? this.decisionFor(viewer.seat) : undefined;
    if (yd) msg.yourDecision = yd;
    return msg;
  }

  /** epoch 相同且 lastSeq 仍在环形缓冲内时返回补发消息，否则 null（应改发快照） */
  catchupMsg(viewer: Viewer, lastSeq: number, epoch: number): GameCatchupMsg | null {
    if (epoch !== this.epoch || lastSeq > this.seqNo || lastSeq < 0) return null;
    const raws = lastSeq === this.seqNo ? [] : this.ring.since(lastSeq);
    if (raws === null) return null;
    const vis = this.visibility();
    const msg: GameCatchupMsg = {
      epoch: this.epoch,
      batches: raws.map((r) => ({
        seq: r.seq,
        cause: r.cause,
        events: r.events.map((e) => projectEvent(e, viewer, vis)),
        animMs: r.animMs,
      })),
      seq: this.seqNo,
      view: this.viewFor(viewer),
      pending: this.pendingViews(),
      serverNow: this.deps.clock.now(),
    };
    const yd = viewer.kind === 'seat' ? this.decisionFor(viewer.seat) : undefined;
    if (yd) msg.yourDecision = yd;
    return msg;
  }

  pendingMsg(viewer: Viewer): PendingChangedMsg {
    const msg: PendingChangedMsg = {
      epoch: this.epoch,
      seq: this.seqNo,
      pending: this.pendingViews(),
      serverNow: this.deps.clock.now(),
    };
    const yd = viewer.kind === 'seat' ? this.decisionFor(viewer.seat) : undefined;
    if (yd) msg.yourDecision = yd;
    return msg;
  }

  gameOverMsg(result: GameResult | null = this.result): GameOverMsg {
    const r = result ?? {
      reason: 'lastStanding',
      code: 1,
      winner: null,
      date: this.st.clock.date,
      elapsedDays: this.st.clock.elapsedDays,
      ranking: [],
    };
    return { epoch: this.epoch, result: r, ranking: r.ranking.map((x) => ({ seat: x.seat, netWorth: x.netWorth })) };
  }
}
