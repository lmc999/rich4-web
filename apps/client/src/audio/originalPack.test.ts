// 本机原版素材包核对（仅在本机有 rich4-assets/ 或 RICH4_ASSETS_DIR 时运行；CI 只用合成素材包，自动跳过）：
// soundMap 与导演层引用的音效集名、NPC / 新闻键、场景曲在真实映射表里都存在；真实自对弈事件解析出的语音键都在 manifest 里。
// 只读取素材包，不输出任何台词文本。
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHARACTER_COUNT,
  DATA_KEYS,
  MUSIC_SCENES,
  type PackManifestV1,
  safeParseMusicMap,
  safeParsePackManifest,
  safeParseSfxSets,
  safeParseVoiceMap,
} from '@rich4/shared/assets';
import { buildMapIndex, buildTestMap } from '@rich4/shared/data';
import type { GameEvent } from '@rich4/shared/engine';
import { describe, expect, it } from 'vitest';
import { selfPlay } from '../test/selfPlay';
import { makeSoundQuery } from './cues';
import { sceneCueFor, voiceFor } from './selectors';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '../../../..');
const packDir = process.env.RICH4_ASSETS_DIR ? resolve(process.env.RICH4_ASSETS_DIR) : join(repoRoot, 'rich4-assets');
const hasPack = existsSync(join(packDir, 'manifest.json'));

function load() {
  const m = safeParsePackManifest(JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8')));
  if (!m.ok) throw new Error(m.issues.join('\n'));
  const manifest: PackManifestV1 = m.value;
  const data = (key: string): unknown => {
    const e = manifest.entries[key];
    if (e?.type !== 'data') throw new Error(`no ${key}`);
    return JSON.parse(readFileSync(join(packDir, manifest.files[e.file]!.path), 'utf8'));
  };
  const unwrap = <T>(r: { ok: true; value: T } | { ok: false; issues: string[] }): T => {
    if (!r.ok) throw new Error(r.issues.join('\n'));
    return r.value;
  };
  return {
    manifest,
    voiceMap: unwrap(safeParseVoiceMap(data(DATA_KEYS.voiceMap))),
    sfxSets: unwrap(safeParseSfxSets(data(DATA_KEYS.sfxSets))),
    musicMap: unwrap(safeParseMusicMap(data(DATA_KEYS.musicMap))),
  };
}

const src = (f: string) => readFileSync(join(here, f), 'utf8');

describe.skipIf(!hasPack)('本机原版素材包', () => {
  it('soundMap 与界面音引用的 cue.<name> 音效集都存在', () => {
    const { sfxSets } = load();
    const text = src('../presentation/soundMap.ts') + src('director.ts');
    const cues = new Set<string>();
    for (const m of text.matchAll(/\b(?:z|flic)\('\w+', '([\w.]+)'\)/g)) cues.add(m[1]!);
    for (const m of text.matchAll(/\bcue: '([\w.]+)'/g)) cues.add(m[1]!);
    expect(cues.size).toBeGreaterThan(15);
    const missing = [...cues].filter((c) => !Object.hasOwn(sfxSets.sets, `cue.${c}`)).sort();
    expect(missing).toEqual([]);
  });

  it('NPC、点名、新闻与命运键都存在', () => {
    const { voiceMap } = load();
    const text = src('../presentation/soundMap.ts');
    const npc = new Set<string>();
    for (const m of text.matchAll(/k: 'npc', key: '([\w.]+)'/g)) npc.add(m[1]!);
    for (let i = 0; i < 12; i++) npc.add(`magic.condition.${i}`);
    for (const m of text.matchAll(/base: '([\w.]+)'/g)) {
      for (let c = 0; c < CHARACTER_COUNT; c++) npc.add(`${m[1]}.${c}`);
    }
    expect(npc.size).toBeGreaterThan(40);
    expect([...npc].filter((k) => !Object.hasOwn(voiceMap.npc, k)).sort()).toEqual([]);
    const news: string[] = [];
    for (let i = 0; i < 36; i++) news.push(`news.${i}`);
    for (let i = 0; i < 37; i++) news.push(`fate.${i}`);
    expect(news.filter((k) => !Object.hasOwn(voiceMap.news, k))).toEqual([]);
  });

  it('音乐：棋盘 8 首、全部场景曲可解析，银行 = track14；场景曲有循环区间', () => {
    const { manifest, musicMap } = load();
    expect(musicMap.board.map((t) => t.track)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    for (const s of MUSIC_SCENES) expect(musicMap.scenes[s], s).toBeDefined();
    expect(musicMap.scenes.bank).toMatchObject({ key: 'music.track14', track: 14 });
    for (const s of MUSIC_SCENES) {
      const e = manifest.entries[musicMap.scenes[s]!.key];
      expect(e?.type).toBe('audio');
      if (e?.type === 'audio') expect(e.loop, s).not.toBeNull();
    }
  });

  it('真实自对弈事件解析出的语音键都在 manifest 里', () => {
    const { manifest, voiceMap } = load();
    const map = buildMapIndex(buildTestMap());
    let n = 0;
    for (const seed of [3]) {
      const sp = selfPlay({ seed, steps: 300 });
      let view = sp.initial.view;
      for (const b of sp.batches) {
        b.events.forEach((raw, i) => {
          const v = view;
          const q = makeSoundQuery(() => v, map);
          for (const x of voiceFor(raw as GameEvent, q, voiceMap, { epoch: 1, seq: b.seq, eventIndex: i })) {
            expect(manifest.entries[x.key]?.type, x.key).toBe('audio');
            n++;
          }
          sceneCueFor(raw as GameEvent, q);
        });
        view = b.view;
      }
    }
    expect(n).toBeGreaterThan(0);
  });
});
