// 素材包音频来源与映射表加载（不依赖 PackClient：只吃已校验的 manifest 与「包内路径 → URL」函数）。
// PackClient（A5）加载好 manifest 后：engine.setSources([manifestAudioSource(m, (p) => `/pack/${p}`), procedural])。
import {
  type AudioEntry,
  checkMusicMapRefs,
  checkSfxSetsRefs,
  checkVoiceMapRefs,
  DATA_KEYS,
  type MusicMapV1,
  type PackManifestV1,
  type SfxSetsV1,
  safeParseMusicMap,
  safeParseSfxSets,
  safeParseVoiceMap,
  type VoiceMapV1,
} from '@rich4/shared/assets';
import type { AudioClipInfo, AudioFormat, AudioSource } from './types';

/** 包内实际路径（带哈希）→ 可请求的 URL */
export type PackUrlOf = (packPath: string) => string;

export const defaultPackUrl: PackUrlOf = (p) => `/pack/${p}`;

function audioEntry(m: PackManifestV1, key: string): AudioEntry | null {
  const e = Object.hasOwn(m.entries, key) ? m.entries[key] : undefined;
  return e?.type === 'audio' ? e : null;
}

/** 由已校验的 manifest 构造来源：逻辑键 → 条目 files[格式] → files 表的带哈希路径 → URL */
export function manifestAudioSource(m: PackManifestV1, urlOf: PackUrlOf = defaultPackUrl): AudioSource {
  const id = `pack:${m.packId}`;
  return {
    id,
    resolve(key: string, format: AudioFormat): string | null {
      const e = audioEntry(m, key);
      if (!e) return null;
      const logical = e.files[format];
      if (logical === undefined) return null;
      const f = Object.hasOwn(m.files, logical) ? m.files[logical] : undefined;
      return f ? urlOf(f.path) : null;
    },
    info(key: string): AudioClipInfo | null {
      const e = audioEntry(m, key);
      return e ? { durationMs: e.durationMs, loop: e.loop } : null;
    },
    has(key: string): boolean {
      return audioEntry(m, key) !== null;
    },
  };
}

/** 素材包里的三张音频映射表（缺失或校验失败的为 null） */
export interface AudioMaps {
  voiceMap: VoiceMapV1 | null;
  sfxSets: SfxSetsV1 | null;
  musicMap: MusicMapV1 | null;
}

export const EMPTY_AUDIO_MAPS: Readonly<AudioMaps> = Object.freeze({ voiceMap: null, sfxSets: null, musicMap: null });

export interface LoadAudioMapsResult {
  maps: AudioMaps;
  /** 被丢弃的表与原因（设置页 / 试听页显示） */
  issues: string[];
}

/**
 * 按 manifest 的 data.* 条目下载并校验三张表；结构不合法或引用了不存在的音频条目的表一律丢弃（按缺失处理），
 * 对应的声音走程序化回退或静默。features.audio / voice / music 为 false 时对应的表不加载。
 */
export async function loadAudioMaps(
  m: PackManifestV1,
  fetchJson: (url: string) => Promise<unknown>,
  urlOf: PackUrlOf = defaultPackUrl,
): Promise<LoadAudioMapsResult> {
  const issues: string[] = [];
  const url = (key: string): string | null => {
    const e = Object.hasOwn(m.entries, key) ? m.entries[key] : undefined;
    if (e?.type !== 'data') return null;
    const f = Object.hasOwn(m.files, e.file) ? m.files[e.file] : undefined;
    return f ? urlOf(f.path) : null;
  };
  async function load<T>(
    key: string,
    enabled: boolean,
    parse: (j: unknown) => { ok: true; value: T } | { ok: false; issues: string[] },
    refs: (v: T) => { message: string }[],
  ): Promise<T | null> {
    if (!enabled) return null;
    const u = url(key);
    if (u === null) {
      issues.push(`${key}: 素材包里没有这张表`);
      return null;
    }
    let json: unknown;
    try {
      json = await fetchJson(u);
    } catch (e) {
      issues.push(`${key}: 下载失败（${e instanceof Error ? e.message : String(e)}）`);
      return null;
    }
    const r = parse(json);
    if (!r.ok) {
      issues.push(`${key}: ${r.issues.slice(0, 3).join('；')}`);
      return null;
    }
    const bad = refs(r.value);
    if (bad.length > 0) {
      issues.push(`${key}: ${bad.length} 处引用无效（${bad[0]!.message}）`);
      return null;
    }
    return r.value;
  }
  const [voiceMap, sfxSets, musicMap] = await Promise.all([
    load(DATA_KEYS.voiceMap, m.features.voice, safeParseVoiceMap, (v) => checkVoiceMapRefs(m, v)),
    load(DATA_KEYS.sfxSets, m.features.audio, safeParseSfxSets, (v) => checkSfxSetsRefs(m, v)),
    load(DATA_KEYS.musicMap, m.features.music, safeParseMusicMap, (v) => checkMusicMapRefs(m, v)),
  ]);
  return { maps: { voiceMap, sfxSets, musicMap }, issues };
}
