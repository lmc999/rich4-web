// AudioEngine（design-draft §3.7、client.md §7.1；original-skin.md U1：语音默认开启、独立音量）。
//
// 图：各路声源 → 总线 bgm / sfx / voice / ui → master → destination；bgm 总线与 master 之间有一级压低（duck）节点，
// 播放语音或新闻时 BGM 压低 6 dB。
// - 首次手势解锁（iOS）：pointerdown / touchend / keydown 里 resume()、播 1 个采样的静音缓冲、对媒体元素各 play() 一次，
//   并设置 navigator.audioSession.type = 'playback'；解锁前的音效与语音请求直接丢弃（不排队补播）。
// - 后台标签页：隐藏时挂起 AudioContext 并暂停音乐（记下位置），回到前台后从原处续播。
// - SFX：解码后的 AudioBuffer（LRU 缓存），同一键并发上限 maxConcurrentPerKey（超出时停掉最早的一个）；
//   加载太慢（超过 maxSfxLatencyMs）的音效作废，不迟到补播。
// - 语音：单通道（voice.ts），按原版阻塞语义排队或打断。
// - 音乐：music.ts（棋盘曲流式轮播 + 场景栈续播）。
// - 格式：按 canPlayType 选 Opus 或 m4a；某一格式解码失败时换另一格式再试。
// 素材来源经注入的 AudioSource 列表解析（素材包、ZzFX 回退），引擎不依赖 PackClient。
import { BufferCache } from './bufferCache';
import { dbToGain, formatOrder, volumeToGain } from './format';
import { MusicPlayer, type MusicSnapshot, type SceneMode, type ScenePushOptions } from './music';
import {
  type AudioClipInfo,
  type AudioEngineState,
  type AudioFormat,
  type AudioLogEntry,
  type AudioLogKind,
  type AudioMix,
  type AudioSource,
  BUSES,
  type Bus,
  DEFAULT_MIX,
} from './types';
import {
  VoiceChannel,
  type VoiceChannelOptions,
  type VoiceOutcome,
  type VoiceRequest,
  type VoiceStatus,
} from './voice';
import type { AudioBufferLike, AudioContextLike, AudioEnv, BufferSourceLike, GainNodeLike } from './webaudio';

export interface AudioEngineOptions {
  env: AudioEnv;
  sources?: readonly AudioSource[];
  mix?: Partial<AudioMix>;
  /** 同一音效键的并发上限（默认 4） */
  maxConcurrentPerKey?: number;
  /** 音效与语音解码缓存上限（字节，默认 48 MiB） */
  bufferBudgetBytes?: number;
  /** 场景曲解码缓存上限（字节，默认 64 MiB） */
  musicBudgetBytes?: number;
  /** 音效从请求到开始的最大延迟（加载超时即作废，默认 400 ms） */
  maxSfxLatencyMs?: number;
  /** 语音时 BGM 压低量（dB，默认 −6） */
  voiceDuckDb?: number;
  voice?: Partial<VoiceChannelOptions>;
  fadeMs?: number;
  sceneMode?: SceneMode;
  /** 日志条数上限（环形，默认 500） */
  logLimit?: number;
}

export interface SfxOptions {
  bus?: 'sfx' | 'ui';
  /** 相对音量 0..1 */
  volume?: number;
  playbackRate?: number;
  maxConcurrent?: number;
}

export interface DuckOptions {
  attackMs?: number;
  releaseMs?: number;
}

interface Voiceless {
  key: string;
  src: BufferSourceLike;
  gain: GainNodeLike;
}

const DEFAULTS = {
  maxConcurrentPerKey: 4,
  bufferBudgetBytes: 48 * 1024 * 1024,
  musicBudgetBytes: 64 * 1024 * 1024,
  maxSfxLatencyMs: 400,
  voiceDuckDb: -6,
  fadeMs: 250,
  logLimit: 500,
};

const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'keydown', 'mousedown'] as const;

export class AudioEngine {
  readonly ctx: AudioContextLike | null;
  private readonly env: AudioEnv;
  private sources: AudioSource[];
  private readonly formats: AudioFormat[];
  private mix: AudioMix;
  private _state: AudioEngineState;
  private readonly master: GainNodeLike | null = null;
  private readonly duckNode: GainNodeLike | null = null;
  private readonly buses = new Map<Bus, GainNodeLike>();
  private readonly cache: BufferCache;
  private readonly musicCache: BufferCache;
  private readonly active = new Map<string, Voiceless[]>();
  private readonly duckTokens = new Map<number, number>();
  private nextDuck = 1;
  private voiceDuck: (() => void) | null = null;
  private readonly voiceCh: VoiceChannel;
  readonly music: MusicPlayer | null = null;
  private readonly opts: typeof DEFAULTS;
  private readonly logRing: AudioLogEntry[] = [];
  private cleanups: (() => void)[] = [];
  private hiddenSuspend = false;
  private readonly listeners = new Set<() => void>();

  constructor(o: AudioEngineOptions) {
    this.env = o.env;
    this.sources = [...(o.sources ?? [])];
    this.formats = formatOrder((m) => o.env.canPlayType(m));
    this.mix = { ...DEFAULT_MIX, ...o.mix };
    this.opts = {
      maxConcurrentPerKey: o.maxConcurrentPerKey ?? DEFAULTS.maxConcurrentPerKey,
      bufferBudgetBytes: o.bufferBudgetBytes ?? DEFAULTS.bufferBudgetBytes,
      musicBudgetBytes: o.musicBudgetBytes ?? DEFAULTS.musicBudgetBytes,
      maxSfxLatencyMs: o.maxSfxLatencyMs ?? DEFAULTS.maxSfxLatencyMs,
      voiceDuckDb: o.voiceDuckDb ?? DEFAULTS.voiceDuckDb,
      fadeMs: o.fadeMs ?? DEFAULTS.fadeMs,
      logLimit: o.logLimit ?? DEFAULTS.logLimit,
    };
    this.cache = new BufferCache(this.opts.bufferBudgetBytes);
    this.musicCache = new BufferCache(this.opts.musicBudgetBytes);
    let ctx: AudioContextLike | null = null;
    try {
      ctx = o.env.createContext();
    } catch {
      ctx = null;
    }
    this.ctx = ctx;
    this._state = ctx === null ? 'disabled' : ctx.state === 'running' ? 'running' : 'locked';
    if (ctx) {
      const master = ctx.createGain();
      master.connect(ctx.destination);
      const duck = ctx.createGain();
      duck.connect(master);
      for (const b of BUSES) {
        const g = ctx.createGain();
        g.connect(b === 'bgm' ? duck : master);
        this.buses.set(b, g);
      }
      this.master = master;
      this.duckNode = duck;
      this.music = new MusicPlayer(
        {
          ctx,
          out: this.buses.get('bgm')!,
          createElement: () => o.env.createElement(),
          setTimeout: (cb, ms) => o.env.setTimeout(cb, ms),
          clearTimeout: (h) => o.env.clearTimeout(h),
          resolveUrl: (k) => this.resolveUrl(k),
          info: (k) => this.info(k),
          loadBuffer: (k) => this.musicCache.get(k, () => this.fetchDecode(k)),
          canPlay: () => this._state === 'running',
          log: (op, key, atSec, detail) => this.log('music', op, { key, atSec, detail }),
        },
        { fadeMs: this.opts.fadeMs, ...(o.sceneMode ? { sceneMode: o.sceneMode } : {}) },
      );
      this.applyMix(0);
    }
    this.voiceCh = new VoiceChannel(
      {
        now: () => o.env.now(),
        setTimeout: (cb, ms) => o.env.setTimeout(cb, ms),
        clearTimeout: (h) => o.env.clearTimeout(h),
        load: (k) => this.loadBuffer(k),
        start: (key, buf, onEnd) => this.startBuffer(key, buf, 'voice', 1, 1, onEnd),
        onActive: (on) => this.onVoiceActive(on),
        log: (op, key, detail) => this.log('voice', op, { key, bus: 'voice', detail }),
      },
      o.voice,
    );
    this.log('engine', 'create', { detail: this._state });
  }

  // ───────────────────────── 状态、日志、订阅 ─────────────────────────

  get state(): AudioEngineState {
    return this._state;
  }

  get settings(): Readonly<AudioMix> {
    return this.mix;
  }

  /** 首选格式在前 */
  get formatPreference(): readonly AudioFormat[] {
    return this.formats;
  }

  /** 日志（最新在后；`__rich4.audio.log`） */
  get logs(): readonly AudioLogEntry[] {
    return this.logRing;
  }

  logEntries(filter?: AudioLogKind): AudioLogEntry[] {
    return filter ? this.logRing.filter((e) => e.kind === filter) : [...this.logRing];
  }

  clearLog(): void {
    this.logRing.splice(0);
  }

  /** 状态变化（解锁、挂起）通知；返回退订函数 */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setState(s: AudioEngineState): void {
    if (this._state === s) return;
    this._state = s;
    this.log('engine', 'state', { detail: s });
    for (const cb of [...this.listeners]) cb();
  }

  private log(kind: AudioLogKind, op: string, x: Omit<AudioLogEntry, 't' | 'kind' | 'op'> = {}): void {
    const e: AudioLogEntry = { t: this.env.now(), kind, op };
    if (x.key !== undefined) e.key = x.key;
    if (x.bus !== undefined) e.bus = x.bus;
    if (x.atSec !== undefined) e.atSec = x.atSec;
    if (x.detail !== undefined) e.detail = x.detail;
    this.logRing.push(e);
    if (this.logRing.length > this.opts.logLimit) this.logRing.splice(0, this.logRing.length - this.opts.logLimit);
  }

  // ───────────────────────── 解锁与后台 ─────────────────────────

  /** 在用户手势的同步调用栈里调用（iOS 要求 resume 与首次播放发生在手势内） */
  unlock(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || this._state === 'disposed' || this._state === 'disabled') return Promise.resolve();
    const session = this.env.audioSession;
    if (session && session.type !== 'playback') {
      try {
        session.type = 'playback';
      } catch {
        // 只读或不支持
      }
    }
    let resumed: Promise<void>;
    try {
      resumed = ctx.resume();
    } catch {
      resumed = Promise.resolve();
    }
    try {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
    } catch {
      // 忽略
    }
    this.music?.bless(this.env.silentUrl?.() ?? null);
    return resumed.then(
      () => {
        if (this._state === 'disposed') return;
        if (this.hiddenSuspend) return;
        if (ctx.state === 'running') {
          this.setState('running');
          this.music?.refresh();
        }
      },
      () => {},
    );
  }

  /** 在 gestureTarget（window）上挂首次手势解锁；解锁成功后自动移除。返回移除函数 */
  installUnlock(): () => void {
    const target = this.env.gestureTarget;
    if (!target || !this.ctx) return () => {};
    const handler = (): void => {
      void this.unlock().then(() => {
        if (this._state === 'running') off();
      });
    };
    const off = (): void => {
      for (const ev of UNLOCK_EVENTS) target.removeEventListener(ev, handler, { capture: true });
    };
    for (const ev of UNLOCK_EVENTS) target.addEventListener(ev, handler, { capture: true, passive: true });
    this.cleanups.push(off);
    return off;
  }

  /** 后台标签页挂起（client.md §7.1 默认开启）；返回退订函数 */
  suspendWhenHidden(on = true): () => void {
    const vis = this.env.visibility;
    if (!on || !vis || !this.ctx) return () => {};
    const onChange = (): void => {
      if (vis.hidden) this.enterBackground();
      else this.leaveBackground();
    };
    const off = vis.subscribe(onChange);
    this.cleanups.push(off);
    if (vis.hidden) this.enterBackground();
    return off;
  }

  private enterBackground(): void {
    if (this.hiddenSuspend || !this.ctx || this._state === 'disposed') return;
    this.hiddenSuspend = true;
    this.voiceCh.stopAll('cancelled');
    this.music?.pauseAll();
    if (this._state === 'running') {
      this.setState('suspended');
      void this.ctx.suspend().catch(() => {});
    }
  }

  private leaveBackground(): void {
    if (!this.hiddenSuspend || !this.ctx) return;
    this.hiddenSuspend = false;
    if (this._state !== 'suspended') return;
    const ctx = this.ctx;
    const relock = (): void => {
      // iOS 等可能要求重新在手势内 resume：退回 locked 并重新挂手势监听
      if (this._state !== 'suspended' || this.hiddenSuspend) return;
      this.setState('locked');
      this.installUnlock();
    };
    void ctx.resume().then(() => {
      if (this._state !== 'suspended' || this.hiddenSuspend) return;
      if (ctx.state !== 'running') {
        relock();
        return;
      }
      this.setState('running');
      this.music?.refresh();
    }, relock);
  }

  // ───────────────────────── 来源 ─────────────────────────

  /** 换来源（素材包加载完成、切皮肤）：清空解码缓存，音乐按新来源重新开始 */
  setSources(sources: readonly AudioSource[]): void {
    this.sources = [...sources];
    this.cache.clear();
    this.musicCache.clear();
    this.log('engine', 'sources', { detail: sources.map((s) => s.id).join(',') });
    this.music?.reload();
  }

  get sourceIds(): string[] {
    return this.sources.map((s) => s.id);
  }

  /** 是否有来源认识这个键 */
  has(key: string): boolean {
    return this.sources.some((s) => {
      if (s.has) return s.has(key);
      return this.formats.some((f) => s.resolve(key, f) !== null);
    });
  }

  resolveUrl(key: string): string | null {
    for (const s of this.sources) {
      for (const f of this.formats) {
        const url = s.resolve(key, f);
        if (url !== null) return url;
      }
    }
    return null;
  }

  info(key: string): AudioClipInfo | null {
    for (const s of this.sources) {
      const i = s.info?.(key);
      if (i) return i;
    }
    return null;
  }

  private async fetchDecode(key: string): Promise<AudioBufferLike | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    for (const s of this.sources) {
      if (s.synth) {
        const b = await s.synth(key, ctx);
        if (b) return b;
      }
      for (const f of this.formats) {
        const url = s.resolve(key, f);
        if (url === null) continue;
        try {
          const data = await this.env.fetchArrayBuffer(url);
          return await ctx.decodeAudioData(data);
        } catch (e) {
          this.log('engine', 'decodeError', { key, detail: `${f}: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
    }
    return null;
  }

  /** 加载（并缓存）音效或语音的缓冲；锁定时也可预载 */
  loadBuffer(key: string): Promise<AudioBufferLike | null> {
    if (!this.ctx || this._state === 'disposed') return Promise.resolve(null);
    return this.cache.get(key, () => this.fetchDecode(key));
  }

  /** 预载一组键（进入场景时按音效集预载，与原版一致） */
  async preload(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map((k) => this.loadBuffer(k)));
  }

  get cacheBytes(): number {
    return this.cache.bytes;
  }

  // ───────────────────────── 音量 ─────────────────────────

  setMix(m: Partial<AudioMix>): void {
    const prevVoice = this.mix.voiceEnabled;
    this.mix = { ...this.mix, ...stripUndefined(m) };
    if (prevVoice && !this.mix.voiceEnabled) this.voiceCh.stopAll('disabled');
    this.applyMix(60);
  }

  setVolume(bus: Bus | 'master', v: number): void {
    this.setMix({ [bus]: v } as Partial<AudioMix>);
  }

  setMuted(m: boolean): void {
    this.setMix({ muted: m });
  }

  /** 当前应用到节点上的目标增益（测试与试听页用） */
  gainOf(bus: Bus | 'master'): number {
    if (bus === 'master') return this.mix.muted ? 0 : volumeToGain(this.mix.master);
    if (bus === 'voice' && !this.mix.voiceEnabled) return 0;
    return volumeToGain(this.mix[bus]);
  }

  private applyMix(rampMs: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    ramp(ctx, this.master, this.gainOf('master'), rampMs);
    for (const b of BUSES) ramp(ctx, this.buses.get(b)!, this.gainOf(b), rampMs);
  }

  // ───────────────────────── 压低 ─────────────────────────

  /** 压低 BGM（新闻、乐透、语音）；返回释放函数。多个压低同时生效时取最低值 */
  duck(db: number, o: DuckOptions = {}): () => void {
    const id = this.nextDuck++;
    this.duckTokens.set(id, dbToGain(Math.min(0, db)));
    this.applyDuck(o.attackMs ?? 80);
    this.log('engine', 'duck', { detail: `${db}dB` });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.duckTokens.delete(id);
      this.applyDuck(o.releaseMs ?? 300);
      this.log('engine', 'unduck');
    };
  }

  /** 当前压低倍数（1 = 未压低） */
  get duckLevel(): number {
    let g = 1;
    for (const v of this.duckTokens.values()) g = Math.min(g, v);
    return g;
  }

  private applyDuck(ms: number): void {
    if (!this.ctx || !this.duckNode) return;
    ramp(this.ctx, this.duckNode, this.duckLevel, ms);
  }

  private onVoiceActive(on: boolean): void {
    if (on && !this.voiceDuck) this.voiceDuck = this.duck(this.opts.voiceDuckDb);
    else if (!on && this.voiceDuck) {
      const release = this.voiceDuck;
      this.voiceDuck = null;
      release();
    }
  }

  // ───────────────────────── 音效 ─────────────────────────

  /** 播放音效（逻辑键，可为 `zzfx.<预设>`）；解锁前或已关闭时忽略 */
  playSfx(key: string, o: SfxOptions = {}): void {
    if (this._state !== 'running' || !this.ctx) return;
    const bus = o.bus ?? 'sfx';
    const requested = this.env.now();
    const buf = this.cache.peek(key);
    const go = (b: AudioBufferLike | null): void => {
      if (!b) {
        this.log('sfx', 'missing', { key, bus });
        return;
      }
      if (this._state !== 'running') return;
      if (this.env.now() - requested > this.opts.maxSfxLatencyMs) {
        this.log('sfx', 'late', { key, bus });
        return;
      }
      this.startSfx(key, b, bus, o);
    };
    if (buf) go(buf);
    else void this.loadBuffer(key).then(go);
  }

  private startSfx(key: string, b: AudioBufferLike, bus: 'sfx' | 'ui', o: SfxOptions): void {
    const limit = Math.max(1, o.maxConcurrent ?? this.opts.maxConcurrentPerKey);
    const list = this.active.get(key) ?? [];
    while (list.length >= limit) {
      const oldest = list.shift()!;
      try {
        oldest.src.onended = null;
        oldest.src.stop();
      } catch {
        // 已停止
      }
      oldest.src.disconnect();
      oldest.gain.disconnect();
      this.log('sfx', 'steal', { key, bus });
    }
    const handle = this.startBuffer(key, b, bus, o.volume ?? 1, o.playbackRate ?? 1, () => {
      const l = this.active.get(key);
      if (!l) return;
      const i = l.findIndex((x) => x.src === rec.src);
      if (i >= 0) l.splice(i, 1);
      if (l.length === 0) this.active.delete(key);
    });
    const rec: Voiceless = handle.rec;
    list.push(rec);
    this.active.set(key, list);
    this.log('sfx', 'play', { key, bus });
  }

  /** 界面音（ui 总线） */
  playUi(key: string, o: Omit<SfxOptions, 'bus'> = {}): void {
    this.playSfx(key, { ...o, bus: 'ui' });
  }

  /** 同一键当前在响的实例数（测试用） */
  activeCount(key: string): number {
    return this.active.get(key)?.length ?? 0;
  }

  private startBuffer(
    key: string,
    b: AudioBufferLike,
    bus: Bus,
    volume: number,
    rate: number,
    onEnd: () => void,
  ): { stop(): void; rec: Voiceless } {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume));
    src.connect(gain);
    gain.connect(this.buses.get(bus)!);
    let stopped = false;
    src.onended = () => {
      if (stopped) return;
      stopped = true;
      src.disconnect();
      gain.disconnect();
      onEnd();
    };
    src.start(0);
    return {
      rec: { key, src, gain },
      stop: () => {
        if (stopped) return;
        stopped = true;
        src.onended = null;
        try {
          src.stop();
        } catch {
          // 已停止
        }
        src.disconnect();
        gain.disconnect();
      },
    };
  }

  // ───────────────────────── 语音 ─────────────────────────

  /** 播放语音；返回在语音结束（或被打断、作废）时 resolve 的结果。语音关闭或未解锁时立即返回 */
  speak(req: VoiceRequest): Promise<VoiceOutcome> {
    if (!this.mix.voiceEnabled) return Promise.resolve('disabled');
    if (this._state !== 'running' || !this.ctx) return Promise.resolve('cancelled');
    return this.voiceCh.speak(req);
  }

  stopVoice(): void {
    this.voiceCh.stopAll('cancelled');
  }

  get voiceStatus(): VoiceStatus | null {
    return this.voiceCh.status;
  }

  // ───────────────────────── 音乐（MusicPlayer 的薄封装） ─────────────────────────

  setBoardPlaylist(keys: readonly string[], startIdx = 0): void {
    this.music?.setBoardPlaylist(keys, startIdx);
  }

  setBoardActive(on: boolean): void {
    this.music?.setBoardActive(on);
  }

  pushScene(key: string, o?: ScenePushOptions): number {
    return this.music?.push(key, o) ?? 0;
  }

  popScene(token: number): void {
    this.music?.pop(token);
  }

  /** 一次调整多个场景层（期间不切歌） */
  batchScenes(fn: () => void): void {
    if (this.music) this.music.batch(fn);
    else fn();
  }

  musicSnapshot(): MusicSnapshot | null {
    return this.music?.snapshot() ?? null;
  }

  // ───────────────────────── 收尾 ─────────────────────────

  dispose(): void {
    if (this._state === 'disposed') return;
    for (const c of this.cleanups.splice(0)) c();
    this.voiceCh.stopAll('cancelled');
    for (const list of this.active.values()) {
      for (const r of list) {
        try {
          r.src.onended = null;
          r.src.stop();
        } catch {
          // 已停止
        }
      }
    }
    this.active.clear();
    this.music?.dispose();
    this.cache.clear();
    this.musicCache.clear();
    this.setState('disposed');
    void this.ctx?.close().catch(() => {});
  }
}

function ramp(ctx: AudioContextLike, g: GainNodeLike, target: number, ms: number): void {
  const now = ctx.currentTime;
  const p = g.gain;
  const cur = p.value;
  p.cancelScheduledValues(now);
  if (ms <= 0) {
    p.setValueAtTime(target, now);
    return;
  }
  p.setValueAtTime(cur, now);
  p.linearRampToValueAtTime(target, now + ms / 1000);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}
