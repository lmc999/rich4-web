// 调试用：MKF 读取 + 解压 + 最小 PNG 编码器（node:zlib），供 test/ 下其他脚本复用
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { lzhufDecompress } from './lzhuf-proto.ts';

export const ORIG = './original';
export interface Res { i: number; raw: number; stored: number; imgOff: number; imgSize: number; compressed: boolean; payload: Uint8Array }
export class Mkf {
  file: Uint8Array; dv: DataView; X: number; n: number; starts: number[];
  constructor(rel: string) {
    this.file = new Uint8Array(readFileSync(`${ORIG}/${rel}`));
    this.dv = new DataView(this.file.buffer, this.file.byteOffset, this.file.byteLength);
    this.X = this.dv.getUint32(0, true);
    const N = (this.file.length - this.X) / 4;
    this.starts = [];
    for (let i = 0; i < N; i++) this.starts.push(this.dv.getUint32(this.X + 4 * i, true));
    this.n = this.starts[N - 1] === this.X ? N - 1 : N;
  }
  get(i: number): Res {
    const off = this.starts[i]!;
    const raw = this.dv.getUint32(off, true), stored = this.dv.getUint32(off + 4, true);
    const imgOff = this.dv.getUint32(off + 8, true), imgSize = this.dv.getUint32(off + 12, true);
    const body = this.file.subarray(off + 16, off + 16 + stored);
    const compressed = raw !== stored;
    return { i, raw, stored, imgOff, imgSize, compressed, payload: compressed ? lzhufDecompress(body, raw) : body };
  }
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(Buffer.from(type, 'latin1'), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
}
/** RGBA8888 → PNG */
export function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const tot = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(tot); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
/** RGB555（0RRRRRGGGGGBBBBB）→ [r,g,b]，5→8 位用 (v<<3)|(v>>2) 扩展 */
export function rgb555(v: number): [number, number, number] {
  const r = (v >> 10) & 31, g = (v >> 5) & 31, b = v & 31;
  return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2)];
}
export function u16(p: Uint8Array, o: number): number { return p[o]! | (p[o + 1]! << 8); }
