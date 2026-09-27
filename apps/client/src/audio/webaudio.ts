// Web Audio / HTMLMediaElement 的最小结构类型与运行环境（design-draft §3.7、client.md §7.1）。
// AudioEngine 只经这里的接口访问浏览器：真实环境由 browserAudioEnv() 提供，测试用 audio/testing/fakeAudio 的假实现
// （假时钟驱动 currentTime、定时器、媒体元素播放进度与 onended），所以调度、音量、压低、场景栈都能在 node 下验证。

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface AudioBufferLike {
  readonly duration: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface BufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  readonly playbackRate: AudioParamLike;
  onended: (() => void) | null;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
}

export type AudioContextStateLike = 'suspended' | 'running' | 'closed' | 'interrupted';

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: AudioContextStateLike;
  readonly destination: AudioNodeLike;
  createGain(): GainNodeLike;
  createBufferSource(): BufferSourceLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createMediaElementSource(el: MediaElementLike): AudioNodeLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

export type MediaEventName = 'ended' | 'error' | 'playing' | 'pause' | 'loadedmetadata';

export interface MediaElementLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  loop: boolean;
  preload: string;
  crossOrigin: string | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: MediaEventName, cb: () => void): void;
  removeEventListener(type: MediaEventName, cb: () => void): void;
}

/** 页面可见性（后台标签页暂停） */
export interface VisibilityLike {
  readonly hidden: boolean;
  subscribe(cb: () => void): () => void;
}

/** 首次手势解锁要监听的目标（window） */
export interface GestureTargetLike {
  addEventListener(type: string, cb: () => void, opts?: { capture?: boolean; passive?: boolean }): void;
  removeEventListener(type: string, cb: () => void, opts?: { capture?: boolean }): void;
}

export interface AudioEnv {
  /** 不支持 Web Audio 时返回 null（引擎进入 disabled） */
  createContext(): AudioContextLike | null;
  createElement(): MediaElementLike;
  /** HTMLMediaElement.canPlayType */
  canPlayType(mime: string): string;
  fetchArrayBuffer(url: string): Promise<ArrayBuffer>;
  /** 单调毫秒时钟（performance.now） */
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  visibility?: VisibilityLike | null;
  gestureTarget?: GestureTargetLike | null;
  /** iOS 17+：navigator.audioSession（设为 'playback' 避免被静音键屏蔽） */
  audioSession?: { type: string } | null;
  /** iOS 手势内「祝福」媒体元素用的静音音频 URL（Blob URL）；没有则只调用 play/pause */
  silentUrl?(): string | null;
}

/** 44 字节头 + 1 个采样的静音 WAV（8 位单声道 8 kHz），用于 iOS 在手势内预先 play() 媒体元素 */
export function silentWavBytes(): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(45);
  const v = new DataView(b.buffer);
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) b[off + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 37, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  ascii(36, 'data');
  v.setUint32(40, 1, true);
  b[44] = 128;
  return b;
}

type AudioContextCtor = new (o?: { latencyHint?: string }) => AudioContext;

export interface BrowserAudioEnvOptions {
  /** 音频文件请求失败（非 2xx）时调用：素材包音频被门禁拒绝（401）时由整合方显示门禁页 */
  onHttpError?(status: number, url: string): void;
}

/** 浏览器环境；SSR / node 下各方法退化为不可用 */
export function browserAudioEnv(o: BrowserAudioEnvOptions = {}): AudioEnv {
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
    document?: Document;
    navigator?: Navigator & { audioSession?: { type: string } };
    performance?: Performance;
    window?: Window;
    Audio?: typeof Audio;
  };
  let silent: string | null | undefined;
  const probe = typeof g.document !== 'undefined' ? g.document.createElement('audio') : null;
  return {
    createContext() {
      const Ctor = g.AudioContext ?? g.webkitAudioContext;
      if (!Ctor) return null;
      try {
        return new Ctor({ latencyHint: 'interactive' }) as unknown as AudioContextLike;
      } catch {
        return null;
      }
    },
    createElement() {
      const el = new (g.Audio as typeof Audio)();
      el.preload = 'auto';
      return el as unknown as MediaElementLike;
    },
    canPlayType: (mime) => (probe ? probe.canPlayType(mime) : ''),
    async fetchArrayBuffer(url) {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) {
        try {
          o.onHttpError?.(r.status, url);
        } catch {
          // 回调出错不影响本次失败的处理
        }
        throw new Error(`HTTP ${r.status} ${url}`);
      }
      return r.arrayBuffer();
    },
    now: () => (g.performance ? g.performance.now() : 0),
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    visibility: g.document
      ? {
          get hidden() {
            return g.document?.visibilityState === 'hidden';
          },
          subscribe(cb) {
            g.document?.addEventListener('visibilitychange', cb);
            return () => g.document?.removeEventListener('visibilitychange', cb);
          },
        }
      : null,
    gestureTarget: g.window ?? null,
    audioSession: g.navigator?.audioSession ?? null,
    silentUrl() {
      if (silent !== undefined) return silent;
      try {
        silent = URL.createObjectURL(new Blob([silentWavBytes()], { type: 'audio/wav' }));
      } catch {
        silent = null;
      }
      return silent;
    },
  };
}
