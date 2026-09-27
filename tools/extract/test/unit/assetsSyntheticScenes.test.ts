/**
 * 合成素材包里原版场景公共组件（ui/classic/common）用到的条目：YES/NO、计算器与命中掩膜、讲话头像、共享 UI 的锚点。
 * 与原版包同键同组同帧数，帧尺寸 / 锚点 / 掩膜区位取客户端布局依赖的原版值。输出到临时目录（不入库）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type PackManifestV1, parsePackManifest } from '@rich4/shared/assets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogV206 } from '../../src/assets/catalog.v206';
import { readPng } from '../../src/assets/pngRead';
import { buildSyntheticPack } from '../../src/assets/synthetic';
import { NUMPAD_REGION, SYNTH_UI_MASKS, SYNTH_UI_SPRITES, synthNumpadMask } from '../../src/assets/syntheticUi';
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
const size = (key: string, f: number): [number, number] => {
  const fr = atlasOf(key).frames[`S#${key}/${f}`]!.frame;
  return [fr.w, fr.h];
};
const anchor = (key: string, f: number): [number, number] => atlasOf(key).meta.r4.anchorsPx[`S#${key}/${f}`]!;

beforeAll(async () => {
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-synth-scenes-')));
  dir = path.join(root, '.cache', 'synthetic-pack');
  const ctx = new ExtractContext({ root, logger: { out: () => {}, err: () => {} } });
  await buildSyntheticPack({ ctx, outDir: dir });
  m = parsePackManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('合成包：原版场景公共组件的条目', () => {
  it('YES/NO、计算器、12 套讲话头像与原版包同键同组同帧数', () => {
    const cat = new Map(catalogV206().items.map((it) => [it.key, it]));
    const keys = ['ui.yesno', 'ui.numpad', ...Array.from({ length: 12 }, (_, c) => `portrait.speaker.${c}`)];
    for (const k of keys) {
      expect(SYNTH_UI_SPRITES, k).toContain(k);
      const e = m.entries[k]!;
      const it = cat.get(k)!;
      expect(e.type, k).toBe('sprite');
      expect(e.group, k).toBe(it.group);
      expect(e.confidence, k).not.toBe('guess');
      if (e.type === 'sprite' && it.type === 'sprite') expect(e.frames.count, k).toBe(it.frames);
    }
  });

  it('帧尺寸与锚点：YES/NO 96×48、计算器各部件、讲话头像居中、共享 UI 的讲话框 / 消息框 / 气泡锚点同原版', () => {
    for (let f = 0; f < 3; f++) expect(size('ui.yesno', f)).toEqual([96, 48]);
    expect(size('ui.numpad', 0)).toEqual([128, 192]);
    expect(size('ui.numpad', 1)).toEqual([108, 12]);
    expect(size('ui.numpad', 2)).toEqual([49, 25]);
    expect(size('ui.numpad', 3)).toEqual([57, 25]);
    for (let f = 4; f < 16; f++) expect(size('ui.numpad', f)).toEqual([33, 17]);
    for (let f = 16; f < 26; f++) expect(size('ui.numpad', f)).toEqual([9, 19]);
    for (let c = 0; c < 12; c++) {
      const k = `portrait.speaker.${c}`;
      expect(size(k, 0)).toEqual([72, 72]);
      expect(anchor(k, 0)).toEqual([36, 36]);
      for (let f = 1; f <= 4; f++) expect(anchor(k, f)).toEqual([17, 17]);
    }
    expect(anchor('ui.common', 0)).toEqual([0, 0]);
    expect(anchor('ui.common', 1)).toEqual([0, 116]);
    expect(anchor('ui.common', 2)).toEqual([139, 0]);
    expect(anchor('ui.common', 3)).toEqual([139, 116]);
    expect(size('ui.common', 5)).toEqual([195, 133]);
    expect(anchor('ui.common', 5)).toEqual([97, 81]);
    expect(size('ui.common', 6)).toEqual([210, 154]);
    expect(anchor('ui.common', 6)).toEqual([98, 69]);
  });

  it('计算器命中掩膜：128×192、16 区，键区包围盒与原版 Panel#22 逐像素统计一致', () => {
    const e = m.entries['ui.numpad.mask']!;
    expect(e.type === 'mask' && [e.w, e.h, e.regions, e.group]).toEqual([128, 192, 16, 'ui.dialog']);
    expect(Object.keys(SYNTH_UI_MASKS)).toContain('ui.numpad.mask');
    const png = readPng(
      new Uint8Array(readFileSync(path.join(dir, m.files[e.type === 'mask' ? e.file : '']!.path))),
      'm',
    );
    expect(png.gray).toEqual(synthNumpadMask());
    const boxes = new Map<number, [number, number, number, number]>();
    const data = synthNumpadMask();
    for (let y = 0; y < 192; y++) {
      for (let x = 0; x < 128; x++) {
        const v = data[y * 128 + x]!;
        const b = boxes.get(v) ?? [x, y, x, y];
        boxes.set(v, [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]);
      }
    }
    // 原版（本机 v2.06 Panel#22）：2 MAX x8..54 y64..87、3 ↵ x64..119、4–6 第一排 y96..111、7–9 y121..135、
    // 10–12 y144..159、13–15 y168..183、16 计量条 x9..118 y41..54
    expect(boxes.get(NUMPAD_REGION.max)).toEqual([8, 64, 54, 87]);
    expect(boxes.get(NUMPAD_REGION.enter)).toEqual([64, 64, 119, 87]);
    expect(boxes.get(4)).toEqual([8, 96, 39, 111]);
    expect(boxes.get(6)).toEqual([88, 96, 119, 111]);
    expect(boxes.get(8)).toEqual([48, 121, 79, 135]);
    expect(boxes.get(12)).toEqual([88, 144, 119, 159]);
    expect(boxes.get(13)).toEqual([8, 168, 39, 183]);
    expect(boxes.get(NUMPAD_REGION.meter)).toEqual([9, 41, 118, 54]);
    expect(new Set(data)).toEqual(new Set(Array.from({ length: 16 }, (_, i) => i + 1)));
  });
});
