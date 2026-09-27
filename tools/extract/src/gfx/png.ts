/**
 * 最小 PNG 编码器（只用 node:zlib）：RGBA8、索引色（PLTE + tRNS）、8 位灰度。
 * 移植自 test/sprite-proto.ts / test/mkf-lib.ts 的 encodePng（本项目调研原型），改为确定性输出：
 * 每种颜色类型用固定的扫描线 filter、zlib level 9、不写时间戳；tEXt 按关键字排序，
 * 默认写入派生标记 tEXt「rich4:derived」=「private」（design-draft §2.5，供仓库守卫识别）。
 * 同一 Node/zlib 版本下同输入同字节。
 */
import { crc32, deflateSync } from 'node:zlib';
import { GfxError } from './errors';

export const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const PNG_DERIVED_KEYWORD = 'rich4:derived';
export const PNG_DERIVED_VALUE = 'private';
export const PNG_ZLIB_LEVEL = 9;

/** PNG 扫描线 filter 类型 */
export const PNG_FILTER = { NONE: 0, SUB: 1, UP: 2, AVERAGE: 3, PAETH: 4 } as const;
export type PngFilter = (typeof PNG_FILTER)[keyof typeof PNG_FILTER];

/**
 * 各颜色类型的固定 filter：一律 NONE。索引色/灰度是 PNG 规范的建议；RGBA 实测（Data#88、map#27、Panel#0/#26、
 * Data#400/#530，zlib 9）NONE 合计 193 KB，SUB 237 KB、UP 246 KB、PAETH 239 KB、AVERAGE 323 KB——
 * 原版像素画颜色少、重复多，不做预测反而最小。
 */
export const PNG_FIXED_FILTER = { rgba: PNG_FILTER.NONE, indexed: PNG_FILTER.NONE, gray: PNG_FILTER.NONE } as const;

export interface PngOptions {
  /** 额外 tEXt（关键字 1–79 个 Latin-1 可打印字符；值为 Latin-1、无 NUL） */
  text?: Readonly<Record<string, string>>;
  /** 写入派生标记（默认 true） */
  derivedMarker?: boolean;
}

const COLOR_GRAY = 0;
const COLOR_INDEXED = 3;
const COLOR_RGBA = 6;

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function latin1(s: string, what: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff || c === 0) throw new GfxError('E_PNG_TEXT', `${what} 含非 Latin-1 或 NUL 字符`);
    out[i] = c;
  }
  return out;
}

function textChunks(opts: PngOptions): Uint8Array[] {
  const entries = new Map<string, string>();
  if (opts.derivedMarker ?? true) entries.set(PNG_DERIVED_KEYWORD, PNG_DERIVED_VALUE);
  for (const [k, v] of Object.entries(opts.text ?? {})) entries.set(k, v);
  const keys = [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return keys.map((k) => {
    if (k.length < 1 || k.length > 79 || /^ | $| {2}/.test(k) || /[^\x20-\x7e\xa1-\xff]/.test(k)) {
      throw new GfxError('E_PNG_TEXT', `tEXt 关键字非法：${JSON.stringify(k)}`);
    }
    const key = latin1(k, 'tEXt 关键字');
    const val = latin1(entries.get(k)!, `tEXt「${k}」的值`);
    const data = new Uint8Array(key.length + 1 + val.length);
    data.set(key, 0);
    data.set(val, key.length + 1);
    return chunk('tEXt', data);
  });
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 按固定 filter 生成带 filter 字节的扫描线数据 */
export function filterScanlines(px: Uint8Array, w: number, h: number, bpp: number, filter: PngFilter): Uint8Array {
  const stride = w * bpp;
  const out = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    const cur = y * stride;
    const prev = cur - stride;
    out[o] = filter;
    for (let i = 0; i < stride; i++) {
      const x = px[cur + i]!;
      const a = i >= bpp ? px[cur + i - bpp]! : 0;
      const b = y > 0 ? px[prev + i]! : 0;
      let v: number;
      switch (filter) {
        case PNG_FILTER.NONE:
          v = x;
          break;
        case PNG_FILTER.SUB:
          v = x - a;
          break;
        case PNG_FILTER.UP:
          v = x - b;
          break;
        case PNG_FILTER.AVERAGE:
          v = x - ((a + b) >> 1);
          break;
        default: {
          const c = i >= bpp && y > 0 ? px[prev + i - bpp]! : 0;
          v = x - paeth(a, b, c);
        }
      }
      out[o + 1 + i] = v & 0xff;
    }
  }
  return out;
}

function assertDims(w: number, h: number, got: number, bpp: number, what: string): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 0x7fffffff || h > 0x7fffffff) {
    throw new GfxError('E_PNG_SIZE', `${what}: 非法尺寸 ${w}×${h}`);
  }
  if (got !== w * h * bpp) throw new GfxError('E_PNG_SIZE', `${what}: 像素 ${got} 字节 ≠ ${w}×${h}×${bpp}`);
}

function assemble(
  w: number,
  h: number,
  colorType: number,
  pre: Uint8Array[],
  filtered: Uint8Array,
  opts: PngOptions,
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  // 压缩 0、filter 方法 0、不隔行
  const idat = new Uint8Array(deflateSync(filtered, { level: PNG_ZLIB_LEVEL }));
  const parts = [
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    ...pre,
    ...textChunks(opts),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** RGBA8（非预乘） */
export function encodePngRgba(w: number, h: number, rgba: Uint8Array, opts: PngOptions = {}): Uint8Array {
  assertDims(w, h, rgba.length, 4, 'RGBA PNG');
  return assemble(w, h, COLOR_RGBA, [], filterScanlines(rgba, w, h, 4, PNG_FIXED_FILTER.rgba), opts);
}

/**
 * 8 位索引色：palette 为 RGB（每项 3 字节，1..256 项）；alpha 可选（每项 1 字节），
 * 只写到最后一个非 255 项为止的 tRNS。像素值必须小于调色板项数。
 */
export function encodePngIndexed(
  w: number,
  h: number,
  pixels: Uint8Array,
  palette: Uint8Array,
  alpha: Uint8Array | null = null,
  opts: PngOptions = {},
): Uint8Array {
  assertDims(w, h, pixels.length, 1, '索引色 PNG');
  const n = palette.length / 3;
  if (!Number.isInteger(n) || n < 1 || n > 256)
    throw new GfxError('E_PNG_PALETTE', `调色板 ${palette.length} 字节非法`);
  if (alpha && alpha.length > n) throw new GfxError('E_PNG_PALETTE', `alpha ${alpha.length} 项多于调色板 ${n} 项`);
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i]! >= n) throw new GfxError('E_PNG_PALETTE', `像素 ${i} 的索引 ${pixels[i]} 超出调色板 ${n} 项`);
  }
  const pre = [chunk('PLTE', palette)];
  if (alpha) {
    let last = -1;
    for (let i = 0; i < alpha.length; i++) if (alpha[i] !== 255) last = i;
    if (last >= 0) pre.push(chunk('tRNS', alpha.subarray(0, last + 1)));
  }
  return assemble(w, h, COLOR_INDEXED, pre, filterScanlines(pixels, w, h, 1, PNG_FIXED_FILTER.indexed), opts);
}

/** 8 位灰度（例如区域掩膜：值即区号；主人色掩膜：0/255） */
export function encodePngGray8(w: number, h: number, values: Uint8Array, opts: PngOptions = {}): Uint8Array {
  assertDims(w, h, values.length, 1, '灰度 PNG');
  return assemble(w, h, COLOR_GRAY, [], filterScanlines(values, w, h, 1, PNG_FIXED_FILTER.gray), opts);
}

/** 读出 PNG 的 tEXt（只解析块结构，不解码像素）；非 PNG 返回 null */
export function readPngText(bytes: Uint8Array): Record<string, string> | null {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  const out: Record<string, string> = {};
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  while (p + 12 <= bytes.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    if (p + 12 + len > bytes.length) break;
    if (type === 'tEXt') {
      const data = bytes.subarray(p + 8, p + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0)
        out[Buffer.from(data.subarray(0, nul)).toString('latin1')] = Buffer.from(data.subarray(nul + 1)).toString(
          'latin1',
        );
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

/** 是否带派生标记 */
export function isDerivedPng(bytes: Uint8Array): boolean {
  return readPngText(bytes)?.[PNG_DERIVED_KEYWORD] === PNG_DERIVED_VALUE;
}
