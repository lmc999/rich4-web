/**
 * SPR / SMP 精灵表的公共头部解析与自洽校验。
 * 移植自 test/sprite-proto.ts 的 parseSheet（本项目调研原型）。规格：sprites.md §4/§5、containers.md §5。
 *
 * 布局：'SPR\0' 或 'SMP\0'、u32 n、u32 start；帧表从 12 起每项 12 字节 {i16 w, h, x, y; u32 gsize}；
 * SPR：start 处 512 字节 RGB555 调色板，像素从 start+512 起每像素 1 字节索引；
 * SMP：没有调色板，像素从 start 起每像素 u16 RGB555。两者都没有 RLE，各帧按 gsize 首尾相接。
 * 校验：start == 12+12n；gsize == w·h（SPR）或 2·w·h（SMP）；w,h ≥ 0；Σgsize 恰好闭合到资源末尾。
 */
import { GfxError } from './errors';

export type SheetKind = 'SPR' | 'SMP';

export interface SheetFrame {
  index: number;
  w: number;
  h: number;
  /** 锚点：落点 = 画点 − (ax, ay)；可为负 */
  ax: number;
  ay: number;
  gsize: number;
  /** 本帧像素在资源内的绝对偏移 */
  offset: number;
}

export interface SheetHeader {
  kind: SheetKind;
  count: number;
  /** = 12 + 12n；SPR 调色板所在位置 */
  start: number;
  /** 首帧像素偏移（SPR 为 start+512，SMP 为 start） */
  pixelBase: number;
  frames: SheetFrame[];
}

export const SHEET_HEADER_BYTES = 12;
export const SHEET_FRAME_BYTES = 12;
export const SPR_PALETTE_BYTES = 512;

function u32(d: Uint8Array, o: number): number {
  return (d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24)) >>> 0;
}

function i16(d: Uint8Array, o: number): number {
  return ((d[o]! | (d[o + 1]! << 8)) << 16) >> 16;
}

export function parseSheetHeader(data: Uint8Array, kind: SheetKind, label: string): SheetHeader {
  const p = `E_${kind}`;
  if (data.length < SHEET_HEADER_BYTES) throw new GfxError(`${p}_TRUNCATED`, `${label}: 只有 ${data.length} 字节`);
  const magic = String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!);
  if (magic !== `${kind}\0`) throw new GfxError(`${p}_MAGIC`, `${label}: 魔数 ${JSON.stringify(magic)} 不是 ${kind}`);
  const count = u32(data, 4);
  const start = u32(data, 8);
  if (start !== SHEET_HEADER_BYTES + SHEET_FRAME_BYTES * count) {
    throw new GfxError(`${p}_START`, `${label}: start=${start} ≠ 12+12·${count}`);
  }
  const pixelBase = kind === 'SPR' ? start + SPR_PALETTE_BYTES : start;
  if (pixelBase > data.length) {
    throw new GfxError(`${p}_TRUNCATED`, `${label}: 帧表/调色板结束于 ${pixelBase}，超过资源长度 ${data.length}`);
  }
  const bpp = kind === 'SPR' ? 1 : 2;
  const frames: SheetFrame[] = [];
  let off = pixelBase;
  for (let i = 0; i < count; i++) {
    const b = SHEET_HEADER_BYTES + i * SHEET_FRAME_BYTES;
    const w = i16(data, b);
    const h = i16(data, b + 2);
    const gsize = u32(data, b + 8);
    if (w < 0 || h < 0) throw new GfxError(`${p}_FRAME_SIZE`, `${label}: 帧 ${i} 尺寸为负 ${w}×${h}`);
    if (gsize !== w * h * bpp) {
      throw new GfxError(`${p}_GSIZE`, `${label}: 帧 ${i} gsize=${gsize} ≠ ${w}·${h}${bpp === 2 ? '·2' : ''}`);
    }
    frames.push({ index: i, w, h, ax: i16(data, b + 4), ay: i16(data, b + 6), gsize, offset: off });
    off += gsize;
  }
  if (off !== data.length) {
    throw new GfxError(`${p}_CLOSURE`, `${label}: Σgsize 结束于 ${off}，资源长度 ${data.length}`);
  }
  return { kind, count, start, pixelBase, frames };
}

export function sheetFrame(h: SheetHeader, i: number, label: string): SheetFrame {
  const f = h.frames[i];
  if (!Number.isInteger(i) || f === undefined) {
    throw new GfxError(`E_${h.kind}_FRAME_INDEX`, `${label}: 帧 ${i} 不存在（共 ${h.count} 帧）`);
  }
  return f;
}
