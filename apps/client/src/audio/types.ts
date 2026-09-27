// 音频公共类型：总线、格式、素材来源接口、混音设置、日志（design-draft §3.7；original-skin.md U1 默认项）。
import type { AudioBufferLike, AudioContextLike } from './webaudio';

/** 四条总线；master 在其上 */
export type Bus = 'bgm' | 'sfx' | 'voice' | 'ui';
export const BUSES: readonly Bus[] = Object.freeze(['bgm', 'sfx', 'voice', 'ui'] as const);

/** 素材包音频格式：Opus 为主，m4a（AAC）为旧 Safari 回退 */
export type AudioFormat = 'opus' | 'm4a';

/** 条目元数据（素材包 AudioEntry 的子集） */
export interface AudioClipInfo {
  durationMs: number;
  /** 场景曲循环区间；null 表示不循环（棋盘曲一曲放完接下一首） */
  loop: { startMs: number; endMs: number } | null;
}

/**
 * 素材来源。AudioEngine 只认逻辑键（`voice.1074`、`sfx.049`、`music.track14`、`zzfx.coin`），
 * 由来源把逻辑键解析成 URL（素材包）或直接合成（ZzFX）。多个来源按顺序尝试，先命中者生效。
 */
export interface AudioSource {
  readonly id: string;
  /** 逻辑键 → 该格式文件的 URL；不认识这个键或没有这种格式时返回 null */
  resolve(key: string, format: AudioFormat): string | null;
  /** 条目元数据（循环区间、时长）；没有则 null */
  info?(key: string): AudioClipInfo | null;
  /** 程序化合成（ZzFX 回退）；不认识这个键时返回 null */
  synth?(key: string, ctx: AudioContextLike): Promise<AudioBufferLike | null> | AudioBufferLike | null;
  /** 是否认识这个键（试听页与回退判断用；缺省按 resolve / synth 推断） */
  has?(key: string): boolean;
}

/** 引擎的混音设置（0..1 线性滑杆值）；ui 缺省跟随 sfx */
export interface AudioMix {
  master: number;
  bgm: number;
  sfx: number;
  voice: number;
  ui: number;
  muted: boolean;
  /** 角色语音开关（U1 默认开启）；关闭时 speak() 直接返回 'disabled' 且不下载语音 */
  voiceEnabled: boolean;
}

/** client.md §7.1 默认音量：主 80、BGM 60、音效 80、语音 70 */
export const DEFAULT_MIX: Readonly<AudioMix> = Object.freeze({
  master: 0.8,
  bgm: 0.6,
  sfx: 0.8,
  voice: 0.7,
  ui: 0.8,
  muted: false,
  voiceEnabled: true,
});

export type AudioEngineState = 'locked' | 'running' | 'suspended' | 'disabled' | 'disposed';

export type AudioLogKind = 'engine' | 'sfx' | 'voice' | 'music';

/**
 * 调试 / E2E 日志（`__rich4.audio.log`）：记录逻辑动作（请求了什么、实际开始了什么、续播到哪里），
 * 不依赖真实出声，所以在锁定或静音时也能断言。t 为 env.now() 毫秒。
 */
export interface AudioLogEntry {
  t: number;
  kind: AudioLogKind;
  op: string;
  key?: string;
  bus?: Bus;
  /** 音乐：开始 / 续播时的文件内位置（秒） */
  atSec?: number;
  detail?: string;
}
