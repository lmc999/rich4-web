// 事件动画队列（design/client.md §4.3，按 architecture §5.8、§6.2 修订）：
// - enqueue(GameBatchMsg)：epoch 不同或 seq ≠ lastSeq+1 → 丢弃并发 game:resync（等快照期间静默丢弃）；seq ≤ lastSeq 视为重复；
// - 串行播放：每个事件 await handler → view = applyPostPatch(view, e.post) → 提交显示态（HUD 在这一刻变化）；
// - 批尾：开发模式下断言 fold 结果与 batch.view 深度相等（不等则告警），然后以 batch.view 为准、同步棋盘、
//   提交 pending / yourDecision（决策框只在动画播完后出现）；
// - 追帧：积压 > 6s 自动 3 倍速；> 15s 或队列 > 5 批直接 skipAll；catchup（≤ 8 批）以 2–4 倍速播放，否则 reset；
//   积压 = 最新一批到达之前还没播完的部分（单独一批很长，例如月初结算，既不跳过也不自动加速）；
// - 中止（reset / skipAll / dispose / 切到 instant）：当前 handler 与最近几个 handler 留下的不阻塞尾巴一并中止，
//   abortEpoch +1（GameClient 据此让旧上下文失效，被中止的收尾不会再写棋盘）；
// - instant（?anim=instant 或后台标签页）：不调 handler，只提交；TIME_REWOUND（resetsView）直接用批尾 view。

import { EVENT_META, type GameEvent } from '@rich4/shared/engine';
import {
  type BatchCause,
  CATCHUP_FAST_MAX,
  type GameCatchupMsg,
  type PendingChangedMsg,
  type YourDecision,
} from '@rich4/shared/net';
import { applyPostPatch, eventBudgetMs, type GameView, type PendingView } from '@rich4/shared/view';
import type { AnyHandler, HandlerMap, PresentationContext } from './types';

export const AUTO_FAST_BACKLOG_MS = 6_000;
export const AUTO_SKIP_BACKLOG_MS = 15_000;
export const AUTO_SKIP_QUEUE = 5;
export const AUTO_FAST_SPEED = 3;
/** 中止时连同处理的最近 handler 数（不阻塞的尾巴最长约 2 秒） */
const RECENT_HANDLER_CTLS = 16;
/** handler 超过预算 10% 时（开发模式）告警 */
export const BUDGET_TOLERANCE = 1.1;

export interface BatchInput {
  epoch: number;
  seq: number;
  events: GameEvent[];
  animMs: number;
  view: GameView;
  pending: PendingView[];
  yourDecision?: YourDecision;
  serverNow?: number;
  cause?: BatchCause;
}

export interface SnapshotInput {
  epoch: number;
  seq: number;
  view: GameView;
  pending: PendingView[];
  yourDecision?: YourDecision;
}

interface QueuedBatch {
  epoch: number;
  seq: number;
  events: GameEvent[];
  animMs: number;
  /** catchup 中间批次没有 view / pending（只有最后一批带） */
  view: GameView | null;
  pending: PendingView[] | null;
  decision: YourDecision | null;
  cause: BatchCause | null;
  /** catchup 批次的倍速 */
  boost: number;
}

/** 提交到 store 的出口 */
export interface EventPlayerSink {
  reset(s: { epoch: number; seq: number; view: GameView; pending: PendingView[]; decision: YourDecision | null }): void;
  /**
   * 一批开始播放：上一批留下的决策与等待条已经过时（本批就是它的结果），先收起。
   * next 为本批播完后的新决策：同一座位连续重发的同种决策（回合菜单做完股票交易、商店每笔交易）可以保留旧框
   * （已提交、处于锁定状态），避免对话框与已打开的子页被卸载重建。
   */
  beginBatch?(seq: number, next: YourDecision | null): void;
  commitView(view: GameView, e: GameEvent, seq: number): void;
  commitBatch(b: {
    epoch: number;
    seq: number;
    view: GameView;
    pending: PendingView[];
    decision: YourDecision | null;
    cause: BatchCause | null;
  }): void;
  commitPending(pending: PendingView[], decision: YourDecision | null): void;
  setAnim(a: { playing: boolean; backlogMs: number; speed: number; instant: boolean }): void;
}

/** 动画时钟的最小接口（AnimClock 满足） */
export interface PlayerClock {
  speed: number;
  instant: boolean;
  now(): number;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  flushAll(): void;
}

export interface Timers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface EventPlayerOptions {
  handlers: HandlerMap;
  sink: EventPlayerSink;
  clock: PlayerClock;
  /** 为一次 handler 调用构造上下文 */
  context(signal: AbortSignal, view: () => GameView): PresentationContext;
  /** 发 game:resync（服务器回 game:snapshot → reset） */
  requestResync(): void;
  /** 批尾与 reset 后：棋盘按 view 整体同步 */
  syncBoard?(view: GameView): void;
  /** reset / skipAll：清特效、关闭临时弹层 */
  onAbort?(): void;
  /** 开发模式：批尾 deepEqual 对账、handler 超预算告警 */
  dev?: boolean;
  warn?(msg: string, detail?: unknown): void;
  /** 批尾对账不一致（缺省走 warn）；测试构建接到 console.error，E2E 据此判失败（client.md §4.3） */
  error?(msg: string, detail?: unknown): void;
  /** 单个 handler 的真实时间上限（毫秒，0 关闭），防止演出卡死队列 */
  maxHandlerMs?: number;
  timers?: Timers;
  /** 用户选择的基础倍速 1/2/3 */
  baseSpeed?: number;
}

const defaultTimers: Timers = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class EventPlayer {
  private epoch: number | null = null;
  private lastSeq = 0;
  private view: GameView | null = null;
  private readonly queue: QueuedBatch[] = [];
  private current: QueuedBatch | null = null;
  private currentStart = 0;
  private running = false;
  private gen = 0;
  private abortCtl: AbortController | null = null;
  /** 最近几个 handler 的中止控制器：handler 结束后不阻塞的尾巴（横幅、离场、金币）仍用它，中止时一并中止 */
  private readonly recentCtls: AbortController[] = [];
  private epochOfAbort = 0;
  private awaitingSnapshot = false;
  private skipping = false;
  private userInstant = false;
  private hidden = false;
  private baseSpeed: number;
  private pendingOverride: { seq: number; pending: PendingView[]; decision: YourDecision | null } | null = null;
  private readonly idleWaiters = new Set<() => void>();
  private readonly timers: Timers;

  constructor(private readonly o: EventPlayerOptions) {
    this.baseSpeed = o.baseSpeed ?? 1;
    this.timers = o.timers ?? defaultTimers;
  }

  // ───────────────────────── 状态 ─────────────────────────

  get currentEpoch(): number | null {
    return this.epoch;
  }

  /** 每次中止演出（reset / skipAll / dispose / 切到 instant）+1；handler 上下文据此判断是否已失效 */
  get abortEpoch(): number {
    return this.epochOfAbort;
  }

  /** 最后一个已接收（入队）的 seq；room:resume 用它 */
  get receivedSeq(): number {
    return this.lastSeq;
  }

  get displayView(): GameView | null {
    return this.view;
  }

  /** 没有正在播放或排队的批次 */
  get idle(): boolean {
    return !this.running && this.queue.length === 0;
  }

  get queued(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  get instant(): boolean {
    return this.userInstant || this.hidden;
  }

  /** 剩余动画估计（ms，1x）：当前批剩余 + 队列 */
  get backlogMs(): number {
    let ms = 0;
    for (const b of this.queue) ms += b.animMs;
    if (this.current) {
      const elapsed = Math.max(0, (this.o.clock.now() - this.currentStart) / Math.max(1, this.o.clock.speed));
      ms += Math.max(0, this.current.animMs - elapsed);
    }
    return Math.round(ms);
  }

  /** 等到空闲（测试钩子与 E2E 用） */
  whenIdle(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  // ───────────────────────── 输入 ─────────────────────────

  /** 快照：直达（加入、重连、resync、读档、切回前台） */
  reset(s: SnapshotInput): void {
    this.gen++;
    this.abortCurrent();
    this.queue.length = 0;
    this.current = null;
    this.skipping = false;
    this.awaitingSnapshot = false;
    this.pendingOverride = null;
    this.epoch = s.epoch;
    this.lastSeq = s.seq;
    this.view = s.view;
    this.o.clock.flushAll();
    this.o.onAbort?.();
    this.o.syncBoard?.(s.view);
    this.o.sink.reset({
      epoch: s.epoch,
      seq: s.seq,
      view: s.view,
      pending: s.pending,
      decision: s.yourDecision ?? null,
    });
    this.applySpeed();
    this.publishAnim();
    this.notifyIdle();
  }

  enqueue(b: BatchInput): void {
    if (this.epoch === null || b.epoch !== this.epoch) {
      this.gap();
      return;
    }
    if (b.seq <= this.lastSeq) return; // 重复
    if (this.awaitingSnapshot) return;
    if (b.seq !== this.lastSeq + 1) {
      this.gap();
      return;
    }
    this.lastSeq = b.seq;
    this.queue.push({
      epoch: b.epoch,
      seq: b.seq,
      events: b.events,
      animMs: b.animMs,
      view: b.view,
      pending: b.pending,
      decision: b.yourDecision ?? null,
      cause: b.cause ?? null,
      boost: 1,
    });
    this.afterEnqueue();
  }

  /** 短断线后的补发：≤ CATCHUP_FAST_MAX 批以 2–4 倍速补播，否则直接 reset */
  catchup(m: GameCatchupMsg): void {
    const asSnap: SnapshotInput = { epoch: m.epoch, seq: m.seq, view: m.view, pending: m.pending };
    if (m.yourDecision) asSnap.yourDecision = m.yourDecision;
    if (this.epoch === null || m.epoch !== this.epoch || this.view === null) {
      this.reset(asSnap);
      return;
    }
    const fresh = m.batches.filter((b) => b.seq > this.lastSeq);
    if (fresh.length === 0) {
      if (m.seq > this.lastSeq) this.reset(asSnap);
      else this.applyPending({ epoch: m.epoch, seq: m.seq, pending: m.pending, yourDecision: m.yourDecision });
      return;
    }
    const contiguous = fresh.every((b, i) => b.seq === this.lastSeq + 1 + i) && fresh.at(-1)!.seq === m.seq;
    if (fresh.length > CATCHUP_FAST_MAX || !contiguous) {
      this.reset(asSnap);
      return;
    }
    this.awaitingSnapshot = false;
    const boost = Math.min(4, Math.max(2, Math.ceil(fresh.length / 2) + 1));
    fresh.forEach((b, i) => {
      const last = i === fresh.length - 1;
      this.queue.push({
        epoch: m.epoch,
        seq: b.seq,
        events: b.events,
        animMs: b.animMs,
        view: last ? m.view : null,
        pending: last ? m.pending : null,
        decision: last ? (m.yourDecision ?? null) : null,
        cause: b.cause,
        boost,
      });
    });
    this.lastSeq = m.seq;
    this.afterEnqueue();
  }

  /** game:pending：截止时间或托管变化（没有新 action）；在对应批次播完后才生效 */
  applyPending(m: Pick<PendingChangedMsg, 'epoch' | 'seq' | 'pending'> & { yourDecision?: YourDecision }): void {
    if (this.epoch === null || m.epoch !== this.epoch) return;
    if (m.seq > this.lastSeq) {
      this.gap();
      return;
    }
    if (m.seq < this.lastSeq) return; // 过期：之后的批次自带 pending
    const decision = m.yourDecision ?? null;
    if (this.idle) this.o.sink.commitPending(m.pending, decision);
    else this.pendingOverride = { seq: m.seq, pending: m.pending, decision };
  }

  // ───────────────────────── 控制 ─────────────────────────

  /** 中止当前 handler、清空积压，直达最新 view */
  skipAll(): void {
    if (this.idle) return;
    this.skipping = true;
    this.abortCurrent();
    this.o.clock.flushAll();
    this.o.onAbort?.();
    this.publishAnim();
  }

  setSpeed(s: number): void {
    this.baseSpeed = s > 0 ? s : 1;
    this.applySpeed();
    this.publishAnim();
  }

  /** ?anim=instant：只提交不播放 */
  setInstant(on: boolean): void {
    this.userInstant = on;
    this.onInstantChanged();
  }

  /** 后台标签页：rAF 暂停，切到 instant，回到前台后恢复 */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.onInstantChanged();
  }

  /** 离开房间：清空一切 */
  dispose(): void {
    this.gen++;
    this.abortCurrent();
    this.queue.length = 0;
    this.current = null;
    this.epoch = null;
    this.lastSeq = 0;
    this.view = null;
    this.pendingOverride = null;
    this.awaitingSnapshot = false;
    this.publishAnim();
    this.notifyIdle();
  }

  // ───────────────────────── 内部 ─────────────────────────

  private gap(): void {
    if (this.awaitingSnapshot) return;
    this.awaitingSnapshot = true;
    this.o.requestResync();
  }

  private onInstantChanged(): void {
    this.o.clock.instant = this.instant;
    if (this.instant) {
      this.abortCurrent();
      this.o.clock.flushAll();
    }
    this.publishAnim();
  }

  private afterEnqueue(): void {
    if (this.queue.length > AUTO_SKIP_QUEUE || this.behindMs > AUTO_SKIP_BACKLOG_MS) this.skipAll();
    else this.applySpeed();
    this.publishAnim();
    void this.pump();
  }

  /**
   * 落后量：最新一批到达之前还没播完的部分（积压减去最新一批）。单独一批很长（月初结算）不算落后：
   * 既不跳过、也不自动加速（否则 1x 下月初的乐透开奖等演出总是被 3 倍速压缩）。
   */
  private get behindMs(): number {
    const newest = this.queue.at(-1);
    return newest ? this.backlogMs - newest.animMs : 0;
  }

  private applySpeed(): void {
    let s = this.baseSpeed;
    const boost = this.current?.boost ?? 1;
    if (boost > s) s = boost;
    if (this.behindMs > AUTO_FAST_BACKLOG_MS && s < AUTO_FAST_SPEED) s = AUTO_FAST_SPEED;
    if (this.o.clock.speed !== s) this.o.clock.speed = s;
  }

  private publishAnim(): void {
    this.o.sink.setAnim({
      playing: !this.idle,
      backlogMs: this.idle ? 0 : this.backlogMs,
      speed: this.o.clock.speed,
      instant: this.instant,
    });
  }

  private abortCurrent(): void {
    this.epochOfAbort++;
    const c = this.abortCtl;
    this.abortCtl = null;
    c?.abort();
    for (const x of this.recentCtls.splice(0)) x.abort();
  }

  private notifyIdle(): void {
    if (!this.idle) return;
    for (const w of [...this.idleWaiters]) w();
    this.idleWaiters.clear();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const b = this.queue.shift()!;
        const gen = this.gen;
        this.current = b;
        this.currentStart = this.o.clock.now();
        this.applySpeed();
        this.publishAnim();
        await this.playBatch(b, gen);
        if (gen === this.gen) this.current = null;
        if (this.queue.length === 0) this.skipping = false;
      }
    } finally {
      this.running = false;
      this.current = null;
      this.skipping = false;
      this.applySpeed();
      this.publishAnim();
      this.notifyIdle();
    }
  }

  private async playBatch(b: QueuedBatch, gen: number): Promise<void> {
    let view = this.view;
    if (!view) return;
    let jumped = false;
    if (b.events.length > 0 && !this.instant && !this.skipping) this.o.sink.beginBatch?.(b.seq, b.decision);
    for (const e of b.events) {
      if (gen !== this.gen) return;
      if (!this.instant && !this.skipping) {
        await this.runHandler(e, view);
        if (gen !== this.gen) return;
      }
      view = applyPostPatch(view, e.post);
      this.view = view;
      this.o.sink.commitView(view, e, b.seq);
      if ('resetsView' in EVENT_META[e.type] && b.view) {
        jumped = true;
        break;
      }
    }
    if (gen !== this.gen) return;
    if (!b.view) return; // catchup 中间批次
    if (this.o.dev && !jumped) {
      const diff = firstDiff(view, b.view);
      if (diff !== null) {
        const report = this.o.error ?? this.o.warn;
        report?.(`[EventPlayer] seq ${b.seq} 批尾对账不一致：${diff}`, { folded: view, view: b.view });
      }
    }
    this.view = b.view;
    this.o.syncBoard?.(b.view);
    const ov = this.pendingOverride && this.pendingOverride.seq === b.seq ? this.pendingOverride : null;
    if (ov) this.pendingOverride = null;
    this.o.sink.commitBatch({
      epoch: b.epoch,
      seq: b.seq,
      view: b.view,
      pending: ov ? ov.pending : (b.pending ?? []),
      decision: ov ? ov.decision : b.decision,
      cause: b.cause,
    });
  }

  private async runHandler(e: GameEvent, before: GameView): Promise<void> {
    const handler = this.o.handlers[e.type] as unknown as AnyHandler | undefined;
    if (!handler) return;
    const ac = new AbortController();
    this.abortCtl = ac;
    this.recentCtls.push(ac);
    if (this.recentCtls.length > RECENT_HANDLER_CTLS) this.recentCtls.shift();
    const t0 = this.o.clock.now();
    let watchdog: unknown = null;
    try {
      const ctx = this.o.context(ac.signal, () => before);
      const run = handler(e, ctx);
      const max = this.o.maxHandlerMs ?? 0;
      if (max > 0) {
        await Promise.race([
          run,
          new Promise<void>((resolve) => {
            watchdog = this.timers.setTimeout(() => {
              this.o.warn?.(`[EventPlayer] ${e.type} 超过 ${max}ms 未结束，已中止`);
              ac.abort();
              resolve();
            }, max);
          }),
        ]);
      } else {
        await run;
      }
    } catch (err) {
      this.o.warn?.(`[EventPlayer] ${e.type} handler 出错`, err);
    } finally {
      if (watchdog !== null) this.timers.clearTimeout(watchdog);
      if (this.abortCtl === ac) this.abortCtl = null;
    }
    if (this.o.dev && !ac.signal.aborted && !this.skipping && !this.instant) {
      const budget = eventBudgetMs(e);
      const used = this.o.clock.now() - t0;
      if (used > budget * BUDGET_TOLERANCE + 50) {
        this.o.warn?.(`[EventPlayer] ${e.type} 用时 ${Math.round(used)}ms，超过预算 ${budget}ms`);
      }
    }
  }
}

/** JSON 值深度比较；返回第一处不同的路径（相同返回 null） */
export function firstDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return `${path}: ${short(a)} ≠ ${short(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: 类型不同`;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return `${path}.length: ${a.length} ≠ ${bb.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], bb[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    // undefined 与缺失视为相同（JSON 语义）
    if (ao[k] === undefined && bo[k] === undefined) continue;
    const d = firstDiff(ao[k], bo[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

function short(x: unknown): string {
  const s = JSON.stringify(x);
  return s === undefined ? String(x) : s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
