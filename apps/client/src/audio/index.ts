// audio/ 入口（design-draft §3.7；original-skin.md A9）。整合方式见 AudioSystem 的注释。
import type { PackManifestV1 } from '@rich4/shared/assets';
import type { AudioPort } from '../presentation/types';
import { AudioEngine, type AudioEngineOptions } from './AudioEngine';
import { AudioDirector, type AudioDirectorOptions } from './director';
import { isZzfxPreset, ProceduralAudioSource, zzfxKey } from './procedural';
import { bindAudioSettings, type SettingsStoreLike } from './settingsBinding';
import { defaultPackUrl, EMPTY_AUDIO_MAPS, loadAudioMaps, manifestAudioSource, type PackUrlOf } from './sources';
import type { AudioEngineState, AudioLogEntry } from './types';
import { type AudioEnv, browserAudioEnv } from './webaudio';

export type { AudioEngineOptions, DuckOptions, SfxOptions } from './AudioEngine';
export { AudioEngine } from './AudioEngine';
export * from './cues';
export type { AudioDirectorOptions, AudioEventCtx, DirectorEngine, EventAudio, UiCue } from './director';
export { AudioDirector, audioCtxOf } from './director';
export { dbToGain, FORMAT_MIME, formatOrder, pickFormat, volumeToGain } from './format';
export type { MusicSnapshot, SceneMode, ScenePushOptions } from './music';
export * from './procedural';
export * from './selectors';
export * from './settingsBinding';
export * from './sources';
export * from './types';
export type { VoiceOutcome, VoicePolicy, VoiceRequest } from './voice';
export type { AudioEnv } from './webaudio';
export { browserAudioEnv } from './webaudio';

export interface AudioSystemOptions {
  env?: AudioEnv;
  engine?: Omit<AudioEngineOptions, 'env' | 'sources'>;
  director?: AudioDirectorOptions;
  /** 绑定设置 store（缺省不绑定；整合时传 useSettingsStore） */
  settings?: SettingsStoreLike;
  /** 在 window 上挂首次手势解锁（缺省 true） */
  unlockOnGesture?: boolean;
}

/** 调试 / E2E 钩子（整合方挂到 window.__rich4.audio） */
export interface AudioTestHooks {
  readonly state: AudioEngineState;
  readonly log: readonly AudioLogEntry[];
  music(): ReturnType<AudioEngine['musicSnapshot']>;
  clearLog(): void;
}

/**
 * 一套引擎 + 导演层 + ZzFX 回退。整合：
 *   const audio = createAudioSystem({ settings: useSettingsStore });           // ?audio=off 时不创建
 *   handlers = audio.director.wrapHandlers(HANDLERS);                          // EventPlayer 的 handlers
 *   audio.director.setUi({ screen: 'game', venue, holiday });                  // UI 状态变化时
 *   await audio.applyPack(manifest);                                              // PackClient 就绪后（null = 无素材包）
 *   EventPlayer.onAbort → audio.director.reset()
 */
export class AudioSystem {
  readonly engine: AudioEngine;
  readonly director: AudioDirector;
  readonly procedural: ProceduralAudioSource;
  private cleanups: (() => void)[] = [];
  private hiddenOff: (() => void) | null = null;
  private packGen = 0;
  /** applyPack 丢弃的映射表与原因 */
  packIssues: string[] = [];

  constructor(o: AudioSystemOptions = {}) {
    const env = o.env ?? browserAudioEnv();
    this.procedural = new ProceduralAudioSource();
    this.engine = new AudioEngine({ ...o.engine, env, sources: [this.procedural] });
    this.director = new AudioDirector(this.engine, o.director);
    if (o.unlockOnGesture !== false) this.cleanups.push(this.engine.installUnlock());
    if (o.settings) {
      this.cleanups.push(bindAudioSettings(this.engine, o.settings, (bg) => this.setMuteInBackground(bg)));
    } else {
      this.setMuteInBackground(true);
    }
  }

  setMuteInBackground(on: boolean): void {
    this.hiddenOff?.();
    this.hiddenOff = on ? this.engine.suspendWhenHidden(true) : null;
  }

  /** 切换素材包（null = 只用 ZzFX 回退）；映射表校验失败的部分按缺失处理 */
  async applyPack(
    manifest: PackManifestV1 | null,
    o: { urlOf?: PackUrlOf; fetchJson?: (url: string) => Promise<unknown> } = {},
  ): Promise<void> {
    const gen = ++this.packGen;
    if (!manifest) {
      this.engine.setSources([this.procedural]);
      this.director.setMaps(EMPTY_AUDIO_MAPS);
      this.packIssues = [];
      return;
    }
    const urlOf = o.urlOf ?? defaultPackUrl;
    const fetchJson =
      o.fetchJson ??
      (async (url: string) => {
        const r = await fetch(url, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<unknown>;
      });
    const { maps, issues } = await loadAudioMaps(manifest, fetchJson, urlOf);
    if (gen !== this.packGen) return;
    this.packIssues = issues;
    this.engine.setSources([manifestAudioSource(manifest, urlOf), this.procedural]);
    this.director.setMaps(maps);
  }

  /**
   * PresentationContext.audio 的实现：handler 里 ctx.audio.play(id) 可播逻辑键（`sfx.049`、`zzfx.coin`）
   * 或裸 ZzFX 预设名（`coin`）
   */
  port(): AudioPort {
    return {
      play: (id: string) => {
        const preset = isZzfxPreset(id) ? id : null;
        this.engine.playSfx(preset ? zzfxKey(preset) : id);
      },
    };
  }

  hooks(): AudioTestHooks {
    const e = this.engine;
    return {
      get state() {
        return e.state;
      },
      get log() {
        return e.logs;
      },
      music: () => e.musicSnapshot(),
      clearLog: () => e.clearLog(),
    };
  }

  dispose(): void {
    this.hiddenOff?.();
    this.hiddenOff = null;
    for (const c of this.cleanups.splice(0)) c();
    this.director.reset();
    this.engine.dispose();
  }
}

export function createAudioSystem(o: AudioSystemOptions = {}): AudioSystem {
  return new AudioSystem(o);
}
