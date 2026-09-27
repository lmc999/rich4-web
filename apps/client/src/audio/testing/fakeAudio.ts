// 测试用假音频世界：假时钟驱动 AudioContext.currentTime、定时器、媒体元素的播放进度与 ended、缓冲声源的 onended。
// 「编码」音频是一段带 JSON 头的字节（durationMs、声道），decodeAudioData 按它构造惰性分配的假 AudioBuffer，
// 所以几分钟长的场景曲也不占内存。只在测试里使用（audio/testing）。
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioContextStateLike,
  AudioEnv,
  AudioNodeLike,
  AudioParamLike,
  BufferSourceLike,
  GainNodeLike,
  GestureTargetLike,
  MediaElementLike,
  MediaEventName,
  VisibilityLike,
} from '../webaudio';

export async function flushMicrotasks(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ───────────────────────── 时钟 ─────────────────────────

interface Timer {
  id: number;
  at: number;
  cb: () => void;
}

export class FakeClock {
  now = 0;
  private timers: Timer[] = [];
  private nextId = 1;
  private readonly tickers = new Set<(dtMs: number) => void>();

  setTimeout = (cb: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.now + Math.max(0, ms), cb });
    return id;
  };

  clearTimeout = (h: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== h);
  };

  onTick(fn: (dtMs: number) => void): void {
    this.tickers.add(fn);
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  private fireDue(): void {
    for (;;) {
      let due: Timer | null = null;
      for (const t of this.timers) if (t.at <= this.now && (due === null || t.at < due.at)) due = t;
      if (!due) return;
      this.timers = this.timers.filter((t) => t !== due);
      due.cb();
    }
  }

  /** 推进 ms 毫秒（每步 stepMs，步间清空微任务） */
  async advance(ms: number, stepMs = 10): Promise<void> {
    const end = this.now + ms;
    await flushMicrotasks();
    this.fireDue();
    while (this.now < end) {
      const dt = Math.min(stepMs, end - this.now);
      this.now += dt;
      for (const t of this.tickers) t(dt);
      this.fireDue();
      await flushMicrotasks();
    }
  }
}

// ───────────────────────── Web Audio ─────────────────────────

interface ParamEvent {
  t: number;
  v: number;
  ramp: boolean;
}

export class FakeAudioParam implements AudioParamLike {
  private events: ParamEvent[] = [];
  private base: number;

  constructor(
    private readonly ctx: { readonly currentTime: number },
    v: number,
  ) {
    this.base = v;
  }

  get value(): number {
    return this.valueAt(this.ctx.currentTime);
  }

  set value(v: number) {
    this.events = [];
    this.base = v;
  }

  setValueAtTime(v: number, t: number): void {
    this.events.push({ t, v, ramp: false });
    this.events.sort((a, b) => a.t - b.t);
  }

  linearRampToValueAtTime(v: number, t: number): void {
    this.events.push({ t, v, ramp: true });
    this.events.sort((a, b) => a.t - b.t);
  }

  cancelScheduledValues(t: number): void {
    this.events = this.events.filter((e) => e.t < t);
  }

  /** 目标值：所有已排程事件都生效后的值 */
  get target(): number {
    return this.events.length > 0 ? this.events[this.events.length - 1]!.v : this.base;
  }

  valueAt(t: number): number {
    let v = this.base;
    let pt = Number.NEGATIVE_INFINITY;
    for (const e of this.events) {
      if (e.t <= t) {
        v = e.v;
        pt = e.t;
        continue;
      }
      if (e.ramp) {
        const from = pt === Number.NEGATIVE_INFINITY ? t : pt;
        const span = e.t - from;
        return span <= 0 ? e.v : v + ((e.v - v) * (t - from)) / span;
      }
      break;
    }
    return v;
  }
}

export class FakeNode implements AudioNodeLike {
  outputs: AudioNodeLike[] = [];
  connect(d: AudioNodeLike): AudioNodeLike {
    this.outputs.push(d);
    return d;
  }
  disconnect(): void {
    this.outputs = [];
  }
}

export class FakeGain extends FakeNode implements GainNodeLike {
  readonly gain: FakeAudioParam;
  constructor(ctx: FakeAudioContext) {
    super();
    this.gain = new FakeAudioParam(ctx, 1);
  }
}

export class FakeAudioBuffer implements AudioBufferLike {
  private data: Float32Array[] | null = null;
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {}
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(ch: number): Float32Array {
    this.data ??= Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length));
    return this.data[ch]!;
  }
}

export class FakeBufferSource extends FakeNode implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate: FakeAudioParam;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  offset = 0;
  stopAt: number | null = null;
  ended = false;

  constructor(private readonly ctx: FakeAudioContext) {
    super();
    this.playbackRate = new FakeAudioParam(ctx, 1);
  }

  start(when = 0, offset = 0): void {
    this.startedAt = Math.max(when, this.ctx.currentTime);
    this.offset = offset;
    this.ctx.sources.push(this);
  }

  stop(when?: number): void {
    this.stopAt = when ?? this.ctx.currentTime;
  }

  tick(now: number): void {
    if (this.ended || this.startedAt === null) return;
    if (this.stopAt !== null && now >= this.stopAt) {
      this.finish();
      return;
    }
    const b = this.buffer;
    if (!this.loop && b && now >= this.startedAt + (b.duration - this.offset) / (this.playbackRate.value || 1)) {
      this.finish();
    }
  }

  private finish(): void {
    this.ended = true;
    this.onended?.();
  }
}

export class FakeMediaSourceNode extends FakeNode {
  constructor(readonly element: MediaElementLike) {
    super();
  }
}

/** 假编码：'FAKE' + JSON 头 */
export function encodeFakeAudio(o: { durationMs: number; channels?: number }): ArrayBuffer {
  const bytes = new TextEncoder().encode(
    `FAKE${JSON.stringify({ durationMs: o.durationMs, channels: o.channels ?? 1 })}`,
  );
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class FakeAudioContext implements AudioContextLike {
  time = 0;
  state: AudioContextStateLike;
  readonly sampleRate = 48_000;
  readonly destination = new FakeNode();
  readonly sources: FakeBufferSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly mediaSources: FakeMediaSourceNode[] = [];
  resumeCalls = 0;
  /** false 时 resume() 不改变状态（模拟 iOS 未在手势内调用） */
  resumeWorks = true;

  constructor(running: boolean) {
    this.state = running ? 'running' : 'suspended';
  }

  get currentTime(): number {
    return this.time;
  }

  tick(dtMs: number): void {
    if (this.state === 'running') this.time += dtMs / 1000;
    for (const s of this.sources) s.tick(this.time);
  }

  createGain(): FakeGain {
    const g = new FakeGain(this);
    this.gains.push(g);
    return g;
  }

  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource(this);
  }

  createBuffer(ch: number, len: number, sr: number): FakeAudioBuffer {
    return new FakeAudioBuffer(ch, len, sr);
  }

  createMediaElementSource(el: MediaElementLike): FakeMediaSourceNode {
    const n = new FakeMediaSourceNode(el);
    this.mediaSources.push(n);
    return n;
  }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    const text = new TextDecoder().decode(new Uint8Array(data));
    if (!text.startsWith('FAKE')) return Promise.reject(new Error('EncodingError'));
    const h = JSON.parse(text.slice(4)) as { durationMs: number; channels: number };
    const len = Math.max(1, Math.round((h.durationMs / 1000) * this.sampleRate));
    return Promise.resolve(new FakeAudioBuffer(h.channels, len, this.sampleRate));
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.resumeWorks && this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    if (this.state !== 'closed') this.state = 'suspended';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }

  /** 正在响的缓冲声源（已开始、未结束、未停止；不含解锁时播的 1 采样静音） */
  get playing(): FakeBufferSource[] {
    return this.sources.filter(
      (s) =>
        s.startedAt !== null &&
        !s.ended &&
        (s.stopAt === null || s.stopAt > this.time) &&
        (s.buffer === null || s.buffer.length > 1),
    );
  }
}

// ───────────────────────── 媒体元素 ─────────────────────────

export class FakeMediaElement implements MediaElementLike {
  private _src = '';
  private _time = 0;
  paused = true;
  loop = false;
  preload = '';
  crossOrigin: string | null = null;
  playCalls = 0;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly world: FakeAudioWorld) {}

  get src(): string {
    return this._src;
  }

  set src(v: string) {
    this._src = v;
    this._time = 0;
    this.paused = true;
  }

  get duration(): number {
    const c = this.world.clip(this._src);
    return c ? c.durationMs / 1000 : Number.NaN;
  }

  get currentTime(): number {
    return this._time;
  }

  set currentTime(t: number) {
    const d = this.duration;
    this._time = Math.max(0, Number.isFinite(d) ? Math.min(t, d) : t);
  }

  play(): Promise<void> {
    this.playCalls++;
    if (this.world.autoplayBlocked && !this.world.activated) {
      return Promise.reject(Object.assign(new Error('NotAllowedError'), { name: 'NotAllowedError' }));
    }
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {}

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  addEventListener(type: MediaEventName, cb: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(cb);
    this.listeners.set(type, set);
  }

  removeEventListener(type: MediaEventName, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  emit(type: MediaEventName): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }

  tick(dtMs: number): void {
    if (this.paused || !this._src) return;
    const d = this.duration;
    if (!Number.isFinite(d)) return;
    this._time += dtMs / 1000;
    if (this._time >= d) {
      if (this.loop) this._time -= d;
      else {
        this._time = d;
        this.paused = true;
        this.emit('ended');
      }
    }
  }
}

// ───────────────────────── 世界 ─────────────────────────

export interface FakeClip {
  durationMs: number;
  channels?: number;
  /** fetch 失败 */
  failFetch?: boolean;
  /** 解码失败 */
  failDecode?: boolean;
  /** fetch 延迟（假时钟毫秒） */
  delayMs?: number;
}

class FakeVisibility implements VisibilityLike {
  hidden = false;
  private readonly subs = new Set<() => void>();
  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  set(hidden: boolean): void {
    this.hidden = hidden;
    for (const cb of [...this.subs]) cb();
  }
}

class FakeGestureTarget implements GestureTargetLike {
  private readonly subs = new Map<string, Set<() => void>>();
  addEventListener(type: string, cb: () => void): void {
    const set = this.subs.get(type) ?? new Set();
    set.add(cb);
    this.subs.set(type, set);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.subs.get(type)?.delete(cb);
  }
  count(type: string): number {
    return this.subs.get(type)?.size ?? 0;
  }
  dispatch(type: string): void {
    for (const cb of [...(this.subs.get(type) ?? [])]) cb();
  }
}

export interface FakeWorldOptions {
  canPlay?: { opus?: boolean; m4a?: boolean };
  /** 上下文一创建就是 running（桌面浏览器已有用户激活） */
  startRunning?: boolean;
  /** 未激活前媒体元素 play() 被拒 */
  autoplayBlocked?: boolean;
}

export class FakeAudioWorld {
  readonly clock = new FakeClock();
  readonly clips = new Map<string, FakeClip>();
  readonly elements: FakeMediaElement[] = [];
  readonly fetched: string[] = [];
  readonly visibility = new FakeVisibility();
  readonly gestures = new FakeGestureTarget();
  readonly audioSession = { type: 'auto' };
  ctx: FakeAudioContext | null = null;
  autoplayBlocked: boolean;
  activated = false;
  canPlay: { opus: boolean; m4a: boolean };

  constructor(private readonly o: FakeWorldOptions = {}) {
    this.canPlay = { opus: o.canPlay?.opus ?? true, m4a: o.canPlay?.m4a ?? true };
    this.autoplayBlocked = o.autoplayBlocked ?? false;
    this.clock.onTick((dt) => {
      this.ctx?.tick(dt);
      for (const el of this.elements) el.tick(dt);
    });
  }

  register(url: string, clip: FakeClip): this {
    this.clips.set(url, clip);
    return this;
  }

  clip(url: string): FakeClip | undefined {
    return this.clips.get(url);
  }

  /** 模拟一次用户手势（pointerdown） */
  gesture(type = 'pointerdown'): void {
    this.activated = true;
    this.gestures.dispatch(type);
  }

  advance(ms: number, stepMs?: number): Promise<void> {
    return this.clock.advance(ms, stepMs);
  }

  env(): AudioEnv {
    return {
      createContext: () => {
        this.ctx = new FakeAudioContext(this.o.startRunning === true);
        return this.ctx;
      },
      createElement: () => {
        const el = new FakeMediaElement(this);
        this.elements.push(el);
        return el;
      },
      canPlayType: (mime) => {
        if (mime.includes('opus')) return this.canPlay.opus ? 'probably' : '';
        if (mime.includes('mp4')) return this.canPlay.m4a ? 'maybe' : '';
        return '';
      },
      fetchArrayBuffer: (url) => {
        this.fetched.push(url);
        const c = this.clips.get(url);
        const result = (): Promise<ArrayBuffer> => {
          if (!c || c.failFetch) return Promise.reject(new Error(`404 ${url}`));
          if (c.failDecode) return Promise.resolve(new TextEncoder().encode('garbage').buffer as ArrayBuffer);
          return Promise.resolve(encodeFakeAudio({ durationMs: c.durationMs, channels: c.channels ?? 1 }));
        };
        if (c?.delayMs) {
          return new Promise((resolve, reject) => {
            this.clock.setTimeout(() => {
              result().then(resolve, reject);
            }, c.delayMs!);
          });
        }
        return result();
      },
      now: () => this.clock.now,
      setTimeout: (cb, ms) => this.clock.setTimeout(cb, ms),
      clearTimeout: (h) => this.clock.clearTimeout(h),
      visibility: this.visibility,
      gestureTarget: this.gestures,
      audioSession: this.audioSession,
      silentUrl: () => 'blob:silent',
    };
  }

  /** 找到接到某个 MediaElementSource 上、当前 src 为 url 的元素 */
  elementPlaying(url: string): FakeMediaElement | null {
    return this.elements.find((e) => e.src === url && !e.paused) ?? null;
  }
}
