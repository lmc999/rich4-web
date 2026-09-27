// 小游戏宿主（design/minigames-ai.md §7；client.md §9.2 按 architecture 修订）：
// - 全屏遮罩上一块 640×480 等比 letterbox 舞台：Pixi 画布 + 输入层 + React HUD（HostShell）；
// - FixedStepLoop 按 spec.tickMs 定步推进，时间轴对齐服务器时钟（targetTick = floor((serverNow − startsAt)/tickMs)，
//   每帧最多补 10 个 tick），渲染按 alpha 在相邻两个 tick 之间插值；
// - play：InputRecorder 记录输入（气球启用「最近 tick 归属」：α < 0.5 的点击记到上一个 tick 并回滚一步重算），
//   每 200ms 或 8 条上传一批（seq 0 表示已开局），结束后提交完整日志；本地分数只用于即时显示，以服务器结算为准；
// - spectate：SpectatorFeed 重组 game:minigameFrames，缓冲 300ms 后用同一个 sim 重放；2 秒没有新帧就定格；
//   收到 MINIGAME_ENDED 时快进到终局并显示权威分数；
// - replay：结算后拿到完整日志，2 倍速回顾。
// 结算画面停留 2 秒后关闭（企鹅可以点击提前关闭），回到棋盘。
import {
  clampScore,
  InputCode,
  type InputEvent,
  MINIGAME_SIMS,
  type MinigameSim,
  type MinigameTicket,
  type SimBase,
} from '@rich4/shared/minigames';
import type { MinigameInputMsg, MinigameSubmitMsg, Result } from '@rich4/shared/net';
import type { Application } from 'pixi.js';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadMinigameModule } from '../registry';
import { mgText } from '../text';
import type { HostMode, InputSink, MinigameClientModule, MinigameInput, MinigameView, Pt } from '../types';
import { STAGE_H, STAGE_W } from '../types';
import { FixedStepLoop } from './FixedStepLoop';
import { type HostPhase, HostShell, type HostSnapshot, type HostStore } from './HostShell';
import s from './host.module.css';
import { InputRecorder } from './InputRecorder';

/**
 * 销毁小游戏的 Pixi 应用：移除画布，但**不释放全局资源**。`destroy(true)` 会调用 GlobalResourceRegistry.release()，
 * 清空整个页面共享的批处理池（Batcher 的 Batch 池、纹理池），同页还活着的棋盘渲染器随后执行旧指令时报
 * 「Cannot read properties of null (reading 'geometry' / 'clear')」并停止渲染。
 */
const RENDERER_DESTROY = { removeView: true } as const;

import { type FeedFrame, SpectatorFeed } from './SpectatorFeed';

/** 结算画面停留 */
export const RESULT_MS = 2000;
/** replay 模式：开播前的等待与倍速 */
export const REPLAY_LEAD_MS = 1200;
export const REPLAY_SPEED = 2;
/** 提交被拒（过早、限流、断线）时的重试 */
const SUBMIT_RETRY_MS = 2100;
const SUBMIT_MAX_TRIES = 6;
/** rAF 被节流时的兜底驱动间隔 */
const FALLBACK_MS = 200;

export interface HostOptions {
  ticket: MinigameTicket;
  mode: HostMode;
  /** 服务器时间估计 */
  now(): number;
  playerName: string;
  characterId: number | null;
  /** play：上传一批输入 */
  sendInput?(msg: MinigameInputMsg): Promise<Result<void>>;
  /** play：提交完整日志 */
  submit?(msg: MinigameSubmitMsg): Promise<Result<{ score: number }>>;
  /** replay：完整日志 */
  log?: readonly InputEvent[];
  /** play 续玩：服务器已接受的自己的帧 */
  resumeFrames?: readonly FeedFrame[];
  /** 挂载点（缺省 document.body） */
  container?: HTMLElement;
  onClosed?(host: MiniGameHost): void;
  /** 本机单调时间（测试注入；缺省 performance.now） */
  clock?(): number;
  resultMs?: number;
  /** 不创建 Pixi（测试） */
  headless?: boolean;
  /**
   * play：房间是否暂停。暂停期间不开局、不推进、不收输入（显示「对局已暂停」）：开局前暂停，恢复后服务器换新会话；
   * 开局后暂停，恢复时服务器按暂停前已上传的输入结算。避免暂停期间本地「空跑」整局。
   */
  paused?(): boolean;
  /**
   * play：提前创建（倒计时期间加载模块与 Pixi），到这个服务器时间才显示遮罩；缺省立即显示。
   * 这样开局时画面已就绪，企鹅的记忆阶段（1 秒）不会被加载时间吃掉。
   */
  revealAt?: number;
}

function localClock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function errInfo(r: Result<unknown>): {
  code: string;
  reason?: string;
  expected?: number;
  logLength?: number;
  waitMs?: number;
} {
  if (r.ok) return { code: 'OK' };
  const d = (r.error.details ?? {}) as { reason?: unknown; expected?: unknown; logLength?: unknown; waitMs?: unknown };
  return {
    code: r.error.code,
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(typeof d.expected === 'number' ? { expected: d.expected } : {}),
    ...(typeof d.logLength === 'number' ? { logLength: d.logLength } : {}),
    ...(typeof d.waitMs === 'number' ? { waitMs: d.waitMs } : {}),
  };
}

function transient(code: string, reason?: string): boolean {
  return code === 'RATE_LIMITED' || code === 'GAME_PAUSED' || (code === 'INTERNAL' && reason !== undefined);
}

export class MiniGameHost implements HostStore {
  readonly ticket: MinigameTicket;
  readonly mode: HostMode;
  readonly sim: MinigameSim<SimBase>;
  readonly loop: FixedStepLoop<SimBase>;
  readonly recorder: InputRecorder | null;
  readonly feed: SpectatorFeed | null;
  private mod: MinigameClientModule<SimBase> | null = null;
  private app: Application | null = null;
  private view: MinigameView<SimBase> | null = null;
  private input: MinigameInput | null = null;
  private root: Root | null = null;
  private dom: {
    overlay: HTMLDivElement;
    stage: HTMLDivElement;
    canvasHost: HTMLDivElement;
    inputEl: HTMLDivElement;
    hud: HTMLDivElement;
  } | null = null;
  private readonly listeners = new Set<() => void>();
  private snap: HostSnapshot;
  private phase: HostPhase = 'loading';
  private destroyed = false;
  private ready = false;
  private readonly clock: () => number;
  private lastFrameAt = Number.NEGATIVE_INFINITY;
  private fallback: ReturnType<typeof setInterval> | null = null;
  private resizeObs: ResizeObserver | null = null;
  private cursorX: number | null = null;
  private lastCursor = -1;
  private finalScore: number | null = null;
  private endedAt: number | null = null;
  private submitting = false;
  private notice: string | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 服务器已接受过本页的输入批（续玩判定用） */
  private accepted = false;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  /** play：本帧房间处于暂停 */
  private pausedNow = false;
  private readonly closed: Promise<void>;
  private resolveClosed!: () => void;

  private constructor(private readonly o: HostOptions) {
    this.ticket = o.ticket;
    this.mode = o.mode;
    this.clock = o.clock ?? localClock;
    this.sim = MINIGAME_SIMS[o.ticket.minigameId] as MinigameSim<SimBase>;
    const replayMode = o.mode === 'replay';
    this.loop = new FixedStepLoop(this.sim, o.ticket.seed, o.ticket.params, {
      tickMs: replayMode ? o.ticket.tickMs / REPLAY_SPEED : o.ticket.tickMs,
      startsAt: replayMode ? o.now() + REPLAY_LEAD_MS : o.ticket.startsAt,
    });
    this.recorder = o.mode === 'play' ? new InputRecorder(this.sim.spec) : null;
    this.feed = o.mode === 'play' ? null : new SpectatorFeed(this.clock());
    if (replayMode && o.log) this.feed!.setComplete(o.log);
    if (this.recorder && o.resumeFrames && o.resumeFrames.length > 0) {
      this.recorder.restore(o.resumeFrames);
      this.accepted = this.recorder.seq > 0;
    }
    this.closed = new Promise((r) => {
      this.resolveClosed = r;
    });
    this.snap = this.buildSnapshot();
  }

  /** 建 DOM 与 HUD，异步加载游戏模块与 Pixi；返回时已开始驱动 */
  static open(o: HostOptions): MiniGameHost {
    const h = new MiniGameHost(o);
    h.mountDom();
    void h.init();
    return h;
  }

  /** 关闭时 resolve */
  whenClosed(): Promise<void> {
    return this.closed;
  }

  get isClosed(): boolean {
    return this.destroyed;
  }

  get sessionId(): string {
    return this.ticket.sessionId;
  }

  // ───────────────────────── 初始化 ─────────────────────────

  private mountDom(): void {
    if (typeof document === 'undefined') return;
    const el = (tag: 'div', cls: string): HTMLDivElement => {
      const d = document.createElement(tag);
      d.className = cls;
      return d;
    };
    const overlay = el('div', s.overlay!);
    overlay.dataset.testid = 'minigame-host';
    overlay.dataset.mode = this.mode;
    overlay.dataset.minigame = this.ticket.minigameId;
    overlay.dataset.session = this.ticket.sessionId;
    const stage = el('div', s.stage!);
    const canvasHost = el('div', s.canvasHost!);
    const inputEl = el('div', s.input!);
    inputEl.tabIndex = 0;
    inputEl.dataset.testid = 'minigame-input';
    const hud = el('div', s.hud!);
    stage.append(canvasHost, inputEl, hud);
    overlay.append(stage);
    (this.o.container ?? document.body).append(overlay);
    this.dom = { overlay, stage, canvasHost, inputEl, hud };
    const wait = this.o.revealAt === undefined ? 0 : this.o.revealAt - this.o.now();
    if (wait > 0) {
      overlay.hidden = true;
      this.revealTimer = setTimeout(() => this.reveal(), wait);
    }
    this.root = createRoot(hud);
    this.root.render(createElement(HostShell, { store: this, Hud: null }));
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.onResize());
      this.resizeObs.observe(stage);
    }
    this.onResize();
  }

  /** 显示遮罩（提前创建的宿主到开局时刻） */
  private reveal(): void {
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.revealTimer = null;
    if (!this.dom?.overlay.hidden) return;
    this.dom.overlay.hidden = false;
    this.onResize();
    if (this.mode === 'play' && this.ready) this.dom.inputEl.focus({ preventScroll: true });
  }

  get revealed(): boolean {
    return this.dom !== null && !this.dom.overlay.hidden;
  }

  private async init(): Promise<void> {
    try {
      this.mod = await loadMinigameModule(this.ticket.minigameId);
    } catch (err) {
      console.error('[minigame] 模块加载失败', err);
    }
    if (this.destroyed) return;
    if (this.dom && this.mod && !this.o.headless) {
      try {
        await this.createApp();
      } catch (err) {
        console.error('[minigame] 画面创建失败，只显示 HUD', err);
      }
    }
    if (this.destroyed) {
      this.destroyPixi();
      return;
    }
    if (this.dom && this.mod) {
      this.root?.render(createElement(HostShell, { store: this, Hud: this.mod.Hud }));
      this.input = this.mod.createInput({
        el: this.dom.inputEl,
        toStage: (x, y) => this.toStage(x, y),
        sink: this.sink,
        state: () => this.loop.curr,
        interactive: this.mode === 'play',
      });
      this.dom.inputEl.dataset.cursor =
        this.ticket.minigameId === 'xicong' && this.mode === 'play' ? 'none' : 'crosshair';
      if (this.mode === 'play') this.dom.inputEl.focus({ preventScroll: true });
    }
    this.ready = true;
    if (this.app) this.app.ticker.add(this.frame);
    this.fallback = setInterval(() => {
      if (this.clock() - this.lastFrameAt >= FALLBACK_MS) this.frame();
    }, FALLBACK_MS);
    this.frame();
  }

  private async createApp(): Promise<void> {
    const { Application } = await import('pixi.js');
    const app = new Application();
    await app.init({
      width: STAGE_W,
      height: STAGE_H,
      resolution: this.resolution(),
      autoDensity: false,
      antialias: true,
      preference: 'webgl',
      background: 0x10202c,
    });
    if (this.destroyed) {
      app.destroy(RENDERER_DESTROY, { children: true });
      return;
    }
    this.app = app;
    app.canvas.style.width = '100%';
    app.canvas.style.height = '100%';
    this.dom!.canvasHost.append(app.canvas);
    this.view = await this.mod!.createView({ app, characterId: this.o.characterId, mode: this.mode });
    if (this.destroyed) return;
    app.stage.addChild(this.view.root);
  }

  private resolution(): number {
    const w = this.dom?.stage.getBoundingClientRect().width || STAGE_W;
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
    return Math.max(0.5, Math.min(2, (dpr * w) / STAGE_W));
  }

  private onResize(): void {
    if (!this.dom) return;
    const w = this.dom.stage.getBoundingClientRect().width || STAGE_W;
    this.dom.stage.style.setProperty('--mg-scale', String(w / STAGE_W));
    if (this.app) this.app.renderer.resize(STAGE_W, STAGE_H, this.resolution());
  }

  /** 视口坐标 → 舞台整数坐标（夹到 640×480 以内） */
  toStage(clientX: number, clientY: number): Pt {
    const r = this.dom?.inputEl.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return { x: 0, y: 0 };
    const x = Math.floor(((clientX - r.left) * STAGE_W) / r.width);
    const y = Math.floor(((clientY - r.top) * STAGE_H) / r.height);
    return { x: Math.max(0, Math.min(STAGE_W - 1, x)), y: Math.max(0, Math.min(STAGE_H - 1, y)) };
  }

  // ───────────────────────── 输入 ─────────────────────────

  private get playing(): boolean {
    return this.mode === 'play' && this.phase === 'playing';
  }

  /** 输入适配器 → InputEvent（tick 归属在这里决定） */
  readonly sink: InputSink = {
    click: (p) => this.onClick(p),
    pick: (cell) => this.onPick(cell),
    cursor: (x) => {
      if (this.mode !== 'play') return;
      this.cursorX = Math.max(0, Math.min(STAGE_W - 1, Math.floor(x)));
    },
    hover: (p) => this.view?.setPointer(p),
  };

  private onPick(cell: number): void {
    const rec = this.recorder;
    if (!rec || !this.playing || cell < 0) return;
    const cur = this.loop.curr;
    if (!this.sim.accepting(cur)) return;
    rec.record([cur.tick, InputCode.PickCell, cell]);
  }

  private onClick(p: Pt): void {
    const rec = this.recorder;
    if (!rec || !this.playing) return;
    const cur = this.loop.curr;
    const t = cur.tick;
    const alpha = this.loop.alpha(this.o.now());
    // 最近 tick 归属：画面更接近上一个 tick（α < 0.5）时记到 t−1，并从上一步的状态重算
    if (
      this.sim.spec.rollbackAttribution &&
      alpha < 0.5 &&
      t >= 1 &&
      this.loop.prev.tick === t - 1 &&
      rec.canRecord(t - 1) &&
      this.sim.accepting(this.loop.prev)
    ) {
      if (rec.record([t - 1, InputCode.Click, p.x, p.y])) {
        this.loop.redoLast(rec.inputsAt(t - 1));
        if (!this.loop.canStep) this.finishPlay();
      }
      return;
    }
    if (this.sim.accepting(cur)) rec.record([t, InputCode.Click, p.x, p.y]);
  }

  /** 第 tick 次 step 之前：喜从天降的光标（只在变化时记一条） */
  private beforeStep(tick: number): void {
    const rec = this.recorder;
    if (!rec) return;
    this.input?.beforeTick?.();
    const x = this.cursorX;
    if (x !== null && x !== this.lastCursor && this.sim.spec.acceptedCodes.includes(InputCode.CursorX)) {
      if (rec.record([tick, InputCode.CursorX, x])) this.lastCursor = x;
    }
  }

  // ───────────────────────── 驱动 ─────────────────────────

  private readonly frame = (): void => {
    if (this.destroyed || !this.ready) return;
    const now = this.o.now();
    const local = this.clock();
    if (this.o.revealAt !== undefined && now >= this.o.revealAt && this.dom?.overlay.hidden) this.reveal();
    this.lastFrameAt = local;
    try {
      if (this.mode === 'play') this.framePlay(now, local);
      else this.frameWatch(now, local);
      this.render(now, local);
    } catch (err) {
      console.error('[minigame] 帧处理失败', err);
    }
    this.publish(now);
  };

  private framePlay(now: number, local: number): void {
    this.pausedNow = this.phase !== 'result' && this.o.paused?.() === true;
    if (this.pausedNow) {
      if (this.phase === 'playing') this.phase = 'waiting';
      else if (this.phase === 'loading') this.phase = 'countdown';
      return;
    }
    if (this.phase !== 'result') {
      if (now < this.loop.startsAt) {
        this.phase = 'countdown';
      } else if (this.phase !== 'playing' && this.notice === null) {
        this.phase = 'playing';
      }
      if (this.phase === 'playing') {
        this.loop.advance(
          now,
          (t) => this.recorder!.inputsAt(t),
          (t) => this.beforeStep(t),
        );
        if (!this.loop.canStep) this.finishPlay();
      }
    }
    this.pumpUpload(local);
  }

  private frameWatch(now: number, local: number): void {
    const feed = this.feed!;
    if (feed.takeRewind()) this.loop.rebuild(this.loop.curr.tick, (t) => feed.inputsAt(t));
    if (this.phase === 'result') return;
    const t = this.mode === 'replay' ? now : feed.bufferedNow(now);
    if (t < this.loop.startsAt && this.endedAt === null) {
      this.phase = 'countdown';
      return;
    }
    if (this.endedAt !== null) {
      // 结算已到：快进到终局
      while (this.loop.canStep) this.loop.step(feed.inputsAt(this.loop.curr.tick));
    } else {
      const target = this.loop.targetTick(t);
      if (target > this.loop.curr.tick && feed.stalled(local)) {
        this.phase = 'waiting';
        return;
      }
      this.phase = 'playing';
      this.loop.advanceTo(target, (k) => feed.inputsAt(k));
    }
    if (!this.loop.canStep) this.enterResult();
  }

  private render(now: number, local: number): void {
    if (!this.view) return;
    const t = this.mode === 'spectate' && this.feed ? this.feed.bufferedNow(now) : now;
    const alpha = this.phase === 'playing' ? this.loop.alpha(t) : 1;
    this.view.render(this.loop.prev, this.loop.curr, alpha, this.loop.drainFx(), local);
  }

  private pumpUpload(local: number): void {
    const rec = this.recorder;
    const send = this.o.sendInput;
    if (!rec || !send || this.phase === 'countdown' || this.phase === 'loading' || this.notice !== null) return;
    const b = rec.takeBatch(local, this.phase === 'result');
    if (!b) return;
    send({ sessionId: this.ticket.sessionId, seq: b.seq, events: b.events }).then(
      (r) => this.onUploaded(b.seq, r),
      () => rec.settle(b.seq, { ok: false, code: 'INTERNAL', transient: true }),
    );
  }

  private onUploaded(seq: number, r: Result<void>): void {
    const rec = this.recorder!;
    if (r.ok) {
      this.accepted = true;
      rec.settle(seq, { ok: true });
      return;
    }
    const e = errInfo(r);
    if (e.code === 'MINIGAME_INVALID' && e.reason === 'seq' && seq === 0 && !this.accepted && (e.expected ?? 0) > 0) {
      // 本局已由之前的页面开局，但没有收到续玩所需的帧：服务器会按已上传的输入结算
      this.lostResume();
      return;
    }
    rec.settle(seq, {
      ok: false,
      code: e.reason === 'seq' ? 'seq' : e.code,
      ...(e.expected !== undefined ? { expected: e.expected } : {}),
      ...(e.logLength !== undefined ? { logLength: e.logLength } : {}),
      transient: transient(e.code, e.reason),
    });
  }

  private lostResume(): void {
    this.notice = mgText('host.resumeLost');
    this.phase = 'waiting';
    this.scheduleClose(this.o.resultMs ?? RESULT_MS);
    this.publish(this.o.now());
  }

  private finishPlay(): void {
    if (this.phase === 'result') return;
    this.enterResult();
    void this.submitLoop();
  }

  private enterResult(): void {
    if (this.phase === 'result') return;
    this.phase = 'result';
    if (this.mode === 'replay') this.finalScore = clampScore(this.sim, this.loop.curr);
    this.scheduleClose(this.o.resultMs ?? RESULT_MS);
  }

  private async submitLoop(): Promise<void> {
    const submit = this.o.submit;
    const rec = this.recorder;
    if (!submit || !rec) return;
    this.submitting = true;
    const cur = this.loop.curr;
    for (let i = 0; i < SUBMIT_MAX_TRIES; i++) {
      const msg: MinigameSubmitMsg = {
        sessionId: this.ticket.sessionId,
        inputs: rec.log.slice(),
        claimedScore: clampScore(this.sim, cur),
        finalHash: this.sim.hash(cur),
        clientElapsedMs: Math.max(0, Math.round(this.o.now() - this.ticket.startsAt)),
      };
      let r: Result<{ score: number }>;
      try {
        r = await submit(msg);
      } catch {
        r = { ok: false, error: { code: 'INTERNAL', message: 'network', details: { reason: 'network' } } };
      }
      if (r.ok) {
        this.finalScore = r.data.score;
        this.submitting = false;
        this.publish(this.o.now());
        return;
      }
      const e = errInfo(r);
      if (e.code !== 'MINIGAME_TOO_EARLY' && !transient(e.code, e.reason)) break;
      await new Promise((res) => setTimeout(res, Math.max(SUBMIT_RETRY_MS, e.waitMs ?? 0)));
      if (this.endedAt !== null) break;
    }
    this.submitting = this.endedAt === null;
    this.publish(this.o.now());
  }

  private scheduleClose(ms: number): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.close(), ms);
  }

  // ───────────────────────── 外部事件 ─────────────────────────

  /** 观战：收到一帧 */
  pushFrame(f: FeedFrame): void {
    if (!this.feed || this.mode !== 'spectate') return;
    this.feed.push(f, this.clock(), this.loop.curr.tick);
  }

  /**
   * 服务器结算（本局座位的 MINIGAME_ENDED）：skipped → 立即关闭；played → 显示权威分数（观战快进到终局），
   * 从此刻起再停留 2 秒。
   */
  authoritative(mode: 'played' | 'skipped', score: number): void {
    if (this.destroyed) return;
    if (mode === 'skipped') {
      this.close();
      return;
    }
    this.finalScore = score;
    this.submitting = false;
    this.endedAt = this.clock();
    if (this.feed) this.feed.complete = true;
    if (this.mode === 'play' && this.phase !== 'result') {
      // 本地还没结束（例如服务器按到期结算）：直接进结算画面
      this.phase = 'result';
    }
    this.scheduleClose(this.o.resultMs ?? RESULT_MS);
    this.frame();
  }

  // ───────────────────────── HostStore ─────────────────────────

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): HostSnapshot => this.snap;

  dismiss = (): void => {
    if (this.mode !== 'play' || (this.phase === 'result' && this.snap.skippable)) this.close();
  };

  private buildSnapshot(now = this.o.now()): HostSnapshot {
    const cur = this.loop.curr;
    const local = clampScore(this.sim, cur);
    return {
      phase: this.phase,
      mode: this.mode,
      minigameId: this.ticket.minigameId,
      sessionId: this.ticket.sessionId,
      playerName: this.o.playerName,
      state: cur,
      tick: cur.tick,
      countdownMs: Math.max(
        0,
        this.loop.startsAt - (this.mode === 'spectate' && this.feed ? this.feed.bufferedNow(now) : now),
      ),
      localScore: local,
      finalScore: this.finalScore,
      submitting: this.submitting,
      poseKey: this.phase === 'result' && this.mod ? this.mod.poseKey(cur, this.finalScore ?? local) : null,
      notice: this.notice,
      paused: this.pausedNow,
      skippable: this.mode === 'play' && this.ticket.minigameId === 'penguin',
    };
  }

  private publish(now: number): void {
    const next = this.buildSnapshot(now);
    const p = this.snap;
    const same =
      p.phase === next.phase &&
      p.state === next.state &&
      p.tick === next.tick &&
      Math.ceil(p.countdownMs / 1000) === Math.ceil(next.countdownMs / 1000) &&
      p.localScore === next.localScore &&
      p.finalScore === next.finalScore &&
      p.submitting === next.submitting &&
      p.notice === next.notice &&
      p.paused === next.paused &&
      p.poseKey === next.poseKey;
    if (same) return;
    this.snap = next;
    if (this.dom) {
      this.dom.overlay.dataset.phase = next.phase;
      this.dom.overlay.dataset.tick = String(next.tick);
    }
    for (const cb of [...this.listeners]) cb();
  }

  // ───────────────────────── 关闭 ─────────────────────────

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.phase = 'closed';
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.revealTimer) clearTimeout(this.revealTimer);
    if (this.fallback) clearInterval(this.fallback);
    this.resizeObs?.disconnect();
    try {
      this.input?.destroy();
    } catch (err) {
      console.error('[minigame] input destroy failed', err);
    }
    this.destroyPixi();
    const root = this.root;
    this.root = null;
    // React root 在下一轮卸载（close 可能发生在 React 渲染期间，例如 HUD 按钮的点击回调）
    setTimeout(() => root?.unmount(), 0);
    this.dom?.overlay.remove();
    this.dom = null;
    this.resolveClosed();
    this.o.onClosed?.(this);
  }

  private destroyPixi(): void {
    const app = this.app;
    this.app = null;
    try {
      if (app) app.ticker.remove(this.frame);
      this.view?.destroy();
      this.view = null;
      app?.destroy(RENDERER_DESTROY, { children: true });
    } catch (err) {
      console.error('[minigame] pixi destroy failed', err);
    }
  }

  // ───────────────────────── 测试钩子 ─────────────────────────

  /** 手动推进一帧（测试；正常由 Pixi ticker 与兜底定时器驱动） */
  pump(): void {
    this.frame();
  }

  /** 已加载游戏模块并开始驱动 */
  get isReady(): boolean {
    return this.ready;
  }

  /** 测试与调试：当前状态的 JSON 快照 */
  debugState(): {
    mode: HostMode;
    phase: HostPhase;
    minigameId: string;
    sessionId: string;
    tick: number;
    over: boolean;
    localScore: number;
    finalScore: number | null;
    logLength: number;
    uploaded: number;
    state: unknown;
  } {
    const cur = this.loop.curr;
    return {
      mode: this.mode,
      phase: this.phase,
      minigameId: this.ticket.minigameId,
      sessionId: this.ticket.sessionId,
      tick: cur.tick,
      over: this.sim.isOver(cur),
      localScore: clampScore(this.sim, cur),
      finalScore: this.finalScore,
      logLength: this.recorder?.log.length ?? this.feed?.log.length ?? 0,
      uploaded: this.recorder?.uploaded ?? 0,
      state: JSON.parse(JSON.stringify(cur)) as unknown,
    };
  }
}
