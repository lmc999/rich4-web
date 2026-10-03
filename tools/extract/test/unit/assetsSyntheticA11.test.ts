/**
 * 合成素材包里原版通用对话框与弹窗（ui/classic/dialogs、ui/classic/popups，original-skin.md §5 A11）用到的条目：
 * 光标、卡片欄 / 道具欄、道具小图标、选择玩家窗、新闻板、老虎机、四个转盘、月结颁奖、资产表、托管对话框，
 * 以及卡片插画与新闻插图整图。与原版包同键同组同帧数，客户端布局依赖的帧尺寸与锚点取原版值（转盘帧锚点等客户端
 * 不依赖的项按我们自己的取值，单独标注）。输出到临时目录（不入库）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type PackManifestV1, parsePackManifest } from '@rich4/shared/assets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogV206 } from '../../src/assets/catalog.v206';
import { readPng } from '../../src/assets/pngRead';
import { buildSyntheticPack } from '../../src/assets/synthetic';
import { SYNTH_A11, SYNTH_HOLIDAY_ART, SYNTH_UI_SPRITES } from '../../src/assets/syntheticUi';
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
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-synth-a11-')));
  dir = path.join(root, '.cache', 'synthetic-pack');
  const ctx = new ExtractContext({ root, logger: { out: () => {}, err: () => {} } });
  await buildSyntheticPack({ ctx, outDir: dir });
  m = parsePackManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
}, 120_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('合成包：原版通用对话框与弹窗的条目', () => {
  it('精灵与原版包同键同组同帧数、置信度不是 guess', () => {
    const cat = new Map(catalogV206().items.map((it) => [it.key, it]));
    expect(SYNTH_A11.sprites).toEqual(
      expect.arrayContaining([
        'ui.cursor',
        'ui.itemBar',
        'ui.itemIcons',
        'ui.playerPicker',
        'ui.newsBoard',
        'ui.godSlot',
        'ui.roulette.0',
        'ui.roulette.3',
        'venue.monthly.screen',
        'venue.assets.screen',
        'ui.autoplay',
        'ui.saveLoad',
      ]),
    );
    for (const k of SYNTH_A11.sprites) {
      expect(SYNTH_UI_SPRITES, k).toContain(k);
      const e = m.entries[k]!;
      const it = cat.get(k)!;
      expect(e.type, k).toBe('sprite');
      expect(e.group, k).toBe(it.group);
      expect(e.confidence, k).not.toBe('guess');
      if (e.type === 'sprite' && it.type === 'sprite') expect(e.frames.count, k).toBe(it.frames);
    }
  });

  it('帧尺寸与锚点：客户端布局依赖的几项同原版', () => {
    expect(size('ui.cursor', 27)).toEqual([30, 31]);
    expect(anchor('ui.cursor', 27)).toEqual([10, 2]);
    expect(anchor('ui.cursor', 41)).toEqual([1, 1]);
    expect(size('ui.itemBar', 0)).toEqual([412, 180]);
    expect(size('ui.itemBar', 1)).toEqual([412, 180]);
    expect(anchor('ui.itemBar', 2)).toEqual([20, 17]);
    expect(size('ui.playerPicker', 0)).toEqual([177, 97]);
    expect(anchor('ui.playerPicker', 2)).toEqual([168, 48]);
    expect(size('ui.newsBoard', 1)).toEqual([440, 480]);
    expect(anchor('ui.godSlot', 0)).toEqual([96, 98]);
    expect(anchor('ui.godSlot', 1)).toEqual([78, 98]);
    expect(anchor('ui.godSlot', 3)).toEqual([0, -35]);
    for (let f = 4; f < 24; f++) expect(size('ui.godSlot', f)).toEqual([38, 36]);
    for (let w = 0; w < 4; w++) expect(anchor(`ui.roulette.${w}`, 0)).toEqual([-6, 0]);
    expect(size('venue.monthly.screen', 0)).toEqual([640, 480]);
    expect(size('venue.monthly.screen', 5)).toEqual([353, 450]);
    expect(anchor('venue.monthly.screen', 2)).toEqual([139, 49]);
    expect(anchor('venue.monthly.screen', 47)).toEqual([33, 36]);
    for (let f = 0; f < 3; f++) expect(size('venue.assets.screen', f)).toEqual([640, 480]);
    expect(anchor('venue.assets.screen', 5)).toEqual([29, 9]);
    expect(size('venue.assets.screen', 12)).toEqual([97, 40]);
    expect(size('ui.autoplay', 0)).toEqual([435, 355]);
    expect(anchor('ui.autoplay', 6)).toEqual([42, 34]);
    expect(size('ui.saveLoad', 0)).toEqual([555, 451]);
    expect(size('ui.saveLoad', 1)).toEqual([555, 381]);
  });

  it('我们自己的取值：转盘帧锚点一律 (82,82)（原版逐帧在 81..83 之间浮动；客户端按逐帧锚点绘制、不依赖）', () => {
    for (let w = 0; w < 4; w++) {
      for (let f = 2; f < 14; f++) expect(anchor(`ui.roulette.${w}`, f)).toEqual([82, 82]);
    }
  });

  it('卡片插画 30 张（165×256）、新闻插图 36 张、命运插图 40 张（388×251），都是不透明整图；卡片 k 的文件是按 card.k 画的那一张', () => {
    expect(SYNTH_A11.images).toHaveLength(106);
    for (const k of SYNTH_A11.images) {
      const e = m.entries[k]!;
      expect(e.type, k).toBe('image');
      if (e.type !== 'image') continue;
      const card = k.startsWith('card.');
      const fate = k.startsWith('illustration.fate.');
      expect([e.w, e.h], k).toEqual(card ? [165, 256] : [388, 251]);
      expect(e.transparency, k).toBe('opaque');
      // 置信度跟资源目录：卡片插画（0x440bea）与命运插图（插图表 0x473dd8）有 exe 证据，新闻插图目视
      expect(e.confidence, k).toBe(card || fate ? 'exe' : 'visual');
    }
    // 40 张命运插图各不相同（按插图号画），客户端测试能区分 33–36 按图换图
    const fateFiles = new Set(
      Array.from({ length: 40 }, (_, i) => {
        const e = m.entries[`illustration.fate.${i}`]!;
        if (e.type !== 'image') throw new Error(`illustration.fate.${i}`);
        return m.files[e.file]!.sha256;
      }),
    );
    expect(fateFiles.size).toBe(40);
    const files = new Set<string>();
    for (let k = 1; k <= 30; k++) {
      const e = m.entries[`card.${k}`]!;
      if (e.type !== 'image') throw new Error(`card.${k}`);
      expect(e.file).toBe(`images/synthetic-ui/card.${k}.png`);
      files.add(m.files[e.file]!.sha256);
    }
    // 30 张各不相同（按卡号画的色块与点数）
    expect(files.size).toBe(30);
    const e = m.entries['card.7']!;
    if (e.type !== 'image') throw new Error('card.7');
    const png = readPng(readFileSync(path.join(dir, m.files[e.file]!.path)));
    expect([png.w, png.h]).toEqual([165, 256]);
    // 不透明：四角是黑色（与原版卡片一样），没有 alpha < 255 的像素
    expect([...png.rgba.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    for (let i = 3; i < png.rgba.length; i += 4) if (png.rgba[i] !== 255) throw new Error(`card.7 像素 ${i >> 2} 透明`);
    // 命运插图（插图表 exe 0x473dd8 已核实）：合成包给全 40 张，原版命运板在 E2E 原版配置下可用
    expect(m.entries['illustration.fate.0']).toMatchObject({ type: 'image', group: 'illustration.fate' });
  });
});

describe('合成包：节日插画占位（四张图各自的首末 slot）', () => {
  it('键 = illustration.holiday.<[0,24,43,63][gm] + slot>，与原版包同组同尺寸；8 张内容各不相同', () => {
    const cat = new Map(catalogV206().items.map((it) => [it.key, it]));
    expect(SYNTH_HOLIDAY_ART.map((h) => h.key)).toEqual(
      [0, 23, 24, 42, 43, 61, 63, 82].map((n) => `illustration.holiday.${n}`),
    );
    const shas = new Set<string>();
    for (const { key } of SYNTH_HOLIDAY_ART) {
      const e = m.entries[key]!;
      expect(e.type, key).toBe('image');
      if (e.type !== 'image') continue;
      expect([e.w, e.h, e.transparency, e.group], key).toEqual([200, 200, 'opaque', cat.get(key)!.group]);
      expect(e.confidence, key).toBe('exe');
      shas.add(m.files[e.file]!.sha256);
      const png = readPng(readFileSync(path.join(dir, m.files[e.file]!.path)));
      expect([png.w, png.h], key).toEqual([200, 200]);
    }
    expect(shas.size).toBe(8);
    // 其余 slot 只在原版包里有
    expect(m.entries['illustration.holiday.1']).toBeUndefined();
  });
});
