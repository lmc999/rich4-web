/**
 * 合成素材包里小游戏原版视图（原版皮肤 A13）用到的条目：与原版包同键同组同帧数，客户端依赖的帧尺寸 / 锚点取原版值
 * （底图 640×480、HUD 数字 15×28、气球大 44×141 锚点 (22,30) / 小 36×116 锚点 (18,26) / 爆开 60×122 锚点 (28,40)），
 * 大号数字与接物者的尺寸锚点是我们自己的取值（原版逐帧不同，客户端不依赖），企鹅掩膜区号 = 格号，
 * READY GO 640×480×20 帧 × 114 ms。输出到临时目录（不入库）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type PackManifestV1, parsePackManifest } from '@rich4/shared/assets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogV206 } from '../../src/assets/catalog.v206';
import { readPng } from '../../src/assets/pngRead';
import { buildSyntheticPack } from '../../src/assets/synthetic';
import { SYNTH_MINIGAMES } from '../../src/assets/syntheticUi';
import { ExtractContext, realpathLoose } from '../../src/context';

let root: string;
let dir: string;
let m: PackManifestV1;

interface AtlasJson {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
  meta: { r4: { anchorsPx: Record<string, [number, number]> } };
}

const atlasOf = (key: string): AtlasJson => {
  const e = m.entries[key]!;
  if (e.type !== 'sprite') throw new Error(key);
  return JSON.parse(readFileSync(path.join(dir, m.files[e.atlas[0]!]!.path), 'utf8')) as AtlasJson;
};
const dims = (key: string, f: number): [number, number, number, number] => {
  const a = atlasOf(key);
  const fr = a.frames[`S#${key}/${f}`]!.frame;
  const [ax, ay] = a.meta.r4.anchorsPx[`S#${key}/${f}`]!;
  return [fr.w, fr.h, ax, ay];
};

beforeAll(async () => {
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-synth-mg-')));
  dir = path.join(root, '.cache', 'synthetic-pack');
  const ctx = new ExtractContext({ root, logger: { out: () => {}, err: () => {} } });
  await buildSyntheticPack({ ctx, outDir: dir });
  m = parsePackManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('合成包：小游戏条目', () => {
  it('精灵、整图、掩膜、FLC 与原版包同键同组同帧数（置信度非 guess）', () => {
    const cat = new Map(catalogV206().items.map((it) => [it.key, it]));
    const all = [
      ...SYNTH_MINIGAMES.sprites,
      ...SYNTH_MINIGAMES.images,
      ...SYNTH_MINIGAMES.masks,
      ...SYNTH_MINIGAMES.flics,
    ];
    // 精灵 31（HUD 1、企鹅 10、气球 1、喜从天降 7 + 12 个角色）+ 整图 1 + 掩膜 1 + FLC 1
    expect(all).toHaveLength(34);
    for (const k of all) {
      const e = m.entries[k];
      const it = cat.get(k);
      expect(e, k).toBeDefined();
      expect(it, k).toBeDefined();
      expect(e!.type, k).toBe(it!.type);
      expect(e!.group, k).toBe(it!.group);
      expect(e!.confidence, k).not.toBe('guess');
      expect(Object.hasOwn(m.groups, e!.group), k).toBe(true);
      if (e!.type === 'sprite' && it!.type === 'sprite') expect(e!.frames.count, k).toBe(it!.frames);
    }
  });

  it('客户端依赖的帧尺寸与锚点同原版', () => {
    expect(dims('mg.penguin.screen', 0)).toEqual([640, 480, 0, 0]);
    expect(dims('mg.balloon.screen', 0)).toEqual([640, 480, 0, 0]);
    for (let d = 0; d < 10; d++) expect(dims('mg.common.hud', d).slice(0, 2)).toEqual([15, 28]);
    for (let f = 1; f <= 6; f++) expect(dims('mg.balloon.screen', f)).toEqual([44, 141, 22, 30]);
    for (let f = 7; f <= 12; f++) expect(dims('mg.balloon.screen', f)).toEqual([36, 116, 18, 26]);
    expect(dims('mg.balloon.screen', 13)).toEqual([60, 122, 28, 40]);
    const bg = m.entries['mg.xicong.bg']!;
    expect(bg.type === 'image' ? [bg.w, bg.h, bg.transparency] : null).toEqual([640, 480, 'opaque']);
    const rd = m.entries['mg.ready']!;
    expect(rd.type === 'flic' ? [rd.w, rd.h, rd.frames, rd.frameMs, rd.transparency] : null).toEqual([
      640,
      480,
      20,
      114,
      'index0',
    ]);
  });

  it('我们自己的取值（与原版逐帧不同，客户端按图集逐帧尺寸与锚点绘制、不依赖）：大号数字与接物者', () => {
    // 原版：hud 图15 = 58×78 锚点 (26,37)；接物者 3 图0 = 51×68 锚点 (20,66)
    expect(dims('mg.common.hud', 15)).toEqual([60, 76, 30, 38]);
    expect(dims('mg.xicong.char.3', 0)).toEqual([66, 72, 33, 71]);
  });

  it('企鹅掩膜：区号 = 64 个有效格的格号（冰屋 40 不在内），最大 77', () => {
    const e = m.entries['mg.penguin.mask']!;
    if (e.type !== 'mask') throw new Error('mask');
    expect(e.regions).toBe(77);
    const img = readPng(readFileSync(path.join(dir, m.files[e.file]!.path)));
    const seen = new Set<number>();
    for (let i = 0; i < img.w * img.h; i++) seen.add(img.rgba[i * 4]!);
    seen.delete(0);
    expect(seen.size).toBe(64);
    expect(seen.has(40)).toBe(false);
    // 格心（x = 48(r+c) − 64，y = 24(r−c) + 225）落在本格
    const at = (x: number, y: number) => img.rgba[(y * img.w + x) * 4]!;
    expect(at(48 * (6 + 2) - 64, 24 * (6 - 2) + 225)).toBe(56);
    expect(at(48 * (0 + 3) - 64, 24 * (0 - 3) + 225)).toBe(3);
  });
});
