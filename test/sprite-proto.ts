// 临时调试脚本（调研原型）：《大富翁4》原版 MKF 图像资源解码 → PNG。
//
// 全部为自写实现：MKF 容器、私有 LZHUF 解压（按 docs/research/g_map.md §6.3 伪代码）、
// SPR / SMP / GND / FLIC(16bit) / 无头 RGB555 解码、最小 PNG 编码器（node:zlib）。
// 只读 original/**；输出只写 .cache/assets-research/**。
//
// 用法（node 24 原生去类型）：
//   node test/sprite-proto.ts survey                  全档案逐资源分类 + 自洽校验 → .cache/assets-research/sprite/survey-*.json
//   node test/sprite-proto.ts export <mkf> <res> [frames|all] [--opaque]
//   node test/sprite-proto.ts samples                 预设样本 + 联系表
//   node test/sprite-proto.ts bits                    RGB555/565 判别统计
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const GAME = join(ROOT, 'original/Game');
const OUT = join(ROOT, '.cache/assets-research');

// ───────────────────────── MKF 容器 ─────────────────────────
export interface MkfEntry {
  index: number;
  offset: number;
  rawSize: number;
  storedSize: number;
  imgOff: number;
  imgSize: number;
  compressed: boolean;
}

export class Mkf {
  readonly bytes: Uint8Array;
  readonly dv: DataView;
  readonly entries: MkfEntry[] = [];
  readonly name: string;
  private cache = new Map<number, Uint8Array>();
  constructor(bytes: Uint8Array, name: string) {
    this.bytes = bytes;
    this.name = name;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const x = this.dv.getUint32(0, true);
    if (x < 4 || x >= bytes.length || (bytes.length - x) % 4) throw new Error(`${name}: bad index offset ${x}`);
    const n = (bytes.length - x) / 4;
    const starts: number[] = [];
    for (let i = 0; i < n; i++) starts.push(this.dv.getUint32(x + 4 * i, true));
    const count = starts[n - 1] === x ? n - 1 : n;
    for (let i = 0; i < count; i++) {
      const o = starts[i]!;
      const next = i + 1 < n ? starts[i + 1]! : x;
      const rawSize = this.dv.getUint32(o, true);
      const storedSize = this.dv.getUint32(o + 4, true);
      if (o + 16 + storedSize > next) throw new Error(`${name}#${i}: overflow`);
      this.entries.push({
        index: i,
        offset: o,
        rawSize,
        storedSize,
        imgOff: this.dv.getUint32(o + 8, true),
        imgSize: this.dv.getUint32(o + 12, true),
        compressed: rawSize !== storedSize,
      });
    }
  }
  static open(file: string): Mkf {
    return new Mkf(new Uint8Array(readFileSync(file)), file.split('/').pop()!);
  }
  read(i: number): Uint8Array {
    const hit = this.cache.get(i);
    if (hit) return hit;
    const e = this.entries[i];
    if (!e) throw new Error(`${this.name}#${i}: no such resource`);
    const body = this.bytes.subarray(e.offset + 16, e.offset + 16 + e.storedSize);
    const data = e.compressed ? lzhufDecompress(body, e.rawSize) : body;
    if (this.cache.size > 64) this.cache.clear();
    this.cache.set(i, data);
    return data;
  }
}

// ───────────────────────── 私有 LZHUF（自适应哈夫曼 + LZ77，LSB-first） ─────────────────────────
// 实现依据：docs/research/g_map.md §6.3 的文字伪代码；表按规则自行生成。
const N_CHAR = 321;
const T = 641;
const R = 640;
const D_LEN = new Uint8Array(256);
const D_HI = new Uint8Array(256);
(() => {
  const m4: Record<number, number> = { 3: 0, 11: 1, 13: 2 };
  const m5: Record<number, number> = { 1: 0, 5: 1, 9: 2, 14: 3 };
  const m6: Record<number, number> = { 2: 0, 6: 1, 10: 2 };
  const m7: Record<number, number> = { 4: 0, 8: 1, 12: 2 };
  for (let v = 0; v < 256; v++) {
    const blk = v >> 4;
    const lo = v & 15;
    let len: number;
    let hi: number;
    if (lo === 0) [len, hi] = [8, 63 - blk];
    else if (lo === 7 || lo === 15) [len, hi] = [3, 0];
    else if (lo in m4) [len, hi] = [4, 3 - m4[lo]!];
    else if (lo in m5) [len, hi] = [5, 11 - 4 * (blk % 2) - m5[lo]!];
    else if (lo in m6) [len, hi] = [6, 23 - 3 * (blk % 4) - m6[lo]!];
    else if (lo in m7) [len, hi] = [7, 47 - 3 * (blk % 8) - m7[lo]!];
    else throw new Error(`dtable ${v}`);
    D_LEN[v] = len;
    D_HI[v] = hi;
  }
})();

/** 调试：最近一次解压实际消耗的比特数 */
export const lzStat = { bits: 0, endMarker: 0, bitsWithEnd: 0 };

export function lzhufDecompress(src: Uint8Array, size: number): Uint8Array {
  const freq = new Uint32Array(T + 1);
  const son = new Int32Array(T);
  const prnt = new Int32Array(T + N_CHAR + 1);
  for (let i = 0; i < N_CHAR; i++) {
    freq[i] = 1;
    son[i] = i + T;
    prnt[i + T] = i;
  }
  for (let j = N_CHAR, k = 0; j < T; j++, k += 2) {
    freq[j] = freq[k]! + freq[k + 1]!;
    son[j] = k;
    prnt[k] = j;
    prnt[k + 1] = j;
  }
  freq[T] = 0xffff;
  prnt[R] = 0;

  const nbits = src.length * 8;
  let pos = 0;
  const bit = (): number => {
    if (pos >= nbits) throw new Error('lzhuf: bitstream overrun');
    const b = (src[pos >> 3]! >> (pos & 7)) & 1;
    pos++;
    return b;
  };
  const peek = (p: number, n: number): number => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const q = p + k;
      const byte = q >> 3 < src.length ? src[q >> 3]! : 0;
      v |= ((byte >> (q & 7)) & 1) << k;
    }
    return v;
  };
  const bump = (s: number): void => {
    let e = prnt[s + T]!;
    do {
      const a = ++freq[e]!;
      if (a > freq[e + 1]!) {
        let l = e + 1;
        while (freq[l] === a - 1) l++;
        l--;
        freq[e] = freq[l]!;
        freq[l] = a;
        const i = son[e]!;
        const j = son[l]!;
        prnt[j] = e;
        if (j < T) prnt[j + 1] = e;
        prnt[i] = l;
        if (i < T) prnt[i + 1] = l;
        son[e] = j;
        son[l] = i;
        e = l;
      }
      e = prnt[e]!;
    } while (e !== 0);
  };
  const rescale = (): void => {
    for (let s = 0; s < N_CHAR; s++) if (freq[prnt[s + T]!]! & 1) bump(s);
    for (let k = 0; k < T; k++) freq[k] = freq[k]! >>> 1;
  };

  const out = new Uint8Array(size);
  let o = 0;
  while (o < size) {
    let c = son[R]!;
    while (c < T) c = son[c + bit()]!;
    const s = c - T;
    if (freq[R] === 0x8000) rescale();
    bump(s);
    if (s < 256) {
      out[o++] = s;
      continue;
    }
    const b = peek(pos, 8);
    const L = D_LEN[b]!;
    const lo6 = peek(pos + L, 6);
    pos += L + 6;
    const dist = (D_HI[b]! << 6) | lo6;
    if (dist === 0xfff) break;
    let p = o - 1 - dist;
    if (p < 0) throw new Error(`lzhuf: bad distance ${dist} at out=${o}`);
    const n = Math.min(s - 253, size - o);
    for (let k = 0; k < n; k++) out[o++] = out[p++]!;
  }
  if (o !== size) throw new Error(`lzhuf: short output ${o}/${size}`);
  lzStat.bits = pos;
  // 调试：输出满后再读一个符号，检查是否为结束标记（匹配码 + dist==0xFFF）
  lzStat.endMarker = -1;
  try {
    let c = son[R]!;
    while (c < T) c = son[c + bit()]!;
    const s = c - T;
    if (s >= 256) {
      const b = peek(pos, 8);
      const dist = (D_HI[b]! << 6) | peek(pos + D_LEN[b]!, 6);
      pos += D_LEN[b]! + 6;
      lzStat.endMarker = dist;
      lzStat.bitsWithEnd = pos;
    } else lzStat.endMarker = -2;
  } catch {
    lzStat.endMarker = -3;
  }
  return out;
}

// ───────────────────────── 像素格式 ─────────────────────────
/** RGB555（0RRRRRGGGGGBBBBB）→ 8 位，高位复制到低位（x<<3 | x>>2） */
export function rgb555(c: number): [number, number, number] {
  const r = (c >> 10) & 31;
  const g = (c >> 5) & 31;
  const b = c & 31;
  return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2)];
}
export function rgb565(c: number): [number, number, number] {
  const r = (c >> 11) & 31;
  const g = (c >> 5) & 63;
  const b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

export interface Rgba {
  w: number;
  h: number;
  px: Uint8Array; // RGBA8
  ax?: number; // 锚点
  ay?: number;
}

// ───────────────────────── SPR / SMP ─────────────────────────
export interface SheetFrame {
  w: number;
  h: number;
  x: number;
  y: number;
  gsize: number;
  off: number;
}
export interface Sheet {
  kind: 'SPR' | 'SMP';
  count: number;
  start: number;
  palette: Uint16Array | null;
  frames: SheetFrame[];
  /** Σgsize 后的末尾是否恰好等于资源长度 */
  closed: boolean;
  /** 每帧 gsize == w*h(*2) */
  sizeOk: boolean;
  end: number;
}

export function sniff(d: Uint8Array): string {
  if (d.length >= 4) {
    const m = String.fromCharCode(d[0]!, d[1]!, d[2]!, d[3]!);
    if (m === 'SPR\0' || m === 'SMP\0' || m === 'GND\0') return m.slice(0, 3);
    if (m === 'RIFF') return 'RIFF';
  }
  if (d.length >= 16) {
    const magic = d[4]! | (d[5]! << 8);
    const size = d[0]! | (d[1]! << 8) | (d[2]! << 16) | (d[3]! << 24);
    if ((magic === 0xaf12 || magic === 0xaf11) && size === d.length) return 'FLIC';
  }
  return 'raw';
}

export function parseSheet(d: Uint8Array): Sheet {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const kind = String.fromCharCode(d[0]!, d[1]!, d[2]!) as 'SPR' | 'SMP';
  const count = dv.getUint32(4, true);
  const start = dv.getUint32(8, true);
  let palette: Uint16Array | null = null;
  let off = start;
  if (kind === 'SPR') {
    palette = new Uint16Array(256);
    for (let i = 0; i < 256; i++) palette[i] = dv.getUint16(start + i * 2, true);
    off = start + 512;
  }
  const frames: SheetFrame[] = [];
  let sizeOk = true;
  for (let i = 0; i < count; i++) {
    const b = 12 + i * 12;
    const f: SheetFrame = {
      w: dv.getInt16(b, true),
      h: dv.getInt16(b + 2, true),
      x: dv.getInt16(b + 4, true),
      y: dv.getInt16(b + 6, true),
      gsize: dv.getUint32(b + 8, true),
      off,
    };
    if (f.gsize !== f.w * f.h * (kind === 'SMP' ? 2 : 1)) sizeOk = false;
    frames.push(f);
    off += f.gsize;
  }
  return { kind, count, start, palette, frames, closed: off === d.length, sizeOk, end: off };
}

export interface DecodeOpts {
  /** SPR 索引 0 / SMP 值 0 视为透明（原版 draw_non_zero 语义）；false 时全部不透明 */
  keyZero?: boolean;
  fmt?: '555' | '565';
}

export function decodeFrame(d: Uint8Array, sh: Sheet, i: number, opts: DecodeOpts = {}): Rgba {
  const keyZero = opts.keyZero ?? true;
  const conv = opts.fmt === '565' ? rgb565 : rgb555;
  const f = sh.frames[i]!;
  const px = new Uint8Array(f.w * f.h * 4);
  if (sh.kind === 'SPR') {
    const pal = sh.palette!;
    const lut = new Uint8Array(256 * 4);
    for (let k = 0; k < 256; k++) {
      const [r, g, b] = conv(pal[k]!);
      lut.set([r, g, b, keyZero && k === 0 ? 0 : 255], k * 4);
    }
    for (let p = 0; p < f.w * f.h; p++) {
      const idx = d[f.off + p]!;
      px.set(lut.subarray(idx * 4, idx * 4 + 4), p * 4);
    }
  } else {
    for (let p = 0; p < f.w * f.h; p++) {
      const c = d[f.off + p * 2]! | (d[f.off + p * 2 + 1]! << 8);
      const [r, g, b] = conv(c);
      px[p * 4] = r;
      px[p * 4 + 1] = g;
      px[p * 4 + 2] = b;
      px[p * 4 + 3] = keyZero && c === 0 ? 0 : 255;
    }
  }
  return { w: f.w, h: f.h, px, ax: f.x, ay: f.y };
}

// ───────────────────────── GND（地面：调色板 + 72×72 块排布表 + 32×32 8bpp 图块） ─────────────────────────
export interface Gnd {
  cols: number;
  rows: number;
  field8: number;
  field10: number;
  header: number[];
  palette: Uint16Array;
  layout: Uint16Array;
  tileBase: number;
  tileCount: number;
  tail: number;
}
export function parseGnd(d: Uint8Array): Gnd {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const cols = dv.getUint16(4, true);
  const rows = dv.getUint16(6, true);
  const header: number[] = [];
  for (let k = 4; k < 16; k += 2) header.push(dv.getUint16(k, true));
  const palette = new Uint16Array(256);
  for (let i = 0; i < 256; i++) palette[i] = dv.getUint16(16 + i * 2, true);
  const layoutOff = 16 + 512;
  const layout = new Uint16Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) layout[i] = dv.getUint16(layoutOff + i * 2, true);
  const tileBase = layoutOff + cols * rows * 2;
  const tileCount = Math.floor((d.length - tileBase) / 1024);
  return {
    cols,
    rows,
    field8: dv.getUint16(8, true),
    field10: dv.getUint16(10, true),
    header,
    palette,
    layout,
    tileBase,
    tileCount,
    tail: d.length - tileBase - tileCount * 1024,
  };
}
export function decodeGnd(d: Uint8Array, g: Gnd, tileMap: (v: number) => number = (v) => v): Rgba {
  const W = g.cols * 32;
  const H = g.rows * 32;
  const px = new Uint8Array(W * H * 4);
  const lut = new Uint8Array(256 * 3);
  for (let k = 0; k < 256; k++) lut.set(rgb555(g.palette[k]!), k * 3);
  for (let ty = 0; ty < g.rows; ty++) {
    for (let tx = 0; tx < g.cols; tx++) {
      const t = tileMap(g.layout[ty * g.cols + tx]!);
      const src = g.tileBase + t * 1024;
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const idx = src + y * 32 + x < d.length ? d[src + y * 32 + x]! : 0;
          const o = ((ty * 32 + y) * W + tx * 32 + x) * 4;
          px[o] = lut[idx * 3]!;
          px[o + 1] = lut[idx * 3 + 1]!;
          px[o + 2] = lut[idx * 3 + 2]!;
          px[o + 3] = 255;
        }
      }
    }
  }
  return { w: W, h: H, px };
}

// ───────────────────────── 无头 RGB555 ─────────────────────────
export function decodeRaw555(d: Uint8Array, w: number, h: number, skip = 0): Rgba {
  const px = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const q = skip + p * 2;
    const c = q + 1 < d.length ? d[q]! | (d[q + 1]! << 8) : 0;
    const [r, g, b] = rgb555(c);
    px.set([r, g, b, 255], p * 4);
  }
  return { w, h, px };
}

// ───────────────────────── FLIC（Autodesk FLC，8 位调色板） ─────────────────────────
export interface FlicInfo {
  size: number;
  magic: number;
  frames: number;
  w: number;
  h: number;
  depth: number;
  flags: number;
  speed: number;
  oframe1: number;
  oframe2: number;
  chunkTypes: Record<string, number>;
}
export function flicInfo(d: Uint8Array): FlicInfo {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const info: FlicInfo = {
    size: dv.getUint32(0, true),
    magic: dv.getUint16(4, true),
    frames: dv.getUint16(6, true),
    w: dv.getUint16(8, true),
    h: dv.getUint16(10, true),
    depth: dv.getUint16(12, true),
    flags: dv.getUint16(14, true),
    speed: dv.getUint32(16, true),
    oframe1: dv.getUint32(80, true),
    oframe2: dv.getUint32(84, true),
    chunkTypes: {},
  };
  let p = 128;
  while (p + 6 <= d.length) {
    const sz = dv.getUint32(p, true);
    const ty = dv.getUint16(p + 4, true);
    if (sz < 6) break;
    const key = `frame:${ty.toString(16)}`;
    info.chunkTypes[key] = (info.chunkTypes[key] ?? 0) + 1;
    if (ty === 0xf1fa) {
      const nsub = dv.getUint16(p + 6, true);
      let q = p + 16;
      for (let s = 0; s < nsub && q + 6 <= p + sz; s++) {
        const ssz = dv.getUint32(q, true);
        const sty = dv.getUint16(q + 4, true);
        const k2 = `sub:${sty}`;
        info.chunkTypes[k2] = (info.chunkTypes[k2] ?? 0) + 1;
        if (ssz < 6) break;
        q += ssz;
      }
    }
    p += sz;
  }
  return info;
}

/**
 * 解一段 FLIC。实测全部 105 段都是 **标准 8 位 FLC**（magic 0xAF12，depth=8）：
 * 帧块 0xF1FA；子块 4=COLOR_256、7=DELTA_FLC、15=BYTE_RUN、16=FLI_COPY、18=PSTAMP（缩略图，跳过），
 * 另有 0xF100 前缀块（跳过）。调色板为 8 位 RGB 分量（0..255）。
 */
export function decodeFlic(
  d: Uint8Array,
  maxFrames = Infinity,
  keyZero = false,
): { info: FlicInfo; frames: Rgba[]; palettes: Uint8Array[] } {
  const info = flicInfo(d);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const { w, h } = info;
  const buf = new Uint8Array(w * h);
  const pal = new Uint8Array(256 * 3);
  const frames: Rgba[] = [];
  const palettes: Uint8Array[] = [];
  let p = 128;
  while (p + 6 <= d.length && frames.length < Math.min(info.frames, maxFrames)) {
    const sz = dv.getUint32(p, true);
    const ty = dv.getUint16(p + 4, true);
    if (sz < 6) break;
    if (ty === 0xf1fa) {
      const nsub = dv.getUint16(p + 6, true);
      let q = p + 16;
      for (let s = 0; s < nsub; s++) {
        const ssz = dv.getUint32(q, true);
        const sty = dv.getUint16(q + 4, true);
        applyFlicChunk(d, dv, sty, q + 6, q + ssz, buf, pal, w, h);
        q += ssz;
      }
      const px = new Uint8Array(w * h * 4);
      for (let k = 0; k < w * h; k++) {
        const c = buf[k]!;
        px[k * 4] = pal[c * 3]!;
        px[k * 4 + 1] = pal[c * 3 + 1]!;
        px[k * 4 + 2] = pal[c * 3 + 2]!;
        px[k * 4 + 3] = keyZero && c === 0 ? 0 : 255;
      }
      frames.push({ w, h, px });
      palettes.push(pal.slice());
    }
    p += sz;
  }
  return { info, frames, palettes };
}


/** 调试：首帧四角的调色板索引与 RGB（用于判定色键） */
export function decodeFlicIdx(d: Uint8Array): string {
  const info = flicInfo(d);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const { w, h } = info;
  const buf = new Uint8Array(w * h);
  const pal = new Uint8Array(256 * 3);
  let p = 128;
  while (p + 6 <= d.length) {
    const sz = dv.getUint32(p, true);
    const ty = dv.getUint16(p + 4, true);
    if (ty === 0xf1fa) {
      const nsub = dv.getUint16(p + 6, true);
      let q = p + 16;
      for (let s = 0; s < nsub; s++) {
        const ssz = dv.getUint32(q, true);
        applyFlicChunk(d, dv, dv.getUint16(q + 4, true), q + 6, q + ssz, buf, pal, w, h);
        q += ssz;
      }
      break;
    }
    p += sz;
  }
  const hist = new Uint32Array(256);
  for (const v of buf) hist[v]++;
  const top = [...hist.keys()].sort((a, b) => hist[b]! - hist[a]!)[0]!;
  const c = (i: number) => `${i}(${pal[i * 3]},${pal[i * 3 + 1]},${pal[i * 3 + 2]})`;
  return `${info.w}x${info.h} corner=${c(buf[0]!)} top=${c(top)}@${((hist[top]! / (w * h)) * 100).toFixed(0)}% pal0=${c(0)}`;
}

function applyFlicChunk(
  d: Uint8Array,
  dv: DataView,
  type: number,
  b: number,
  end: number,
  buf: Uint8Array,
  pal: Uint8Array,
  w: number,
  h: number,
): void {
  switch (type) {
    case 4: // COLOR_256
    case 11: {
      // COLOR_64
      let p = b;
      const n = dv.getUint16(p, true);
      p += 2;
      let idx = 0;
      for (let k = 0; k < n; k++) {
        idx += d[p++]!;
        let cnt = d[p++]!;
        if (cnt === 0) cnt = 256;
        for (let c = 0; c < cnt; c++, idx++) {
          for (let j = 0; j < 3; j++) {
            const v = d[p++]!;
            pal[idx * 3 + j] = type === 11 ? (v << 2) | (v >> 4) : v;
          }
        }
      }
      return;
    }
    case 15: {
      // BYTE_RUN
      let p = b;
      for (let y = 0; y < h; y++) {
        p++; // 旧式包数，忽略
        let x = 0;
        while (x < w && p < end) {
          const cnt = (d[p++]! << 24) >> 24;
          if (cnt > 0) {
            const v = d[p++]!;
            for (let k = 0; k < cnt && x < w; k++) buf[y * w + x++] = v;
          } else if (cnt < 0) {
            for (let k = 0; k < -cnt && x < w; k++) buf[y * w + x++] = d[p++]!;
          }
        }
      }
      return;
    }
    case 7: {
      // DELTA_FLC（按 16 位字）
      let p = b;
      let lines = dv.getUint16(p, true);
      p += 2;
      let y = 0;
      while (lines > 0 && p < end) {
        let op = dv.getUint16(p, true);
        p += 2;
        let lastByte = -1;
        while ((op & 0xc000) !== 0) {
          if ((op & 0xc000) === 0xc000) y += 0x10000 - op;
          else lastByte = op & 0xff;
          op = dv.getUint16(p, true);
          p += 2;
        }
        let x = 0;
        for (let pk = 0; pk < op; pk++) {
          x += d[p++]!;
          const cnt = (d[p++]! << 24) >> 24;
          if (cnt > 0) {
            for (let k = 0; k < cnt * 2; k++) buf[y * w + x++] = d[p++]!;
          } else if (cnt < 0) {
            const a = d[p++]!;
            const c = d[p++]!;
            for (let k = 0; k < -cnt; k++) {
              buf[y * w + x++] = a;
              buf[y * w + x++] = c;
            }
          }
        }
        if (lastByte >= 0) buf[y * w + w - 1] = lastByte;
        y++;
        lines--;
      }
      return;
    }
    case 12: {
      // DELTA_FLI（按字节）
      let p = b;
      let y = dv.getUint16(p, true);
      const lines = dv.getUint16(p + 2, true);
      p += 4;
      for (let l = 0; l < lines; l++, y++) {
        const np = d[p++]!;
        let x = 0;
        for (let k = 0; k < np; k++) {
          x += d[p++]!;
          const cnt = (d[p++]! << 24) >> 24;
          if (cnt > 0) for (let j = 0; j < cnt; j++) buf[y * w + x++] = d[p++]!;
          else if (cnt < 0) {
            const v = d[p++]!;
            for (let j = 0; j < -cnt; j++) buf[y * w + x++] = v;
          }
        }
      }
      return;
    }
    case 16: // FLI_COPY
      buf.set(d.subarray(b, b + w * h));
      return;
    case 13: // BLACK
      buf.fill(0);
      return;
    case 18: // PSTAMP 缩略图
      return;
    default:
      throw new Error(`FLIC chunk ${type} unknown (end=${end})`);
  }
}

// ───────────────────────── PNG 编码（RGBA8，filter 0） ─────────────────────────
export function encodePng(img: Rgba): Uint8Array {
  const { w, h, px } = img;
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(px.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const c = new Uint8Array(12 + data.length);
    const dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    dv.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
    return c;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, w);
  hv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 6 }))),
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
export function writePng(file: string, img: Rgba): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodePng(img));
}

// ───────────────────────── 联系表 ─────────────────────────
const FONT: Record<string, string> = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001001001001',
  '8': '111101111101111',
  '9': '111101111001111',
  ':': '000010000010000',
  '#': '101111101111101',
  '-': '000000111000000',
  '.': '000000000000010',
  x: '000101010101000',
  A: '010101111101101',
  B: '110101110101110',
  C: '011100100100011',
  D: '110101101101110',
  E: '111100110100111',
  F: '111100110100100',
  G: '011100101101011',
  I: '111010010010111',
  J: '001001001101010',
  K: '101101110101101',
  L: '100100100100111',
  M: '101111111101101',
  N: '110101101101101',
  O: '010101101101010',
  P: '110101110100100',
  R: '110101110101101',
  S: '011100010001110',
  T: '111010010010010',
  U: '101101101101111',
  W: '101101111111101',
  Y: '101101010010010',
  H: '101101111101101',
  Q: '010101101110011',
  V: '101101101101010',
  X: '101101010101101',
  Z: '111001010100111',
  '/': '001001010100100',
  '+': '000010111010000',
  ' ': '000000000000000',
};
function drawText(img: Rgba, x0: number, y0: number, text: string, s = 2, rgb: [number, number, number] = [0, 0, 0]): void {
  let x = x0;
  for (const ch of text.toUpperCase() === text ? text : text) {
    const g = FONT[ch] ?? FONT[ch.toUpperCase()] ?? FONT[' ']!;
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 3; c++)
        if (g[r * 3 + c] === '1')
          for (let dy = 0; dy < s; dy++)
            for (let dx = 0; dx < s; dx++) {
              const px = x + c * s + dx;
              const py = y0 + r * s + dy;
              if (px < 0 || py < 0 || px >= img.w || py >= img.h) continue;
              const o = (py * img.w + px) * 4;
              img.px.set([rgb[0], rgb[1], rgb[2], 255], o);
            }
    x += 4 * s;
  }
}
function blit(dst: Rgba, src: Rgba, x0: number, y0: number, scale = 1): void {
  for (let y = 0; y < src.h * scale; y++) {
    for (let x = 0; x < src.w * scale; x++) {
      const dx = x0 + x;
      const dy = y0 + y;
      if (dx < 0 || dy < 0 || dx >= dst.w || dy >= dst.h) continue;
      const s = (Math.floor(y / scale) * src.w + Math.floor(x / scale)) * 4;
      const a = src.px[s + 3]!;
      if (a === 0) continue;
      dst.px.set(src.px.subarray(s, s + 4), (dy * dst.w + dx) * 4);
    }
  }
}
export function contactSheet(
  cells: { img: Rgba; label: string }[],
  opts: { cols?: number; maxCell?: number; title?: string } = {},
): Rgba {
  const maxCell = opts.maxCell ?? 160;
  // 整张表统一的放大倍数（仅当所有格都 ≤ maxCell/2 时 ×2），避免同一资源不同帧被缩放成不同比例
  const biggest = Math.max(...cells.map((c) => Math.max(c.img.w, c.img.h)));
  const sheetK = biggest * 2 <= maxCell ? 2 : 1;
  const scaled = cells.map((c) => {
    const m = Math.max(c.img.w, c.img.h);
    const k = m * sheetK > maxCell ? maxCell / m : sheetK;
    return { ...c, img: k === 1 ? c.img : resize(c.img, k) };
  });
  const cols = opts.cols ?? Math.ceil(Math.sqrt(scaled.length));
  const cw = Math.max(...scaled.map((c) => c.img.w), 60) + 8;
  const ch = Math.max(...scaled.map((c) => c.img.h)) + 22;
  const rows = Math.ceil(scaled.length / cols);
  const top = opts.title ? 22 : 0;
  const W = cols * cw;
  const H = rows * ch + top;
  const px = new Uint8Array(W * H * 4);
  // 棋盘格背景（便于看透明），格间白线
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = ((x >> 3) + (y >> 3)) & 1 ? 200 : 150;
      px.set([v, v + 30 > 255 ? 255 : v + 30, v, 255], (y * W + x) * 4);
    }
  const sheet: Rgba = { w: W, h: H, px };
  if (opts.title) {
    for (let y = 0; y < top; y++) for (let x = 0; x < W; x++) px.set([255, 255, 255, 255], (y * W + x) * 4);
    drawText(sheet, 4, 4, opts.title, 2);
  }
  scaled.forEach((c, i) => {
    const cx = (i % cols) * cw;
    const cy = top + Math.floor(i / cols) * ch;
    for (let y = cy; y < cy + 16; y++) for (let x = cx; x < cx + cw; x++) px.set([255, 255, 255, 255], (y * W + x) * 4);
    drawText(sheet, cx + 3, cy + 3, c.label, 2);
    blit(sheet, c.img, cx + 4, cy + 18);
  });
  return sheet;
}
export function resize(img: Rgba, k: number): Rgba {
  const w = Math.max(1, Math.round(img.w * k));
  const h = Math.max(1, Math.round(img.h * k));
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.w - 1, Math.floor(x / k));
      const sy = Math.min(img.h - 1, Math.floor(y / k));
      px.set(img.px.subarray((sy * img.w + sx) * 4, (sy * img.w + sx) * 4 + 4), (y * w + x) * 4);
    }
  return { w, h, px };
}
export function crop(img: Rgba, x0: number, y0: number, w: number, h: number): Rgba {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) px.set(img.px.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4), y * w * 4);
  return { w, h, px };
}

// ───────────────────────── 命令 ─────────────────────────
const ARCHIVES = ['Data.mkf', 'Panel.mkf', 'jump.mkf', 'map.mkf', 'help.mkf', 'Effect.mkf'];

function survey(): void {
  const files = [...ARCHIVES.map((a) => join(GAME, a)), join(ROOT, 'original/MultiverseJourney/map.mkf')];
  const summary: Record<string, unknown> = {};
  for (const file of files) {
    const mkf = Mkf.open(file);
    const label = file.includes('MultiverseJourney') ? 'MJ-map.mkf' : mkf.name;
    const rows: Record<string, unknown>[] = [];
    const kinds: Record<string, number> = {};
    let frames = 0;
    const problems: string[] = [];
    const t0 = Date.now();
    for (const e of mkf.entries) {
      const row: Record<string, unknown> = {
        i: e.index,
        raw: e.rawSize,
        stored: e.storedSize,
        imgOff: e.imgOff,
        imgSize: e.imgSize,
        lz: e.compressed,
      };
      if (e.rawSize === 0) {
        row.kind = 'empty';
        rows.push(row);
        kinds.empty = (kinds.empty ?? 0) + 1;
        continue;
      }
      let d: Uint8Array;
      try {
        d = mkf.read(e.index);
      } catch (err) {
        row.kind = 'ERR';
        row.err = String(err);
        problems.push(`#${e.index} ${err}`);
        rows.push(row);
        continue;
      }
      const k = sniff(d);
      row.kind = k;
      kinds[k] = (kinds[k] ?? 0) + 1;
      if (k === 'SPR' || k === 'SMP') {
        const sh = parseSheet(d);
        row.n = sh.count;
        row.start = sh.start;
        row.closed = sh.closed;
        row.sizeOk = sh.sizeOk;
        row.dims = sh.frames.slice(0, 4).map((f) => `${f.w}x${f.h}@${f.x},${f.y}`);
        frames += sh.count;
        // imgOff/imgSize 与结构的关系
        const expOff = k === 'SPR' ? sh.start : sh.start;
        const expSize = k === 'SPR' ? 512 : d.length - sh.start;
        row.imgRule = e.imgOff === expOff && e.imgSize === expSize;
        if (sh.start !== 12 + 12 * sh.count) problems.push(`#${e.index} start ${sh.start} != 12+12n`);
        if (!sh.closed || !sh.sizeOk || !row.imgRule) problems.push(`#${e.index} ${k} closed=${sh.closed} sizeOk=${sh.sizeOk} imgRule=${row.imgRule}`);
      } else if (k === 'GND') {
        const g = parseGnd(d);
        row.gnd = { cols: g.cols, rows: g.rows, header: g.header, tileBase: g.tileBase, tileCount: g.tileCount, tail: g.tail };
        let maxT = 0;
        for (const v of g.layout) maxT = Math.max(maxT, v);
        (row.gnd as Record<string, unknown>).layoutMax = maxT;
      } else if (k === 'FLIC') {
        const fi = flicInfo(d);
        row.flic = { frames: fi.frames, w: fi.w, h: fi.h, depth: fi.depth, speed: fi.speed, chunks: fi.chunkTypes };
      } else if (k === 'raw') {
        row.head = Buffer.from(d.subarray(0, 16)).toString('hex');
        const n = d.length;
        const guesses: string[] = [];
        for (const [w, h] of [
          [640, 480],
          [200, 200],
          [440, 440],
          [440, 96],
          [400, 400],
          [128, 192],
        ] as const) {
          if (n === w * h * 2) guesses.push(`${w}x${h}x16`);
          if (n === w * h) guesses.push(`${w}x${h}x8`);
        }
        row.guess = guesses;
      }
      rows.push(row);
    }
    const out = { file: label, count: mkf.entries.length, kinds, frames, problems, ms: Date.now() - t0, rows };
    mkdirSync(join(OUT, 'sprite'), { recursive: true });
    writeFileSync(join(OUT, 'sprite', `survey-${label}.json`), JSON.stringify(out, null, 1));
    summary[label] = { count: mkf.entries.length, kinds, frames, problems: problems.length, ms: out.ms };
    console.log(label, JSON.stringify(summary[label]));
    if (problems.length) console.log('  problems:', problems.slice(0, 12).join(' | '));
  }
  writeFileSync(join(OUT, 'sprite', 'survey-summary.json'), JSON.stringify(summary, null, 1));
}

function bits(): void {
  // RGB555 vs 565 判别：统计 16 位像素最高位（bit15）置位率。555 数据的 bit15 应恒为 0。
  const stats: Record<string, { px: number; bit15: number; greenLsbPairs?: number }> = {};
  for (const a of ['Data.mkf', 'Panel.mkf', 'jump.mkf', 'map.mkf', 'help.mkf']) {
    const mkf = Mkf.open(join(GAME, a));
    const st = { px: 0, bit15: 0, pal: 0, palBit15: 0 };
    for (const e of mkf.entries) {
      if (!e.imgSize) continue;
      let d: Uint8Array;
      try {
        d = mkf.read(e.index);
      } catch {
        continue;
      }
      const k = sniff(d);
      if (k === 'FLIC') continue;
      // imgOff/imgSize 就是原版需要做像素格式转换的那一段（调色板或 16 位像素区）
      for (let q = e.imgOff; q + 1 < e.imgOff + e.imgSize && q + 1 < d.length; q += 2) {
        const c = d[q]! | (d[q + 1]! << 8);
        if (k === 'SPR' || k === 'GND') {
          st.pal++;
          if (c & 0x8000) st.palBit15++;
        } else {
          st.px++;
          if (c & 0x8000) st.bit15++;
        }
      }
    }
    stats[a] = st as never;
    console.log(a, JSON.stringify(st));
  }
  mkdirSync(join(OUT, 'sprite'), { recursive: true });
  writeFileSync(join(OUT, 'sprite', 'bit15-stats.json'), JSON.stringify(stats, null, 1));
}

/** 按资源类型解出若干帧（raw16 需给尺寸） */
export function loadFrames(
  archive: string,
  res: number,
  which = 'all',
  opts: { keyZero?: boolean; size?: [number, number] } = {},
): { img: Rgba; frame: number; kind: string }[] {
  const file = archive === 'MJ-map.mkf' ? join(ROOT, 'original/MultiverseJourney/map.mkf') : join(GAME, archive);
  const mkf = mkfCache.get(file) ?? Mkf.open(file);
  mkfCache.set(file, mkf);
  const d = mkf.read(res);
  const k = sniff(d);
  const keyZero = opts.keyZero ?? true;
  const pick = (n: number): number[] => {
    if (which === 'all') return [...Array(n).keys()];
    if (which === 'first') return n ? [0] : [];
    return which
      .split(',')
      .flatMap((s) => {
        const [a, b] = s.split('-').map(Number);
        return b === undefined ? [a!] : [...Array(b - a! + 1).keys()].map((q) => q + a!);
      })
      .filter((f) => f < n);
  };
  if (k === 'SPR' || k === 'SMP') {
    const sh = parseSheet(d);
    return pick(sh.count).map((f) => ({ img: decodeFrame(d, sh, f, { keyZero }), frame: f, kind: k }));
  }
  if (k === 'FLIC') {
    const want = pick(flicInfo(d).frames);
    const { frames } = decodeFlic(d, Math.max(...want, 0) + 1, keyZero);
    return want.filter((f) => f < frames.length).map((f) => ({ img: frames[f]!, frame: f, kind: k }));
  }
  if (k === 'GND') return [{ img: decodeGnd(d, parseGnd(d)), frame: 0, kind: k }];
  if (k === 'raw') {
    const guess: [number, number] | undefined =
      opts.size ??
      (d.length === 80000
        ? [200, 200]
        : d.length === 614400
          ? [640, 480]
          : d.length === 194776
            ? [388, 251]
            : d.length === 84480
              ? [165, 256]
              : undefined);
    if (!guess) throw new Error(`${archive}#${res}: raw ${d.length} bytes, size unknown`);
    return [{ img: decodeRaw555(d, guess[0], guess[1]), frame: 0, kind: 'RAW555' }];
  }
  throw new Error(`${archive}#${res}: kind ${k}`);
}
const mkfCache = new Map<string, Mkf>();

function exportRes(archive: string, res: number, which: string, keyZero = true, dir = join(OUT, 'samples')): Rgba[] {
  const base = join(dir, archive.replace(/\.mkf$/i, ''));
  const got = loadFrames(archive, res, which, { keyZero });
  for (const g of got) writePng(join(base, `${res}_${g.frame}.png`), g.img);
  return got.map((g) => g.img);
}

/** 概览：区间内每个资源取首帧（或指定帧），拼一张联系表 */
function overview(archive: string, from: number, to: number, which = 'first', maxCell = 120): void {
  const cells: { img: Rgba; label: string }[] = [];
  for (let r = from; r <= to; r++) {
    try {
      for (const g of loadFrames(archive, r, which)) cells.push({ img: g.img, label: `${r}:${g.frame}` });
    } catch (e) {
      console.log(`skip ${r}: ${String(e).slice(0, 80)}`);
    }
  }
  const tag = archive.replace(/\.mkf$/i, '');
  const out = join(OUT, 'samples', 'contact', `overview-${tag}-${from}-${to}.png`);
  writePng(out, contactSheet(cells, { maxCell, title: `${tag} ${from}-${to}` }));
  console.log(out, cells.length);
}

/** 单资源多帧联系表 */
function sheet(archive: string, res: number, which = 'all', maxCell = 160, cols?: number, name?: string): string {
  const got = loadFrames(archive, res, which);
  const tag = archive.replace(/\.mkf$/i, '');
  const out = join(OUT, 'samples', 'contact', name ?? `sheet-${tag}-${res}.png`);
  writePng(
    out,
    contactSheet(
      got.map((g) => ({ img: g.img, label: `${res}:${g.frame}` })),
      { maxCell, cols, title: `${tag} ${res} ${got[0]?.kind ?? ''} ${got[0]?.img.w}x${got[0]?.img.h}` },
    ),
  );
  return out;
}

/** GND 图块接缝指标：块边界两侧像素差 / 块内部相邻像素差（越接近 1 越说明拼接顺序正确） */
export function gndSeamRatio(img: Rgba): number {
  let inner = 0;
  let innerN = 0;
  let seam = 0;
  let seamN = 0;
  for (let y = 0; y < img.h; y += 3) {
    for (let x = 1; x < img.w; x++) {
      const a = (y * img.w + x - 1) * 4;
      const b = (y * img.w + x) * 4;
      const diff = Math.abs(img.px[a]! - img.px[b]!) + Math.abs(img.px[a + 1]! - img.px[b + 1]!) + Math.abs(img.px[a + 2]! - img.px[b + 2]!);
      if (x % 32 === 0) {
        seam += diff;
        seamN++;
      } else if (x % 32 === 16) {
        inner += diff;
        innerN++;
      }
    }
  }
  return seam / seamN / (inner / innerN);
}

function samples(): void {
  const dir = join(OUT, 'samples');
  const cdir = join(dir, 'contact');
  const log: Record<string, unknown>[] = [];
  const save = (archive: string, res: number, which: string, keyZero = true) => {
    const got = loadFrames(archive, res, which, { keyZero });
    const base = join(dir, archive.replace(/\.mkf$/i, ''));
    for (const g of got) writePng(join(base, `${res}_${g.frame}.png`), g.img);
    log.push({ archive, res, frames: got.map((g) => g.frame), kind: got[0]?.kind, size: got[0] ? `${got[0].img.w}x${got[0].img.h}` : null });
    return got;
  };
  const sheetOf = (name: string, title: string, cells: { img: Rgba; label: string }[], cols?: number, maxCell = 140) => {
    const out = join(cdir, name);
    writePng(out, contactSheet(cells, { cols, maxCell, title }));
    console.log('sheet', out, cells.length);
  };

  // 1) 角色：Data.mkf 87 + 21×角色 + k（v2.06；v3.11 为 128 起）
  const CHAR_BASE = 87;
  save('Data.mkf', CHAR_BASE, 'all');
  const walk0 = save('Data.mkf', CHAR_BASE + 1, 'all');
  sheetOf('chars-c0-walk-8dir.png', 'DATA 88 WALK 8DIR X 9', walk0.map((g) => ({ img: g.img, label: `88:${g.frame}` })), 9, 100);
  const walkCells: { img: Rgba; label: string }[] = [];
  const poseCells: { img: Rgba; label: string }[] = [];
  for (let c = 0; c < 12; c++) {
    const r = CHAR_BASE + 21 * c + 1;
    for (const g of save('Data.mkf', r, '9-17')) walkCells.push({ img: g.img, label: `${r}:${g.frame}` });
    for (let k = 0; k < 21; k++) {
      const got = save('Data.mkf', CHAR_BASE + 21 * c + k, 'first');
      poseCells.push({ img: got[0]!.img, label: `${CHAR_BASE + 21 * c + k}` });
    }
  }
  sheetOf('chars-12-walk.png', 'DATA 87+21C+1 WALK DIR1', walkCells, 9, 90);
  sheetOf('chars-12-poses21.png', 'DATA 87+21C+K K0-20', poseCells, 21, 70);

  // 2) 建筑：map.mkf 27 + 5×地图 + (等级−1)，每资源 8 张 = 8 个朝向；调色板 #255 = 归属色描边
  const bCells: { img: Rgba; label: string }[] = [];
  for (let r = 27; r <= 46; r++) for (const g of save('map.mkf', r, 'all')) bCells.push({ img: g.img, label: `${r}:${g.frame}` });
  sheetOf('buildings-4maps-5lv-8dir.png', 'MAP 27-46 BUILDINGS', bCells, 8, 110);
  const lmCells: { img: Rgba; label: string }[] = [];
  for (let r = 47; r <= 149; r++) for (const g of save('map.mkf', r, 'first')) lmCells.push({ img: g.img, label: `${r}` });
  sheetOf('map-landmarks-47-149.png', 'MAP 47-149 FRAME 0', lmCells, 12, 100);

  // 3) GND 地面
  const gCells: { img: Rgba; label: string }[] = [];
  for (const r of [0, 2, 4, 6]) {
    const g = save('map.mkf', r, 'all')[0]!.img;
    const ratio = gndSeamRatio(g);
    const mkf = mkfCache.get(join(GAME, 'map.mkf'))!;
    const d = mkf.read(r);
    const gp = parseGnd(d);
    // 对照：若按列主序排块，接缝比会显著变大
    const t = decodeGnd(d, gp, (v) => (v % gp.cols) * gp.cols + Math.floor(v / gp.cols));
    const ratioT = gndSeamRatio(t);
    log.push({ gnd: r, seamRatioRowMajor: +ratio.toFixed(3), seamRatioColMajor: +ratioT.toFixed(3) });
    console.log(`GND #${r} seam ratio row-major=${ratio.toFixed(3)} col-major=${ratioT.toFixed(3)}`);
    const small = resize(g, 0.25);
    writePng(join(dir, 'map', `${r}_0_quarter.png`), small);
    gCells.push({ img: small, label: `GND ${r}` });
    if (r === 0) {
      const c1 = crop(g, 1280, 64, 512, 512);
      writePng(join(dir, 'map', `0_0_crop1280x64.png`), c1);
      gCells.push({ img: c1, label: 'GND 0 1:1' });
      const tiles: { img: Rgba; label: string }[] = [];
      for (let k = 0; k < 16; k++) {
        const ti = 3 * 72 + 44 + k; // 取有陆地的一段
        tiles.push({ img: crop(g, (ti % 72) * 32, Math.floor(ti / 72) * 32, 32, 32), label: `T${ti}` });
      }
      sheetOf('gnd0-tiles.png', 'GND 0 TILES 32X32', tiles, 8, 64);
    }
  }
  sheetOf('gnd-4maps.png', 'MAP GND 0 2 4 6', gCells, 5, 576);

  // 4) 神明/物件：Data.mkf 355..372（8 张为一组 8 向旋转）+ 神明降临 FLIC 499..510
  const godCells: { img: Rgba; label: string }[] = [];
  for (let r = 355; r <= 372; r++) for (const g of save('Data.mkf', r, 'all')) godCells.push({ img: g.img, label: `${r}:${g.frame}` });
  sheetOf('gods-objects-355-372.png', 'DATA 355-372 GODS OBJECTS', godCells, 8, 80);
  const filmCells: { img: Rgba; label: string }[] = [];
  for (let r = 499; r <= 510; r++) {
    const n = flicInfo(mkfCache.get(join(GAME, 'Data.mkf'))!.read(r)).frames;
    for (const g of save('Data.mkf', r, `0,${n >> 1},${n - 1}`, true)) filmCells.push({ img: g.img, label: `${r}:${g.frame}` });
  }
  sheetOf('god-films-499-510.png', 'DATA 499-510 GOD FLIC IDX0 KEY', filmCells, 6, 150);
  const npc: { img: Rgba; label: string }[] = [];
  for (let r = 339; r <= 354; r++) for (const g of save('Data.mkf', r, 'first')) npc.push({ img: g.img, label: `${r}` });
  sheetOf('npc-339-354.png', 'DATA 339-354 NPC', npc, 8, 90);

  // 5) 骰子：Panel 3（点数 SPR 3 颗×6 面）、Panel 4/5/6（滚骰 FLIC，索引 0=色键绿）、Panel 72（选骰盘）
  const dice: { img: Rgba; label: string }[] = [];
  for (const g of save('Panel.mkf', 3, 'all')) dice.push({ img: g.img, label: `3:${g.frame}` });
  for (const g of save('Panel.mkf', 4, '0,4,8,12,16,20,24,28,32,35', true)) dice.push({ img: g.img, label: `F4:${g.frame}` });
  for (const g of save('Panel.mkf', 72, 'all')) dice.push({ img: g.img, label: `72:${g.frame}` });
  sheetOf('dice.png', 'PANEL 3 DICE + 4 FLIC + 72', dice, 9, 130);

  // 6) UI 面板
  const ui: { img: Rgba; label: string }[] = [];
  const uiPick: [string, number, string][] = [
    ['Panel.mkf', 0, 'all'],
    ['Panel.mkf', 1, 'all'],
    ['Panel.mkf', 7, 'all'],
    ['Panel.mkf', 2, '0,1,2'],
    ['Panel.mkf', 9, '0'],
    ['Panel.mkf', 11, '0,1'],
    ['Panel.mkf', 77, '0'],
    ['Panel.mkf', 10, '0'],
    ['Panel.mkf', 23, '0'],
    ['Panel.mkf', 18, '0'],
    ['Data.mkf', 1, 'all'],
    ['Data.mkf', 2, 'all'],
    ['Data.mkf', 3, '0'],
    ['Data.mkf', 399, 'all'],
    ['Data.mkf', 476, '0'],
    ['jump.mkf', 4, 'all'],
    ['map.mkf', 8, 'all'],
    ['map.mkf', 12, 'all'],
    ['map.mkf', 13, 'all'],
  ];
  for (const [a, r, w] of uiPick) for (const g of save(a, r, w)) ui.push({ img: g.img, label: `${a[0]}${r}:${g.frame}` });
  sheetOf('ui-panels.png', 'UI PANELS', ui, 8, 180);
  const portraits: { img: Rgba; label: string }[] = [];
  for (let r = 15; r <= 26; r++) for (const g of save('map.mkf', r, 'all')) portraits.push({ img: g.img, label: `${r}:${g.frame}` });
  sheetOf('portraits-map15-26.png', 'MAP 15-26 PORTRAITS X7', portraits, 7, 80);

  // 7) 卡片 / 道具图标
  const cards: { img: Rgba; label: string }[] = [];
  for (let r = 530; r <= 559; r++) for (const g of save('Data.mkf', r, 'first')) cards.push({ img: g.img, label: `${r}` });
  sheetOf('cards-530-559.png', 'DATA 530-559 CARDS 165X256', cards, 10, 130);
  const items: { img: Rgba; label: string }[] = [];
  for (const g of save('Panel.mkf', 11, '2-16')) items.push({ img: g.img, label: `P11:${g.frame}` });
  for (const g of save('Panel.mkf', 74, 'all')) items.push({ img: g.img, label: `P74:${g.frame}` });
  for (const g of save('Data.mkf', 0, 'all')) items.push({ img: g.img, label: `D0:${g.frame}` });
  sheetOf('items-icons.png', 'ITEMS P11 P74 D0', items, 12, 70);

  // 8) 新闻 / 命运插画、节日插画
  const news: { img: Rgba; label: string }[] = [];
  for (let r = 400; r <= 475; r++) for (const g of save('Data.mkf', r, 'first')) news.push({ img: g.img, label: `${r}` });
  sheetOf('news-400-475.png', 'DATA 400-475 388X251', news, 10, 120);
  for (const r of [4, 28, 47, 68]) save('Data.mkf', r, 'first');

  // 9) jump.mkf：开局场景、侧视动画、跳伞 FLIC
  const jmp: { img: Rgba; label: string }[] = [];
  for (let r = 0; r <= 3; r++) for (const g of save('jump.mkf', r, 'first')) jmp.push({ img: g.img, label: `J${r}` });
  for (const g of save('jump.mkf', 5, 'all')) jmp.push({ img: g.img, label: `J5:${g.frame}` });
  for (const g of save('jump.mkf', 42, '0,7,14')) jmp.push({ img: g.img, label: `J42:${g.frame}` });
  for (const g of save('jump.mkf', 43, '10,20,30', true)) jmp.push({ img: g.img, label: `J43:${g.frame}` });
  sheetOf('jump.png', 'JUMP SCENES SIDEVIEW FLIC', jmp, 8, 160);

  writeFileSync(join(OUT, 'sprite', 'samples-log.json'), JSON.stringify(log, null, 1));
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'survey') survey();
  else if (cmd === 'bits') bits();
  else if (cmd === 'overview') overview(args[0]!, Number(args[1]), Number(args[2]), args[3] ?? 'first', Number(args[4] ?? 120));
  else if (cmd === 'sheet')
    console.log(sheet(args[0]!, Number(args[1]), args[2] ?? 'all', Number(args[3] ?? 160), args[4] ? Number(args[4]) : undefined));
  else if (cmd === 'samples') samples();
  else if (cmd === 'export') {
    const imgs = exportRes(args[0]!, Number(args[1]), args[2] ?? 'all', !args.includes('--opaque'));
    console.log(`exported ${imgs.length}`);
  } else {
    console.log('usage: survey | bits | export <mkf> <res> [frames|all] [--opaque] | samples');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
