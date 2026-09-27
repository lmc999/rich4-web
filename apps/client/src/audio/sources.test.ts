// 素材包音频来源：逻辑键 → 带哈希路径的 URL（按格式）、循环区间；映射表的下载、校验与丢弃。
import {
  ASSET_SCHEMA,
  type AssetEntry,
  type ContentType,
  DATA_KEYS,
  type FileKind,
  hashedPath,
  PACK_LICENSE,
  type PackFile,
  type PackGroup,
  type PackManifestV1,
  safeParsePackManifest,
  withPackId,
} from '@rich4/shared/assets';
import { sha256Hex } from '@rich4/shared/util';
import { describe, expect, it } from 'vitest';
import { bindAudioSettings, mixFromSettings } from './settingsBinding';
import { loadAudioMaps, manifestAudioSource } from './sources';
import { testMusicMap, testSfxSets, testVoiceMap } from './testing/fixtures';

type Spec = [logical: string, kind: FileKind, ct: ContentType, group: string];

function buildManifest(o: { withData?: boolean; features?: Partial<PackManifestV1['features']> } = {}): PackManifestV1 {
  const specs: Spec[] = [
    ['audio/sfx/049.opus', 'audio', 'audio/ogg', 'audio.sfx'],
    ['audio/sfx/049.m4a', 'audio', 'audio/mp4', 'audio.sfx'],
    ['audio/music/track14.m4a', 'audio', 'audio/mp4', 'audio.music.track14'],
  ];
  if (o.withData !== false) {
    specs.push(
      ['data/voice-map.json', 'data', 'application/json', 'data'],
      ['data/sfx-sets.json', 'data', 'application/json', 'data'],
      ['data/music-map.json', 'data', 'application/json', 'data'],
    );
  }
  const files: Record<string, PackFile> = {};
  const groups: Record<string, PackGroup> = {};
  for (const [lp, kind, contentType, g] of specs) {
    const sha = sha256Hex(`t:${lp}`);
    files[lp] = { path: hashedPath(lp, sha), bytes: 10, sha256: sha, kind, contentType };
    const grp = groups[g] ?? {
      category: g === 'data' ? 'data' : g.includes('music') ? 'music' : 'sfx',
      provenance: 'synthetic',
      files: [],
      bytes: 0,
    };
    grp.files.push(lp);
    grp.bytes += 10;
    groups[g] = grp;
  }
  for (const g of Object.values(groups)) g.files.sort();
  const audio = (
    group: string,
    f: { opus?: string; m4a?: string },
    loop: { startMs: number; endMs: number } | null,
  ): AssetEntry => ({
    type: 'audio',
    group,
    confidence: 'exe',
    src: [],
    files: f,
    durationMs: 4000,
    channels: 1,
    sampleRate: 22050,
    loop,
  });
  const entries: Record<string, AssetEntry> = {
    'sfx.049': audio('audio.sfx', { opus: 'audio/sfx/049.opus', m4a: 'audio/sfx/049.m4a' }, null),
    'music.track14': audio('audio.music.track14', { m4a: 'audio/music/track14.m4a' }, { startMs: 0, endMs: 4000 }),
  };
  if (o.withData !== false) {
    const data = (file: string, schema: (typeof ASSET_SCHEMA)[keyof typeof ASSET_SCHEMA]): AssetEntry =>
      ({ type: 'data', group: 'data', confidence: 'exe', src: [], file, schema }) as AssetEntry;
    entries[DATA_KEYS.voiceMap] = data('data/voice-map.json', ASSET_SCHEMA.voiceMap);
    entries[DATA_KEYS.sfxSets] = data('data/sfx-sets.json', ASSET_SCHEMA.sfxSets);
    entries[DATA_KEYS.musicMap] = data('data/music-map.json', ASSET_SCHEMA.musicMap);
  }
  const m = withPackId({
    schema: ASSET_SCHEMA.manifest,
    generator: 'rich4-test/audio@1',
    edition: 'v206',
    license: PACK_LICENSE,
    source: { files: {}, exeSha256: null },
    tools: { ffmpeg: null },
    features: {
      board: false,
      ui: false,
      fx: false,
      minigames: false,
      audio: true,
      voice: true,
      music: true,
      video: false,
      ...o.features,
    },
    groups,
    files,
    entries,
    maps: {},
  });
  const r = safeParsePackManifest(m);
  if (!r.ok) throw new Error(r.issues.join('\n'));
  return r.value;
}

describe('manifestAudioSource', () => {
  it('按格式解析带哈希的路径；缺该格式或非音频条目返回 null', () => {
    const m = buildManifest();
    const src = manifestAudioSource(m, (p) => `/pack/${p}`);
    expect(src.id).toBe(`pack:${m.packId}`);
    expect(src.resolve('sfx.049', 'opus')).toBe(`/pack/${m.files['audio/sfx/049.opus']!.path}`);
    expect(src.resolve('sfx.049', 'm4a')).toMatch(/^\/pack\/audio\/sfx\/049\.[0-9a-f]{8}\.m4a$/);
    expect(src.resolve('music.track14', 'opus')).toBeNull();
    expect(src.resolve(DATA_KEYS.voiceMap, 'opus')).toBeNull();
    expect(src.resolve('nope', 'opus')).toBeNull();
    expect(src.info?.('music.track14')).toEqual({ durationMs: 4000, loop: { startMs: 0, endMs: 4000 } });
    expect(src.has?.('sfx.049')).toBe(true);
    expect(src.has?.(DATA_KEYS.voiceMap)).toBe(false);
  });
});

describe('loadAudioMaps', () => {
  const tables: Record<string, unknown> = {
    'voice-map': testVoiceMap(),
    'sfx-sets': testSfxSets(),
    'music-map': testMusicMap(),
  };
  const fetchJson = (url: string) => {
    const name = /data\/([a-z-]+)\./.exec(url)?.[1] ?? '';
    return Promise.resolve(tables[name]);
  };

  it('引用了不存在音频条目的表整张丢弃（按缺失处理）并给出原因', async () => {
    const m = buildManifest();
    const r = await loadAudioMaps(m, fetchJson);
    expect(r.maps).toEqual({ voiceMap: null, sfxSets: null, musicMap: null });
    expect(r.issues.length).toBe(3);
    expect(r.issues[0]).toMatch(/data\.voice-map: \d+ 处引用无效/);
  });

  it('引用齐全时三张表都可用；结构非法、下载失败、缺表、功能关闭分别处理', async () => {
    const m = buildManifest();
    const good: Record<string, unknown> = {
      'voice-map': null,
      'sfx-sets': {
        schema: ASSET_SCHEMA.sfxSets,
        sets: { 'cue.land.buy': { sfx: ['sfx.049'], confidence: 'exe', src: [] } },
        src: [],
      },
      'music-map': {
        schema: ASSET_SCHEMA.musicMap,
        board: [{ key: 'music.track14', track: 14, confidence: 'exe' }],
        scenes: { bank: { key: 'music.track14', track: 14, confidence: 'exe' } },
        src: [],
      },
    };
    const r = await loadAudioMaps(m, (url) => {
      const name = /data\/([a-z-]+)\./.exec(url)?.[1] ?? '';
      if (name === 'voice-map') return Promise.reject(new Error('HTTP 500'));
      return Promise.resolve(good[name]);
    });
    expect(r.maps.voiceMap).toBeNull();
    expect(r.maps.sfxSets?.sets['cue.land.buy']?.sfx).toEqual(['sfx.049']);
    expect(r.maps.musicMap?.scenes.bank?.key).toBe('music.track14');
    expect(r.issues).toEqual([expect.stringContaining('下载失败')]);

    const bad = await loadAudioMaps(m, () => Promise.resolve({ schema: 'nope' }));
    expect(bad.issues.length).toBe(3);

    const noData = await loadAudioMaps(buildManifest({ withData: false }), fetchJson);
    expect(noData.issues.every((i) => i.includes('没有这张表'))).toBe(true);

    const off = await loadAudioMaps(buildManifest({ features: { voice: false, music: false } }), (url) => {
      const name = /data\/([a-z-]+)\./.exec(url)?.[1] ?? '';
      return Promise.resolve(good[name]);
    });
    expect(off.maps.voiceMap).toBeNull();
    expect(off.maps.musicMap).toBeNull();
    expect(off.maps.sfxSets).not.toBeNull();
    expect(off.issues).toEqual([]);
  });
});

describe('设置绑定', () => {
  it('mixFromSettings：ui 缺省跟随 sfx，语音缺省开启', () => {
    const volume = { master: 0.8, bgm: 0.6, sfx: 0.5, voice: 0.7 };
    expect(mixFromSettings({ volume, muted: false })).toEqual({ ...volume, ui: 0.5, muted: false, voiceEnabled: true });
    expect(mixFromSettings({ volume: { ...volume, ui: 0.2 }, muted: true, voiceEnabled: false })).toEqual({
      ...volume,
      ui: 0.2,
      muted: true,
      voiceEnabled: false,
    });
  });

  it('bindAudioSettings：立即应用一次，之后只在变化时应用；后台策略回调', () => {
    let state = { volume: { master: 0.8, bgm: 0.6, sfx: 0.8, voice: 0.7 }, muted: false };
    const subs = new Set<(s: typeof state, p: typeof state) => void>();
    const store = {
      getState: () => state,
      subscribe: (cb: (s: typeof state, p: typeof state) => void) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    };
    const applied: unknown[] = [];
    const bg: boolean[] = [];
    const off = bindAudioSettings({ setMix: (m) => applied.push(m) }, store, (b) => bg.push(b));
    expect(applied.length).toBe(1);
    const set = (s: typeof state) => {
      const p = state;
      state = s;
      for (const cb of subs) cb(s, p);
    };
    set({ ...state });
    expect(applied.length).toBe(1);
    set({ ...state, muted: true });
    expect(applied.length).toBe(2);
    set({ ...state, muteInBackground: false } as typeof state);
    expect(bg).toEqual([true, false]);
    off();
    set({ ...state, muted: false });
    expect(applied.length).toBe(2);
  });
});
