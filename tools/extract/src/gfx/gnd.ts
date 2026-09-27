/**
 * GND：地图地面（正射俯视底图）。移植自 test/sprite-proto.ts 的 parseGnd/decodeGnd（本项目调研原型）。
 * 规格：sprites.md §6、containers.md §5、design-draft.md §2.3。
 *
 * | 偏移   | 内容 |
 * | 0x00   | 'GND\0' |
 * | 0x04   | u16 cols（72） |
 * | 0x06   | u16 rows（72） |
 * | 0x08   | u32 块数 n = cols·rows（5184） |
 * | 0x0C   | u32 0 |
 * | 0x10   | 调色板 256×RGB555（512 字节） |
 * | 0x210  | 排布表 n 项 u16（原版 12 张图全是恒等排列） |
 * | 0x210+2n（0x2A90） | n 块 32×32 的 8 位图块，行主序；块 i 位于 (i mod cols, i div cols) |
 *
 * 总长恰为 0x210 + 2n + 1024n（原版 5,319,312），拼成 (32·cols)×(32·rows) = 2304² 的底图，不透明。
 * 世界坐标就是这张底图的像素坐标。
 */
import { GfxError, type IndexedImage, type RgbaImage } from './errors';
import { paletteToRgb, paletteToRgba, readU16Array } from './rgb555';

export const GND_TILE = 32;
export const GND_TILE_BYTES = GND_TILE * GND_TILE;
export const GND_PALETTE_OFFSET = 0x10;
export const GND_LAYOUT_OFFSET = 0x210;
/** 原版 72×72 块时图块数据起点 */
export const GND_TILES_OFFSET_72 = GND_LAYOUT_OFFSET + 2 * 72 * 72;

export interface GndImage {
  cols: number;
  rows: number;
  /** 块数 = cols·rows */
  count: number;
  /** 256 项 RGB555 */
  palette: Uint16Array;
  /** 排布表：屏幕块 i 使用图块 layout[i] */
  layout: Uint16Array;
  /** 排布表是否恒等 */
  identityLayout: boolean;
  tilesOffset: number;
  /** 底图宽高（像素） */
  width: number;
  height: number;
  data: Uint8Array;
  label: string;
}

function u16(d: Uint8Array, o: number): number {
  return d[o]! | (d[o + 1]! << 8);
}

function u32(d: Uint8Array, o: number): number {
  return (d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24)) >>> 0;
}

export function gndByteLength(cols: number, rows: number): number {
  const n = cols * rows;
  return GND_LAYOUT_OFFSET + 2 * n + GND_TILE_BYTES * n;
}

export function parseGnd(data: Uint8Array, label = 'GND'): GndImage {
  if (data.length < GND_LAYOUT_OFFSET) throw new GfxError('E_GND_TRUNCATED', `${label}: 只有 ${data.length} 字节`);
  const magic = String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!);
  if (magic !== 'GND\0') throw new GfxError('E_GND_MAGIC', `${label}: 魔数 ${JSON.stringify(magic)} 不是 GND`);
  const cols = u16(data, 4);
  const rows = u16(data, 6);
  const count = u32(data, 8);
  if (cols === 0 || rows === 0 || count !== cols * rows) {
    throw new GfxError('E_GND_HEADER', `${label}: cols=${cols} rows=${rows} 块数=${count} 不自洽`);
  }
  if (u32(data, 12) !== 0) throw new GfxError('E_GND_HEADER', `${label}: +0x0C 应为 0，实为 ${u32(data, 12)}`);
  const expected = gndByteLength(cols, rows);
  if (data.length !== expected) {
    throw new GfxError('E_GND_SIZE', `${label}: 长度 ${data.length} ≠ 0x210+2n+1024n = ${expected}`);
  }
  const layout = readU16Array(data, GND_LAYOUT_OFFSET, count);
  let identityLayout = true;
  for (let i = 0; i < count; i++) {
    const t = layout[i]!;
    if (t >= count) throw new GfxError('E_GND_LAYOUT', `${label}: 排布表第 ${i} 项 ${t} 越界（共 ${count} 块）`);
    if (t !== i) identityLayout = false;
  }
  return {
    cols,
    rows,
    count,
    palette: readU16Array(data, GND_PALETTE_OFFSET, 256),
    layout,
    identityLayout,
    tilesOffset: GND_LAYOUT_OFFSET + 2 * count,
    width: cols * GND_TILE,
    height: rows * GND_TILE,
    data,
    label,
  };
}

/** 按排布表把图块行主序拼成完整底图（8 位索引 + RGB 调色板） */
export function gndToIndexed(g: GndImage): IndexedImage {
  const W = g.width;
  const pixels = new Uint8Array(W * g.height);
  for (let i = 0; i < g.count; i++) {
    const tx = i % g.cols;
    const ty = (i / g.cols) | 0;
    const src = g.tilesOffset + g.layout[i]! * GND_TILE_BYTES;
    for (let y = 0; y < GND_TILE; y++) {
      const o = (ty * GND_TILE + y) * W + tx * GND_TILE;
      pixels.set(g.data.subarray(src + y * GND_TILE, src + (y + 1) * GND_TILE), o);
    }
  }
  return { w: W, h: g.height, pixels, palette: paletteToRgb(g.palette) };
}

/** 完整底图 → RGBA（全部不透明） */
export function gndToRgba(g: GndImage): RgbaImage {
  const img = gndToIndexed(g);
  const lut = paletteToRgba(g.palette);
  for (let k = 0; k < 256; k++) lut[k * 4 + 3] = 255;
  const rgba = new Uint8Array(img.w * img.h * 4);
  for (let p = 0; p < img.pixels.length; p++) {
    const q = img.pixels[p]! * 4;
    const o = p * 4;
    rgba[o] = lut[q]!;
    rgba[o + 1] = lut[q + 1]!;
    rgba[o + 2] = lut[q + 2]!;
    rgba[o + 3] = 255;
  }
  return { w: img.w, h: img.h, rgba };
}

export interface IndexedTile {
  /** 分块的列号与行号 */
  col: number;
  row: number;
  /** 分块在底图中的原点与尺寸 */
  x: number;
  y: number;
  w: number;
  h: number;
  pixels: Uint8Array;
}

/**
 * 把索引图切成 cols×rows 块；每块向右、向下多带 overlap 像素（贴边的块不带），拼接时避免缝隙
 * （design-draft §2.5：2304² 切成 2×2 张 1152²，每块多带 1px）。宽高必须能被 cols/rows 整除。
 */
export function splitIndexed(img: IndexedImage, cols: number, rows: number, overlap = 1): IndexedTile[] {
  if (cols < 1 || rows < 1 || img.w % cols !== 0 || img.h % rows !== 0 || overlap < 0) {
    throw new GfxError('E_GND_SPLIT', `${img.w}×${img.h} 不能按 ${cols}×${rows}（重叠 ${overlap}）切分`);
  }
  const bw = img.w / cols;
  const bh = img.h / rows;
  const out: IndexedTile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * bw;
      const y = row * bh;
      const w = Math.min(bw + overlap, img.w - x);
      const h = Math.min(bh + overlap, img.h - y);
      const pixels = new Uint8Array(w * h);
      for (let r = 0; r < h; r++) pixels.set(img.pixels.subarray((y + r) * img.w + x, (y + r) * img.w + x + w), r * w);
      out.push({ col, row, x, y, w, h, pixels });
    }
  }
  return out;
}
