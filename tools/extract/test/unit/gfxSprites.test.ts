import { describe, expect, it } from 'vitest';
import { GfxError } from '../../src/gfx/errors';
import { GND_TILES_OFFSET_72, gndByteLength, gndToIndexed, gndToRgba, parseGnd, splitIndexed } from '../../src/gfx/gnd';
import { decodeRaw16, RAW16_SIZES, raw16Dims } from '../../src/gfx/raw16';
import {
  countBit15,
  EXPAND5,
  expand5,
  paletteToRgb,
  paletteToRgba,
  rgb555RunToRgba,
  rgb555ToRgb,
} from '../../src/gfx/rgb555';
import { decodeSmpFrame, parseSmp, smpFrameBytes } from '../../src/gfx/smp';
import { countOwnerPixels, decodeSprFrame, parseSpr, sprFrameIndexed, sprFrameIndices } from '../../src/gfx/spr';
import { buildGnd, buildSmp, buildSpr } from '../helpers/buildGfx';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GfxError);
    return (e as GfxError).code;
  }
  throw new Error('应抛 GfxError');
};

const rgb555 = (r: number, g: number, b: number): number => (r << 10) | (g << 5) | b;

describe('RGB555', () => {
  it('5→8 位按 x<<3|x>>2 扩展', () => {
    expect(EXPAND5.length).toBe(32);
    expect([expand5(0), expand5(1), expand5(15), expand5(16), expand5(31)]).toEqual([0, 8, 123, 132, 255]);
    expect(rgb555ToRgb(rgb555(31, 0, 16))).toEqual([255, 0, 132]);
    expect(rgb555ToRgb(0x7fff)).toEqual([255, 255, 255]);
  });

  it('调色板与像素串转换', () => {
    const pal = Uint16Array.of(rgb555(1, 2, 3), rgb555(31, 31, 31));
    expect([...paletteToRgba(pal)]).toEqual([8, 16, 24, 255, 255, 255, 255, 255]);
    expect([...paletteToRgba(pal, { transparentIndex: 0 })]).toEqual([0, 0, 0, 0, 255, 255, 255, 255]);
    expect([...paletteToRgb(pal)]).toEqual([8, 16, 24, 255, 255, 255]);
    const px = Uint8Array.of(0, 0, 0x1f, 0x00);
    expect([...rgb555RunToRgba(px, 0, 2)]).toEqual([0, 0, 0, 255, 0, 0, 255, 255]);
    expect([...rgb555RunToRgba(px, 0, 2, { zeroTransparent: true })]).toEqual([0, 0, 0, 0, 0, 0, 255, 255]);
    expect(countBit15(Uint8Array.of(0, 0x80, 0xff, 0x7f), 0, 2)).toBe(1);
  });
});

describe('SPR', () => {
  // palette[0] 故意不是黑色：透明按索引 0 判定，与颜色无关
  const palette = new Array<number>(256).fill(0);
  palette[0] = rgb555(31, 0, 0);
  palette[1] = rgb555(0, 31, 0);
  palette[2] = rgb555(0, 0, 0);
  palette[255] = rgb555(31, 0, 31);
  const bytes = buildSpr(
    [
      { w: 3, h: 2, ax: 1, ay: 1, pixels: [0, 1, 2, 255, 1, 0] },
      { w: 1, h: 1, ax: -5, ay: 7, pixels: [255] },
      { w: 0, h: 0, pixels: [] },
    ],
    palette,
  );

  it('解析帧表、锚点、调色板', () => {
    const s = parseSpr(bytes, 't.spr');
    expect(s.count).toBe(3);
    expect(s.start).toBe(12 + 36);
    expect(s.pixelBase).toBe(s.start + 512);
    expect(s.frames.map((f) => [f.w, f.h, f.ax, f.ay, f.gsize])).toEqual([
      [3, 2, 1, 1, 6],
      [1, 1, -5, 7, 1],
      [0, 0, 0, 0, 0],
    ]);
    expect(s.palette[1]).toBe(rgb555(0, 31, 0));
    expect([...sprFrameIndices(s, 0)]).toEqual([0, 1, 2, 255, 1, 0]);
    expect(countOwnerPixels(s)).toBe(2);
  });

  it('索引 0 透明（RGBA 全 0），黑色索引不透明；默认 255 是普通颜色', () => {
    const f = decodeSprFrame(parseSpr(bytes), 0);
    expect([f.w, f.h, f.ax, f.ay]).toEqual([3, 2, 1, 1]);
    expect([...f.rgba]).toEqual([
      0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 255, 255, 0, 255, 255, 0, 255, 0, 255, 0, 0, 0, 0,
    ]);
    expect(f.mask).toBeNull();
    expect(f.ownerPixels).toBe(1);
  });

  it('ownerMask：索引 255 → 透明 + 掩膜 255', () => {
    const f = decodeSprFrame(parseSpr(bytes), 0, { ownerMask: true });
    expect([...f.rgba.subarray(12, 16)]).toEqual([0, 0, 0, 0]);
    expect([...f.mask!]).toEqual([0, 0, 0, 255, 0, 0]);
    const g = decodeSprFrame(parseSpr(bytes), 1, { ownerMask: true });
    expect([...g.mask!]).toEqual([255]);
  });

  it('索引图输出', () => {
    const img = sprFrameIndexed(parseSpr(bytes), 0);
    expect(img.palette.length).toBe(768);
    expect([...img.palette.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect([...img.pixels]).toEqual([0, 1, 2, 255, 1, 0]);
  });

  it('自洽校验：魔数、start、gsize、闭合、负尺寸、帧号', () => {
    expect(code(() => parseSpr(bytes.subarray(0, 8)))).toBe('E_SPR_TRUNCATED');
    const smpBytes = buildSmp([{ w: 1, h: 1, pixels: [1] }]);
    expect(code(() => parseSpr(smpBytes))).toBe('E_SPR_MAGIC');
    const badStart = bytes.slice();
    badStart[8] = (badStart[8]! + 1) & 0xff;
    expect(code(() => parseSpr(badStart))).toBe('E_SPR_START');
    const badG = bytes.slice();
    badG[12 + 8] = 7;
    expect(code(() => parseSpr(badG))).toBe('E_SPR_GSIZE');
    expect(code(() => parseSpr(bytes.subarray(0, bytes.length - 1)))).toBe('E_SPR_CLOSURE');
    const extra = new Uint8Array(bytes.length + 1);
    extra.set(bytes);
    expect(code(() => parseSpr(extra))).toBe('E_SPR_CLOSURE');
    const neg = buildSpr([{ w: -1, h: 0, pixels: [] }], palette);
    expect(code(() => parseSpr(neg))).toBe('E_SPR_FRAME_SIZE');
    expect(code(() => decodeSprFrame(parseSpr(bytes), 3))).toBe('E_SPR_FRAME_INDEX');
  });
});

describe('SMP', () => {
  const bytes = buildSmp([{ w: 2, h: 2, ax: 1, ay: 2, pixels: [0, rgb555(31, 31, 31), rgb555(0, 0, 1), 0] }]);

  it('0x0000 透明；opaque 模式输出不透明黑', () => {
    const s = parseSmp(bytes);
    expect(s.pixelBase).toBe(s.start);
    expect(smpFrameBytes(s, 0).length).toBe(8);
    const f = decodeSmpFrame(s, 0);
    expect([f.w, f.h, f.ax, f.ay]).toEqual([2, 2, 1, 2]);
    expect([...f.rgba]).toEqual([0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 8, 255, 0, 0, 0, 0]);
    const o = decodeSmpFrame(s, 0, { opaque: true });
    expect([...o.rgba.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...o.rgba.subarray(12, 16)]).toEqual([0, 0, 0, 255]);
  });

  it('gsize 必须为 2·w·h', () => {
    const bad = bytes.slice();
    bad[12 + 8] = 4;
    expect(code(() => parseSmp(bad))).toBe('E_SMP_GSIZE');
  });
});

describe('GND', () => {
  const palette = Array.from({ length: 256 }, (_, i) => rgb555(i & 31, 0, 0));
  const tile = (v: number) => new Uint8Array(1024).fill(v);
  // 3 列 × 2 行，排布表非恒等：屏幕块 i 使用图块 5−i
  const bytes = buildGnd(3, 2, palette, [0, 1, 2, 3, 4, 5].map(tile), [5, 4, 3, 2, 1, 0]);

  it('解析头部与排布表，按行主序拼图', () => {
    const g = parseGnd(bytes, 'g');
    expect([g.cols, g.rows, g.count, g.width, g.height, g.identityLayout]).toEqual([3, 2, 6, 96, 64, false]);
    expect(g.tilesOffset).toBe(0x210 + 12);
    const img = gndToIndexed(g);
    expect(img.pixels[0]).toBe(5); // 块 (0,0) 用图块 5
    expect(img.pixels[40]).toBe(4); // (1,0)
    expect(img.pixels[95]).toBe(3); // (2,0)
    expect(img.pixels[32 * 96]).toBe(2); // (0,1)
    expect(img.pixels[63 * 96 + 95]).toBe(0); // (2,1)
    const rgba = gndToRgba(g);
    expect([...rgba.rgba.subarray(0, 4)]).toEqual([...paletteToRgb(Uint16Array.of(palette[5]!)), 255]);
    expect(rgba.rgba.every((v, i) => i % 4 !== 3 || v === 255)).toBe(true);
  });

  it('splitIndexed：2×2 分块，每块向右/下多带 1px，贴边不带', () => {
    const img = { w: 4, h: 4, pixels: Uint8Array.from({ length: 16 }, (_, i) => i), palette: new Uint8Array(768) };
    const tiles = splitIndexed(img, 2, 2, 1);
    expect(tiles.map((t) => [t.col, t.row, t.x, t.y, t.w, t.h])).toEqual([
      [0, 0, 0, 0, 3, 3],
      [1, 0, 2, 0, 2, 3],
      [0, 1, 0, 2, 3, 2],
      [1, 1, 2, 2, 2, 2],
    ]);
    expect([...tiles[0]!.pixels]).toEqual([0, 1, 2, 4, 5, 6, 8, 9, 10]);
    expect([...tiles[3]!.pixels]).toEqual([10, 11, 14, 15]);
    expect(splitIndexed(img, 1, 1, 0)[0]!.pixels).toEqual(img.pixels);
    expect(code(() => splitIndexed(img, 3, 1))).toBe('E_GND_SPLIT');
  });

  it('原版 72×72 常量', () => {
    expect(GND_TILES_OFFSET_72).toBe(0x2a90);
    expect(gndByteLength(72, 72)).toBe(5_319_312);
  });

  it('校验：魔数、块数、+0x0C、长度、排布越界', () => {
    expect(code(() => parseGnd(new Uint8Array(10)))).toBe('E_GND_TRUNCATED');
    const m = bytes.slice();
    m[0] = 0x58;
    expect(code(() => parseGnd(m))).toBe('E_GND_MAGIC');
    const n = bytes.slice();
    n[8] = 7;
    expect(code(() => parseGnd(n))).toBe('E_GND_HEADER');
    const z = bytes.slice();
    z[12] = 1;
    expect(code(() => parseGnd(z))).toBe('E_GND_HEADER');
    expect(code(() => parseGnd(bytes.subarray(0, bytes.length - 1)))).toBe('E_GND_SIZE');
    const l = bytes.slice();
    l[0x210] = 6;
    expect(code(() => parseGnd(l))).toBe('E_GND_LAYOUT');
  });
});

describe('RAW16', () => {
  it('按字节数判尺寸', () => {
    expect([...RAW16_SIZES.entries()]).toEqual([
      [80000, { w: 200, h: 200 }],
      [194776, { w: 388, h: 251 }],
      [84480, { w: 165, h: 256 }],
      [614400, { w: 640, h: 480 }],
    ]);
    for (const [bytes, { w, h }] of RAW16_SIZES) expect(w * h * 2).toBe(bytes);
    expect(raw16Dims(84480)).toEqual({ w: 165, h: 256 });
    expect(raw16Dims(100)).toBeNull();
    const img = decodeRaw16(new Uint8Array(80000));
    expect([img.w, img.h]).toEqual([200, 200]);
    expect(img.rgba[3]).toBe(255);
  });

  it('corner-zero：只把与四角 4 连通的 0 值抠成透明，内部黑色保留', () => {
    // 5×4：四角与左上角相邻的 0 透明；中心的 0 不与角连通
    const W = rgb555(31, 31, 31);
    const px = [0, 0, W, W, 0, 0, W, W, W, W, W, W, 0, W, W, 0, W, W, W, 0];
    const data = new Uint8Array(px.length * 2);
    px.forEach((v, i) => {
      data[2 * i] = v & 0xff;
      data[2 * i + 1] = v >> 8;
    });
    const alpha = (t: 'opaque' | 'corner-zero' | 'zero') =>
      [...decodeRaw16(data, { size: { w: 5, h: 4 }, transparency: t }).rgba].filter((_, i) => i % 4 === 3);
    expect(alpha('opaque').every((a) => a === 255)).toBe(true);
    expect(alpha('corner-zero')).toEqual([
      0, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 0,
    ]);
    expect(alpha('zero')).toEqual(px.map((v) => (v === 0 ? 0 : 255)));
  });

  it('尺寸不符报错', () => {
    expect(code(() => decodeRaw16(new Uint8Array(10)))).toBe('E_RAW16_SIZE');
    expect(code(() => decodeRaw16(new Uint8Array(10), { size: { w: 2, h: 2 } }))).toBe('E_RAW16_SIZE');
  });
});
