// 程序化音效来源（ZzFX 回退；client.md §7.1 选型 zzfx@1.3.2，MIT）：
// - 没有素材包、素材包缺某个音效、或原版音效的语义置信度为 guess 时，事件音效用这里的预设；
// - 逻辑键为 `zzfx.<预设名>`，与素材包的 `sfx.NNN` 同样经 AudioEngine.playSfx 播放；
// - 预设参数是本项目自拟（不是原版数据）；随机度（第 2 个参数）一律为 0，同一预设每次合成的采样相同；
// - zzfx 模块在求值时就会 new AudioContext，所以只在浏览器里首次需要时动态 import，并立刻关掉它自带的上下文。
import type { AudioSource } from './types';
import type { AudioBufferLike, AudioContextLike } from './webaudio';

/** ZzFX 参数：音量, 随机度, 频率, attack, sustain, release, 波形, 波形曲线, slide, deltaSlide, pitchJump, pitchJumpTime,
 * repeatTime, noise, modulation, bitCrush, delay, sustainVolume, decay, tremolo, filter（undefined 取默认值） */
export type ZzfxParams = readonly (number | undefined)[];

const _ = undefined;

/** 预设（事件音效与界面音的程序化回退） */
export const ZZFX_PRESETS = Object.freeze({
  click: [0.4, 0, 900, 0, 0.01, 0.03, 1],
  back: [0.4, 0, 520, 0, 0.01, 0.05, 1, 1, -5],
  open: [0.4, 0, 620, 0.01, 0.02, 0.08, 1, 1, 10],
  tick: [0.35, 0, 1400, 0, 0, 0.02, 0],
  ding: [0.5, 0, 1200, 0, 0.05, 0.4, 0, 1, 0, 0, 400, 0.05],
  dice: [0.5, 0, 300, 0, 0.15, 0.05, 4, 1, 0, 0, 0, 0, 0.04, 2],
  step: [0.3, 0, 120, 0, 0.01, 0.05, 4, 1, 0, 0, 0, 0, 0, 1],
  coin: [0.5, 0, 1675, 0, 0.06, 0.24, 1, 1.82, 0, 0, 837, 0.06],
  stamp: [0.6, 0, 150, 0, 0.03, 0.15, 4, 2, 0, 0, 0, 0, 0, 2],
  hammer: [0.6, 0, 200, 0, 0.02, 0.1, 3, 1, -10, 0, 0, 0, 0, 1],
  card: [0.4, 0, 700, 0.01, 0.05, 0.1, 2, 1, 20],
  boom: [1, 0, 60, 0, 0.2, 0.6, 4, 3, 0, 0, 0, 0, 0, 1.5, 0, 0.2],
  magic: [0.5, 0, 500, 0.05, 0.2, 0.4, 0, 1, 5, 0, 200, 0.1, 0.1, 0, 5],
  news: [0.5, 0, 880, 0, 0.1, 0.2, 1, 1, 0, 0, 440, 0.1, 0.2],
  siren: [0.5, 0, 700, 0.05, 0.6, 0.1, 0, 1, 0, 0, 0, 0, 0, 0, 12, 0, 0, 1, 0, 0.5],
  sad: [0.5, 0, 400, 0.02, 0.3, 0.3, 2, 1, -3],
  fanfare: [0.6, 0, 523, 0.01, 0.25, 0.35, 1, 1, 0, 0, 262, 0.12, 0.12],
  whoosh: [0.4, 0, 300, 0.05, 0.15, 0.2, 4, 1, 20, _, _, _, _, 1],
  // 决策倒计时最后 10 秒的「嘀」（原版单机热座没有决策计时，素材里没有对应音效）：1318Hz 方波短响约 80ms；
  // 最后 3 秒：1760Hz 更短的一响（约 65ms），由倒计时连放两次成「嘀嘀」（ZzFX 的 delay 回声只有原音的一半且渐弱，不够干脆）
  countdown: [0.3, 0, 1318, 0, 0.05, 0.03, 5, 1],
  countdownFinal: [0.32, 0, 1760, 0, 0.04, 0.025, 5, 1],
} as const satisfies Record<string, ZzfxParams>);

export type ZzfxPresetId = keyof typeof ZZFX_PRESETS;
export const ZZFX_PRESET_IDS: readonly ZzfxPresetId[] = Object.freeze(Object.keys(ZZFX_PRESETS) as ZzfxPresetId[]);

export const ZZFX_PREFIX = 'zzfx.';

export function zzfxKey(p: ZzfxPresetId): string {
  return `${ZZFX_PREFIX}${p}`;
}

export function isZzfxPreset(x: string): x is ZzfxPresetId {
  return Object.hasOwn(ZZFX_PRESETS, x);
}

/** 逻辑键 → 预设名（不是 zzfx 键时返回 null） */
export function zzfxPresetOf(key: string): ZzfxPresetId | null {
  if (!key.startsWith(ZZFX_PREFIX)) return null;
  const p = key.slice(ZZFX_PREFIX.length);
  return isZzfxPreset(p) ? p : null;
}

/** 参数 → 单声道采样 */
export type ZzfxBuilder = (params: ZzfxParams, sampleRate: number) => ArrayLike<number>;

let builderPromise: Promise<ZzfxBuilder | null> | null = null;

/** 浏览器里懒加载 zzfx；不支持 Web Audio（node、旧浏览器）时返回 null */
export function loadZzfxBuilder(): Promise<ZzfxBuilder | null> {
  builderPromise ??= import('zzfx').then(
    (m) => {
      const z = m.ZZFX;
      // 模块自带的上下文只用于它自己的 play()；我们只借 buildSamples，立刻关掉以免占用音频线程
      void z.audioContext?.close?.().catch(() => {});
      return (params: ZzfxParams, sampleRate: number) => z.buildSamples.apply({ volume: 1, sampleRate }, [...params]);
    },
    () => null,
  );
  return builderPromise;
}

export interface ProceduralSourceOptions {
  /** 固定的采样生成器（测试注入）；优先于 loadBuilder */
  builder?: ZzfxBuilder;
  /** 生成器加载函数；缺省懒加载 zzfx */
  loadBuilder?: () => Promise<ZzfxBuilder | null>;
  presets?: Readonly<Record<string, ZzfxParams>>;
}

/** ZzFX 回退来源：只认 `zzfx.<预设>`，不提供 URL，按需合成成 AudioBuffer */
export class ProceduralAudioSource implements AudioSource {
  readonly id = 'procedural';
  private readonly presets: Readonly<Record<string, ZzfxParams>>;
  private readonly getBuilder: () => Promise<ZzfxBuilder | null>;

  constructor(o: ProceduralSourceOptions = {}) {
    this.presets = o.presets ?? ZZFX_PRESETS;
    const fixed = o.builder;
    this.getBuilder = fixed ? () => Promise.resolve(fixed) : (o.loadBuilder ?? loadZzfxBuilder);
  }

  resolve(): string | null {
    return null;
  }

  has(key: string): boolean {
    return this.params(key) !== null;
  }

  params(key: string): ZzfxParams | null {
    if (!key.startsWith(ZZFX_PREFIX)) return null;
    const p = key.slice(ZZFX_PREFIX.length);
    return Object.hasOwn(this.presets, p) ? this.presets[p]! : null;
  }

  async synth(key: string, ctx: AudioContextLike): Promise<AudioBufferLike | null> {
    const params = this.params(key);
    if (!params) return null;
    const build = await this.getBuilder();
    if (!build) return null;
    const samples = build(params, ctx.sampleRate);
    const n = samples.length;
    if (n === 0) return null;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const v = samples[i]!;
      ch[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    }
    return buf;
  }
}
