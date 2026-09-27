/**
 * 最小 PNG 读取器（node:zlib inflate）：素材包 verify --full 与 preview 用来回读 gfx/png.ts 写出的 PNG。
 * 校验 CRC；支持 8 位灰度（0）、RGB（2）、索引色（3，PLTE + tRNS）、RGBA（6），5 种 filter；不支持隔行与 16 位。
 * 自写（按 PNG 规范），不来自任何外部项目。
 */
import { crc32, inflateSync } from 'node:zlib';
import { GfxError, type RgbaImage } from '../gfx/errors';

export interface PngInfo extends RgbaImage {
  colorType: number;
  text: Record<string, string>;
  /** 索引色的原始索引（其他颜色类型为 null） */
  indices: Uint8Array | null;
  /** 灰度值（颜色类型 0；其他为 null） */
  gray: Uint8Array | null;
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function readPng(bytes: Uint8Array, label = 'PNG'): PngInfo {
  if (bytes.length < 8 || !SIG.every((b, i) => bytes[i] === b)) throw new GfxError('E_PNG_READ', `${label}: 不是 PNG`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let w = 0;
  let h = 0;
  let colorType = -1;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  const text: Record<string, string> = {};
  let ended = false;
  while (p + 12 <= bytes.length) {
    const len = dv.getUint32(p);
    if (p + 12 + len > bytes.length) throw new GfxError('E_PNG_READ', `${label}: 块越界`);
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (crc32(bytes.subarray(p + 4, p + 8 + len)) !== dv.getUint32(p + 8 + len)) {
      throw new GfxError('E_PNG_READ', `${label}: ${type} CRC 错误`);
    }
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      w = d.getUint32(0);
      h = d.getUint32(4);
      if (data[8] !== 8) throw new GfxError('E_PNG_READ', `${label}: 只支持 8 位深度`);
      colorType = data[9]!;
      if (data[12] !== 0) throw new GfxError('E_PNG_READ', `${label}: 不支持隔行`);
    } else if (type === 'PLTE') palette = data.slice();
    else if (type === 'tRNS') trns = data.slice();
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0) {
        text[Buffer.from(data.subarray(0, nul)).toString('latin1')] = Buffer.from(data.subarray(nul + 1)).toString(
          'latin1',
        );
      }
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    p += 12 + len;
  }
  if (!ended || w === 0 || h === 0) throw new GfxError('E_PNG_READ', `${label}: 缺少 IHDR 或 IEND`);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 || colorType === 3 ? 1 : 0;
  if (bpp === 0) throw new GfxError('E_PNG_READ', `${label}: 不支持颜色类型 ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d.buffer, d.byteOffset, d.byteLength))));
  const stride = w * bpp;
  if (raw.length !== (stride + 1) * h) throw new GfxError('E_PNG_READ', `${label}: IDAT 长度不符`);
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const cur = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]!;
      const a = i >= bpp ? px[cur + i - bpp]! : 0;
      const b = y > 0 ? px[cur - stride + i]! : 0;
      const c = i >= bpp && y > 0 ? px[cur - stride + i - bpp]! : 0;
      let v: number;
      switch (f) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4:
          v = x + paeth(a, b, c);
          break;
        default:
          throw new GfxError('E_PNG_READ', `${label}: 未知 filter ${f}`);
      }
      px[cur + i] = v & 0xff;
    }
  }
  const n = w * h;
  const rgba = new Uint8Array(n * 4);
  let indices: Uint8Array | null = null;
  let gray: Uint8Array | null = null;
  if (colorType === 6) rgba.set(px);
  else if (colorType === 2) {
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = px[i * 3]!;
      rgba[i * 4 + 1] = px[i * 3 + 1]!;
      rgba[i * 4 + 2] = px[i * 3 + 2]!;
      rgba[i * 4 + 3] = 255;
    }
  } else if (colorType === 0) {
    gray = px;
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[i]!;
      rgba[i * 4 + 3] = 255;
    }
  } else {
    if (!palette) throw new GfxError('E_PNG_READ', `${label}: 索引色缺少 PLTE`);
    indices = px;
    for (let i = 0; i < n; i++) {
      const k = px[i]!;
      if (k * 3 + 2 >= palette.length) throw new GfxError('E_PNG_READ', `${label}: 索引 ${k} 超出调色板`);
      rgba[i * 4] = palette[k * 3]!;
      rgba[i * 4 + 1] = palette[k * 3 + 1]!;
      rgba[i * 4 + 2] = palette[k * 3 + 2]!;
      rgba[i * 4 + 3] = trns && k < trns.length ? trns[k]! : 255;
    }
  }
  return { w, h, rgba, colorType, text, indices, gray };
}

/** 完全透明的像素一律归零（与 gfx 解码器的输出约定一致），便于按 RGBA 哈希比较 */
export function normalizeTransparent(rgba: Uint8Array): Uint8Array {
  const out = rgba.slice();
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out[i] = out[i + 1] = out[i + 2] = 0;
  return out;
}
