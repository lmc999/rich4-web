/**
 * 合成素材包里原版皮肤 A14 画面用到的条目：标题（title.screen = Data#1）、开局设置部件（title.setup.ui = jump#4）、
 * 36 段侧视走动（title.sidewalk.<c>.<v> = jump#5+3c+v）、开局背景（title.setup.bg = jump#0）、Loading（title.loading = Data#560）。
 * 与原版包同键同组同帧数；客户端布局依赖的帧尺寸与锚点同原版；输出到临时目录（不入库）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type PackManifestV1, parsePackManifest } from '@rich4/shared/assets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogV206 } from '../../src/assets/catalog.v206';
import { readPng } from '../../src/assets/pngRead';
import { buildSyntheticPack } from '../../src/assets/synthetic';
import {
  SYNTH_SETUP_BOXES,
  SYNTH_SETUP_FRAME_SPECS,
  SYNTH_TITLE_FRAME_SPECS,
  SYNTH_TITLE_IMAGES,
  SYNTH_TITLE_SPRITES,
} from '../../src/assets/syntheticUi';
import { ExtractContext, realpathLoose } from '../../src/context';

let root: string;
let dir: string;
let m: PackManifestV1;

interface AtlasJson {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
  meta: { image: string; r4: { anchorsPx: Record<string, [number, number]> } };
}

const atlasOf = (key: string): AtlasJson => {
  const e = m.entries[key]!;
  if (e.type !== 'sprite') throw new Error(key);
  return JSON.parse(readFileSync(path.join(dir, m.files[e.atlas[0]!]!.path), 'utf8')) as AtlasJson;
};
const size = (key: string, f: number): [number, number] => {
  const fr = atlasOf(key).frames[`S#${key}/${f}`]!.frame;
  return [fr.w, fr.h];
};
const anchor = (key: string, f: number): [number, number] => atlasOf(key).meta.r4.anchorsPx[`S#${key}/${f}`]!;

beforeAll(async () => {
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-synth-title-')));
  dir = path.join(root, '.cache', 'synthetic-pack');
  const ctx = new ExtractContext({ root, logger: { out: () => {}, err: () => {} } });
  await buildSyntheticPack({ ctx, outDir: dir });
  m = parsePackManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
}, 120_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('合成包：A14 标题 / 开局 / 选人 / Loading 条目', () => {
  it('与原版包同键同组同帧数，置信度不是 guess', () => {
    const cat = new Map(catalogV206().items.map((it) => [it.key, it]));
    expect(SYNTH_TITLE_SPRITES).toContain('title.screen');
    expect(SYNTH_TITLE_SPRITES).toContain('title.setup.ui');
    expect(SYNTH_TITLE_SPRITES.filter((k) => k.startsWith('title.sidewalk.'))).toHaveLength(36);
    for (const k of SYNTH_TITLE_SPRITES) {
      const e = m.entries[k]!;
      const it = cat.get(k)!;
      expect(e.type, k).toBe('sprite');
      expect(e.group, k).toBe(it.group);
      expect(e.confidence, k).not.toBe('guess');
      if (e.type === 'sprite' && it.type === 'sprite') expect(e.frames.count, k).toBe(it.frames);
    }
    for (const k of SYNTH_TITLE_IMAGES) {
      const e = m.entries[k]!;
      expect(e.type, k).toBe('image');
      expect(e.group, k).toBe(cat.get(k)!.group);
      if (e.type === 'image') expect([e.w, e.h], k).toEqual([640, 480]);
    }
  });

  it('标题与开局部件的帧尺寸、锚点同原版（客户端按它们排版）', () => {
    SYNTH_TITLE_FRAME_SPECS.forEach((sp, f) => {
      expect(size('title.screen', f), `title.screen/${f}`).toEqual([sp.w, sp.h]);
      expect(anchor('title.screen', f), `title.screen/${f}`).toEqual([sp.ax, sp.ay]);
    });
    expect(size('title.screen', 2)).toEqual([116, 113]);
    expect(anchor('title.screen', 2)).toEqual([59, 57]);
    SYNTH_SETUP_FRAME_SPECS.forEach((sp, f) => {
      expect(size('title.setup.ui', f), `title.setup.ui/${f}`).toEqual([sp.w, sp.h]);
      expect(anchor('title.setup.ui', f), `title.setup.ui/${f}`).toEqual([sp.ax, sp.ay]);
    });
    expect(size('title.setup.ui', 0)).toEqual([440, 155]);
    expect(size('title.setup.ui', 1)).toEqual([192, 461]);
    expect(SYNTH_SETUP_BOXES).toHaveLength(6);
  });

  it('侧视走动：锚点在脚底（画点 = 脚底中点）；整图是不透明 PNG', () => {
    for (const v of ['walk', 'moto', 'car']) {
      const [w, h] = size(`title.sidewalk.0.${v}`, 0);
      const [ax, ay] = anchor(`title.sidewalk.0.${v}`, 0);
      expect(ay, v).toBeGreaterThanOrEqual(h - 1);
      expect(Math.abs(ax - w / 2), v).toBeLessThanOrEqual(3);
    }
    for (const k of SYNTH_TITLE_IMAGES) {
      const e = m.entries[k]!;
      if (e.type !== 'image') throw new Error(k);
      const png = readPng(readFileSync(path.join(dir, m.files[e.file]!.path)));
      expect([png.w, png.h], k).toEqual([640, 480]);
    }
  });
});
