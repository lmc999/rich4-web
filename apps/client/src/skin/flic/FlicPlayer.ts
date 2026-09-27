// FLIC 播放器（design-draft §3.1、§3.5）：逐帧解码到一块可复用的 RGBA 缓冲，再画到同一张画布（或交给 Pixi 纹理），
// 由动画时钟驱动（倍速、instant、AbortSignal 与演出一致）。
// - show(frame)：解码到某帧并呈现（必要时从头重解；循环帧不作为呈现帧）；
// - play({loop, signal, range})：原速播放区间，loop 时循环到中止；
// - playFit(budgetMs)：按目标时长加速或截取（fit.ts），中止时直接落到终态（最后一个计划帧）；
// - onStart 在首帧呈现时调用（原版 0x452a83 在首帧播同步音效）；onFrame 在每次呈现后调用（Pixi 侧 texture.source.update()）；
// - destroy()：释放 RGBA 与索引缓冲、解码器，以及播放器自己建的画布（宽高置 0：iOS Safari 的画布内存有总额上限，
//   只丢引用不会及时回收）；调用方传入的 sink / 画布由调用方负责。

import { FlcDecoder, type FlcFile, flcFrameDelay, parseFlc } from './FlcDecoder';
import { type FitOptions, type FitPlan, planFit } from './fit';

/** 播放器用到的时钟接口（AnimClock 满足）；instant 为 true 时直接落到终态 */
export interface FlicClock {
  now(): number;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  readonly instant?: boolean;
}

/** 呈现目标：接收当前帧的 RGBA（缓冲会被复用，需要保留时自行复制） */
export interface FlicFrameSink {
  present(rgba: Uint8ClampedArray, w: number, h: number, frame: number): void;
}

type Canvas2D = HTMLCanvasElement | OffscreenCanvas;

/** 画到一张复用画布：同一个 ImageData 包着播放器的 RGBA 缓冲，每帧 putImageData（不重新分配） */
export class CanvasFrameSink implements FlicFrameSink {
  readonly canvas: Canvas2D;
  private readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private image: ImageData | null = null;
  /** 画布是本 sink 建的（release 时可以把宽高置 0） */
  private readonly ownsCanvas: boolean;
  private released = false;

  constructor(w: number, h: number, canvas?: Canvas2D) {
    this.ownsCanvas = canvas === undefined;
    const c = canvas ?? CanvasFrameSink.createCanvas(w, h);
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('无法创建 2D 画布上下文');
    this.canvas = c;
    this.ctx = ctx;
  }

  static createCanvas(w: number, h: number): Canvas2D {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    throw new Error('当前环境没有 canvas');
  }

  present(rgba: Uint8ClampedArray, w: number, h: number): void {
    if (this.released) return;
    if (!this.image || this.image.data !== rgba) {
      this.image = new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h);
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  /** 释放：丢掉 ImageData（它包着播放器的 RGBA 缓冲）；自己建的画布宽高置 0，让浏览器及时回收画布内存 */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.image = null;
    if (this.ownsCanvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
  }
}

export interface FlicPlayerOptions {
  clock: FlicClock;
  /** 不透明（原版 Panel#16、Panel#20、jump#42）；缺省 false：索引 0 透明 */
  opaque?: boolean;
  /** 呈现目标；缺省建一张画布（CanvasFrameSink） */
  sink?: FlicFrameSink;
  /** 每次呈现之后 */
  onFrame?(frame: number): void;
  /** 一次播放的首帧呈现时（同步音效） */
  onStart?(): void;
  label?: string;
}

export interface PlayOptions {
  signal?: AbortSignal;
  /** 循环播放直到中止 */
  loop?: boolean;
  /** 播放区间（帧号，含 start、不含 end）；缺省全部帧 */
  range?: { start: number; end: number };
}

export interface PlayFitOptions extends FitOptions {
  signal?: AbortSignal;
  /** 可截取区间（flic-map 的 trim） */
  trim?: { startFrame: number; endFrame: number } | null;
}

export class FlicPlayer {
  readonly flc: FlcFile;
  readonly width: number;
  readonly height: number;
  /** 呈现帧数（不含循环帧） */
  readonly frames: number;
  /** 文件头帧间隔（ms） */
  readonly frameMs: number;
  readonly opaque: boolean;
  readonly sink: FlicFrameSink;
  private dec: FlcDecoder | null;
  private rgba: Uint8ClampedArray<ArrayBuffer>;
  /** sink 是播放器自己建的（destroy 时释放） */
  private readonly ownsSink: boolean;
  private shown = -1;
  private destroyed = false;

  constructor(
    src: FlcFile | ArrayBuffer | ArrayBufferView,
    private readonly o: FlicPlayerOptions,
  ) {
    this.flc = isFlcFile(src) ? src : parseFlc(src, o.label);
    this.width = this.flc.width;
    this.height = this.flc.height;
    this.frames = this.flc.frames;
    this.frameMs = flcFrameDelay(this.flc, 0);
    this.opaque = o.opaque === true;
    this.dec = new FlcDecoder(this.flc);
    this.rgba = new Uint8ClampedArray(this.width * this.height * 4);
    this.ownsSink = o.sink === undefined;
    this.sink = o.sink ?? new CanvasFrameSink(this.width, this.height);
  }

  /** 已销毁 */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** 画布（CanvasFrameSink 时）；自定义 sink 为 null */
  get canvas(): Canvas2D | null {
    return this.sink instanceof CanvasFrameSink ? this.sink.canvas : null;
  }

  /** 当前呈现的帧号（未呈现为 -1） */
  get currentFrame(): number {
    return this.shown;
  }

  /** 原版时长（ms） */
  get durationMs(): number {
    let ms = 0;
    for (let i = 0; i < this.frames; i++) ms += flcFrameDelay(this.flc, i);
    return ms;
  }

  /** 当前帧的 RGBA（复用缓冲；销毁后为空数组） */
  get pixels(): Uint8ClampedArray {
    return this.rgba;
  }

  /** 解码到帧 frame（0..frames−1）并呈现 */
  show(frame: number): void {
    const dec = this.dec;
    if (this.destroyed || !dec || this.frames === 0) return;
    const f = Math.max(0, Math.min(this.frames - 1, Math.trunc(frame)));
    dec.seek(f);
    dec.toRgba(this.rgba, this.opaque);
    this.shown = f;
    this.sink.present(this.rgba, this.width, this.height, f);
    this.o.onFrame?.(f);
  }

  /** 按计划播放；中止时（非循环）落到计划的最后一帧 */
  async playPlan(plan: FitPlan, signal?: AbortSignal): Promise<void> {
    if (plan.frames.length === 0) return;
    const clock = this.o.clock;
    const t0 = clock.now();
    // instant（?anim=instant、后台标签页）或已中止：不播放、不发同步音效，直接落到终态
    const instant = (): boolean => clock.instant === true;
    for (let k = 0; k < plan.frames.length; k++) {
      if (this.destroyed) return;
      if (signal?.aborted || instant()) break;
      this.show(plan.frames[k]!);
      if (k === 0) this.o.onStart?.();
      const due = t0 + (k + 1) * plan.frameMs - clock.now();
      if (due > 0) await clock.wait(due, signal);
    }
    const last = plan.frames.at(-1)!;
    if (!this.destroyed && this.shown !== last) this.show(last);
  }

  /** 原速播放（帧间隔按各帧块 delay）；loop 时循环到 signal 中止 */
  async play(opts: PlayOptions = {}): Promise<void> {
    const start = Math.max(0, Math.min(this.frames, opts.range?.start ?? 0));
    const end = Math.max(start, Math.min(this.frames, opts.range?.end ?? this.frames));
    if (end <= start) return;
    const clock = this.o.clock;
    const signal = opts.signal;
    let first = true;
    for (;;) {
      const cycleStart = clock.now();
      let t = cycleStart;
      for (let f = start; f < end; f++) {
        if (this.destroyed || signal?.aborted || clock.instant === true) break;
        this.show(f);
        if (first) {
          this.o.onStart?.();
          first = false;
        }
        t += flcFrameDelay(this.flc, f);
        const due = t - clock.now();
        if (due > 0) await clock.wait(due, signal);
      }
      // 循环：中止、销毁或时钟没有前进（instant / 立即完成的等待）时停下，避免空转
      if (opts.loop !== true || this.destroyed || signal?.aborted || clock.now() === cycleStart) break;
    }
    if (this.destroyed) return;
    if (!opts.loop && this.shown !== end - 1) this.show(end - 1);
    else if (opts.loop && this.shown < 0) this.show(start);
  }

  /** 按目标时长加速或截取（规则见 fit.ts）；返回实际采用的计划 */
  async playFit(budgetMs: number, opts: PlayFitOptions = {}): Promise<FitPlan> {
    const fitOpts: FitOptions = opts.maxSpeed !== undefined ? { maxSpeed: opts.maxSpeed } : {};
    const plan = planFit({ frames: this.frames, frameMs: this.frameMs, trim: opts.trim ?? null }, budgetMs, fitOpts);
    await this.playPlan(plan, opts.signal);
    return plan;
  }

  /** 停止播放并释放缓冲（RGBA、索引缓冲、自己建的画布）；FLC 文件本身（flc）由调用方决定是否保留 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.dec = null;
    this.rgba = new Uint8ClampedArray(0);
    if (this.ownsSink && this.sink instanceof CanvasFrameSink) this.sink.release();
  }
}

function isFlcFile(x: unknown): x is FlcFile {
  return typeof x === 'object' && x !== null && 'chunks' in x && 'data' in x && 'frames' in x;
}
