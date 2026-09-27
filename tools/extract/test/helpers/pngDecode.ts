/**
 * 测试专用：最小 PNG 解码器（node:zlib inflate），校验 CRC、支持 5 种 filter，
 * 颜色类型 0（灰度 8 位）、2（RGB8）、3（索引 8 位 + PLTE/tRNS）、6（RGBA8）；不支持隔行。
 * 用于 png.ts 的往返自检与本机测试读取调研样图。
 */
import { crc32, inflateSync } from 'node:zlib';

export interface DecodedPng {
  w: number;
  h: number;
  colorType: number;
  bitDepth: number;
  /** 解出的原始像素（按颜色类型每像素 1/3/1/4 字节） */
  raw: Uint8Array;
  palette: Uint8Array | null;
  trns: Uint8Array | null;
  text: Record<string, string>;
  /** 各扫描线使用的 filter 类型 */
  filters: number[];
  /** 块类型顺序 */
  chunks: string[];
  /** 转成 RGBA8 */
  rgba: Uint8Array;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => bytes[i] === b)) throw new Error('不是 PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = -1;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  const text: Record<string, string> = {};
  const chunks: string[] = [];
  for (;;) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const data = bytes.subarray(p + 8, p + 8 + len);
    const crc = dv.getUint32(p + 8 + len);
    if (crc32(bytes.subarray(p + 4, p + 8 + len)) !== crc) throw new Error(`${type} CRC 错误`);
    chunks.push(type);
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      w = d.getUint32(0);
      h = d.getUint32(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (data[12] !== 0) throw new Error('不支持隔行');
    } else if (type === 'PLTE') palette = data.slice();
    else if (type === 'tRNS') trns = data.slice();
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'tEXt') {
      const nul = data.indexOf(0);
      text[Buffer.from(data.subarray(0, nul)).toString('latin1')] = Buffer.from(data.subarray(nul + 1)).toString(
        'latin1',
      );
    } else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`不支持位深 ${bitDepth}`);
  const bpp = { 0: 1, 2: 3, 3: 1, 6: 4 }[colorType as 0 | 2 | 3 | 6];
  if (bpp === undefined) throw new Error(`不支持颜色类型 ${colorType}`);
  const z = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  if (z.length !== (stride + 1) * h) throw new Error(`IDAT 解压长度 ${z.length} ≠ ${(stride + 1) * h}`);
  const raw = new Uint8Array(stride * h);
  const filters: number[] = [];
  for (let y = 0; y < h; y++) {
    const f = z[y * (stride + 1)]!;
    filters.push(f);
    for (let i = 0; i < stride; i++) {
      const x = z[y * (stride + 1) + 1 + i]!;
      const a = i >= bpp ? raw[y * stride + i - bpp]! : 0;
      const b = y > 0 ? raw[(y - 1) * stride + i]! : 0;
      const c = i >= bpp && y > 0 ? raw[(y - 1) * stride + i - bpp]! : 0;
      let v: number;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`未知 filter ${f}`);
      raw[y * stride + i] = v & 0xff;
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (colorType === 6) rgba.set(raw.subarray(i * 4, i * 4 + 4), i * 4);
    else if (colorType === 2) rgba.set([raw[i * 3]!, raw[i * 3 + 1]!, raw[i * 3 + 2]!, 255], i * 4);
    else if (colorType === 0) rgba.set([raw[i]!, raw[i]!, raw[i]!, 255], i * 4);
    else {
      const k = raw[i]!;
      if (!palette || k * 3 + 2 >= palette.length) throw new Error(`索引 ${k} 越出调色板`);
      rgba.set(
        [palette[k * 3]!, palette[k * 3 + 1]!, palette[k * 3 + 2]!, trns && k < trns.length ? trns[k]! : 255],
        i * 4,
      );
    }
  }
  return { w, h, colorType, bitDepth, raw, palette, trns, text, filters, chunks, rgba };
}

/** 完全透明像素的 RGB 归零（比较不同来源的 RGBA 时用：透明处的颜色无意义） */
export function normalizeRgba(rgba: Uint8Array): Uint8Array {
  const out = rgba.slice();
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out.fill(0, i, i + 4);
  return out;
}
