/**
 * RGB555（X1R5G5B5，小端 u16：0RRRRRGGGGGBBBBB）→ 8 位分量。
 * 移植自 test/sprite-proto.ts 的 rgb555（本项目调研原型）。规格：containers.md §4.1、sprites.md §3。
 * 5 位扩展到 8 位用高位复制：x<<3 | x>>2（0→0，31→255）。
 */

/** 5 位 → 8 位查找表 */
export const EXPAND5: Uint8Array = Uint8Array.from({ length: 32 }, (_, x) => (x << 3) | (x >> 2));

export function expand5(x: number): number {
  return EXPAND5[x & 31]!;
}

export function rgb555ToRgb(v: number): [r: number, g: number, b: number] {
  return [EXPAND5[(v >> 10) & 31]!, EXPAND5[(v >> 5) & 31]!, EXPAND5[v & 31]!];
}

/** 写一个像素到 RGBA 缓冲（off 为字节偏移） */
export function putRgb555(out: Uint8Array, off: number, v: number, alpha = 255): void {
  out[off] = EXPAND5[(v >> 10) & 31]!;
  out[off + 1] = EXPAND5[(v >> 5) & 31]!;
  out[off + 2] = EXPAND5[v & 31]!;
  out[off + 3] = alpha;
}

/** 从 data[off..] 读 count 个小端 u16 */
export function readU16Array(data: Uint8Array, off: number, count: number): Uint16Array {
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) out[i] = data[off + 2 * i]! | (data[off + 2 * i + 1]! << 8);
  return out;
}

/** bit15 置位的字数（RGB555 数据应为 0；也是解压正确性的旁证） */
export function countBit15(data: Uint8Array, off: number, words: number): number {
  let n = 0;
  for (let i = 0; i < words; i++) if (data[off + 2 * i + 1]! & 0x80) n++;
  return n;
}

export interface PaletteOptions {
  /** 该索引输出为完全透明（0,0,0,0）；null 表示全部不透明 */
  transparentIndex?: number | null;
}

/** 256 项 RGB555 调色板 → 1024 字节 RGBA 查找表 */
export function paletteToRgba(palette: Uint16Array, opts: PaletteOptions = {}): Uint8Array {
  const t = opts.transparentIndex ?? null;
  const lut = new Uint8Array(palette.length * 4);
  for (let k = 0; k < palette.length; k++) {
    if (k === t) continue;
    putRgb555(lut, k * 4, palette[k]!);
  }
  return lut;
}

/** 256 项 RGB555 调色板 → 768 字节 RGB（供索引色 PNG 的 PLTE） */
export function paletteToRgb(palette: Uint16Array): Uint8Array {
  const out = new Uint8Array(palette.length * 3);
  for (let k = 0; k < palette.length; k++) {
    const v = palette[k]!;
    out[k * 3] = EXPAND5[(v >> 10) & 31]!;
    out[k * 3 + 1] = EXPAND5[(v >> 5) & 31]!;
    out[k * 3 + 2] = EXPAND5[v & 31]!;
  }
  return out;
}

export interface Rgb555RunOptions {
  /** 0x0000 视为透明（SMP 色键）；默认 false（不透明，0 → 黑） */
  zeroTransparent?: boolean;
}

/** data[off..] 起 count 个 RGB555 像素 → RGBA */
export function rgb555RunToRgba(data: Uint8Array, off: number, count: number, opts: Rgb555RunOptions = {}): Uint8Array {
  const out = new Uint8Array(count * 4);
  const key = opts.zeroTransparent ?? false;
  for (let p = 0; p < count; p++) {
    const v = data[off + 2 * p]! | (data[off + 2 * p + 1]! << 8);
    if (key && v === 0) continue;
    putRgb555(out, p * 4, v);
  }
  return out;
}
