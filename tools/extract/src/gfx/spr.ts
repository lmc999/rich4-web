/**
 * SPR：8 位调色板精灵。移植自 test/sprite-proto.ts 的 parseSheet/decodeFrame（本项目调研原型）。
 * 规格：sprites.md §4、design-draft.md §2.3/§2.5。
 *
 * - 透明按**索引 0** 判定，与 palette[0] 的颜色无关（exe fcn.00454C9E `and eax,0xFF; je skip`）。
 * - 调色板第 255 项只在 map.mkf 的建筑类 SPR（住宅、连锁店、设施、企业、景观）里是「主人色描边」占位；
 *   这类资源用 ownerMask 模式解码：索引 255 的像素在 RGBA 中置为透明，另输出一张 0/255 掩膜。
 *   其他资源里第 255 项是普通颜色（例如 Panel#31 的白色高光），**不能一律替换**，由调用方（资源目录）决定。
 */
import type { AnchoredImage, IndexedImage } from './errors';
import { paletteToRgb, paletteToRgba, readU16Array } from './rgb555';
import { parseSheetHeader, type SheetHeader, sheetFrame } from './sheet';

export const SPR_TRANSPARENT_INDEX = 0;
export const SPR_OWNER_INDEX = 255;

export interface SprSheet extends SheetHeader {
  kind: 'SPR';
  /** 256 项 RGB555 */
  palette: Uint16Array;
  data: Uint8Array;
  label: string;
}

export function parseSpr(data: Uint8Array, label = 'SPR'): SprSheet {
  const h = parseSheetHeader(data, 'SPR', label);
  return { ...h, kind: 'SPR', palette: readU16Array(data, h.start, 256), data, label };
}

/** 帧的 8 位索引像素（零拷贝） */
export function sprFrameIndices(sheet: SprSheet, i: number): Uint8Array {
  const f = sheetFrame(sheet, i, sheet.label);
  return sheet.data.subarray(f.offset, f.offset + f.gsize);
}

export interface SprDecodeOptions {
  /** 建筑类 SPR：索引 255 → 透明，并输出主人色掩膜 */
  ownerMask?: boolean;
}

export interface SprFrameImage extends AnchoredImage {
  /** ownerMask 模式下：每像素 1 字节，索引 255 处为 255，其余为 0；否则为 null */
  mask: Uint8Array | null;
  /** 索引 255 的像素数（与模式无关） */
  ownerPixels: number;
}

export function decodeSprFrame(sheet: SprSheet, i: number, opts: SprDecodeOptions = {}): SprFrameImage {
  const f = sheetFrame(sheet, i, sheet.label);
  const src = sprFrameIndices(sheet, i);
  const lut = paletteToRgba(sheet.palette, { transparentIndex: SPR_TRANSPARENT_INDEX });
  const owner = opts.ownerMask ?? false;
  if (owner) lut.fill(0, SPR_OWNER_INDEX * 4, SPR_OWNER_INDEX * 4 + 4);
  const n = f.w * f.h;
  const rgba = new Uint8Array(n * 4);
  const mask = owner ? new Uint8Array(n) : null;
  let ownerPixels = 0;
  for (let p = 0; p < n; p++) {
    const idx = src[p]!;
    const q = idx * 4;
    const o = p * 4;
    rgba[o] = lut[q]!;
    rgba[o + 1] = lut[q + 1]!;
    rgba[o + 2] = lut[q + 2]!;
    rgba[o + 3] = lut[q + 3]!;
    if (idx === SPR_OWNER_INDEX) {
      ownerPixels++;
      if (mask) mask[p] = 255;
    }
  }
  return { w: f.w, h: f.h, ax: f.ax, ay: f.ay, rgba, mask, ownerPixels };
}

/** 帧 → 索引图（调色板为 RGB888；透明规则仍是索引 0，交给 PNG 的 tRNS 表达） */
export function sprFrameIndexed(sheet: SprSheet, i: number): IndexedImage & { ax: number; ay: number } {
  const f = sheetFrame(sheet, i, sheet.label);
  return {
    w: f.w,
    h: f.h,
    ax: f.ax,
    ay: f.ay,
    pixels: sprFrameIndices(sheet, i),
    palette: paletteToRgb(sheet.palette),
  };
}

/** 统计全部帧里索引 255 的像素数（资源目录用来核对「建筑类」判定） */
export function countOwnerPixels(sheet: SprSheet): number {
  let n = 0;
  for (let p = sheet.pixelBase; p < sheet.data.length; p++) if (sheet.data[p] === SPR_OWNER_INDEX) n++;
  return n;
}
