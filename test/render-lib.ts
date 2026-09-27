/**
 * 临时调试库（render 调研用）：MKF 读取、私有压缩解压、SPR/SMP/GND 解析、最小 PNG 编码。
 * 全部为自写实现；解压算法依据 docs/research/g_map.md §6.3 的伪代码。只读原版文件。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// ───────────── MKF 容器 ─────────────
export interface MkfEntry {
  index: number;
  offset: number;
  rawSize: number;
  storedSize: number;
  imgOff: number;
  imgSize: number;
}

export class Mkf {
  readonly bytes: Uint8Array;
  readonly entries: MkfEntry[] = [];
  private readonly dv: DataView;
  private readonly cache = new Map<number, Uint8Array>();
  constructor(readonly path: string) {
    const buf = readFileSync(path);
    this.bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const x = this.dv.getUint32(0, true);
    const n = (this.bytes.length - x) / 4;
    const starts: number[] = [];
    for (let i = 0; i < n; i++) starts.push(this.dv.getUint32(x + i * 4, true));
    for (let i = 0; i < n; i++) {
      const off = starts[i]!;
      if (off === x) break; // 哨兵
      this.entries.push({
        index: i,
        offset: off,
        rawSize: this.dv.getUint32(off, true),
        storedSize: this.dv.getUint32(off + 4, true),
        imgOff: this.dv.getUint32(off + 8, true),
        imgSize: this.dv.getUint32(off + 12, true),
      });
    }
  }
  get(i: number): Uint8Array {
    const hit = this.cache.get(i);
    if (hit) return hit;
    const e = this.entries[i];
    if (!e) throw new Error(`${this.path}: 资源 ${i} 不存在`);
    const body = this.bytes.subarray(e.offset + 16, e.offset + 16 + e.storedSize);
    const out = e.rawSize === e.storedSize ? body : lzhufDecompress(body, e.rawSize);
    if (out.length !== e.rawSize) throw new Error(`资源 ${i} 解压长度 ${out.length} ≠ ${e.rawSize}`);
    this.cache.set(i, out);
    return out;
  }
}

// ───────────── 私有压缩（自适应哈夫曼 + LZ77，LSB-first） ─────────────
const NCHAR = 321;
const T = 641;
const DLEN = new Uint8Array(256);
const DHI = new Uint8Array(256);
(() => {
  const m3: Record<number, number> = { 3: 0, 11: 1, 13: 2 };
  const m5: Record<number, number> = { 1: 0, 5: 1, 9: 2, 14: 3 };
  const m6: Record<number, number> = { 2: 0, 6: 1, 10: 2 };
  const m7: Record<number, number> = { 4: 0, 8: 1, 12: 2 };
  for (let v = 0; v < 256; v++) {
    const blk = v >> 4;
    const lo = v & 15;
    if (lo === 0) [DLEN[v], DHI[v]] = [8, 63 - blk];
    else if (lo === 7 || lo === 15) [DLEN[v], DHI[v]] = [3, 0];
    else if (lo in m3) [DLEN[v], DHI[v]] = [4, 3 - m3[lo]!];
    else if (lo in m5) [DLEN[v], DHI[v]] = [5, 11 - 4 * (blk % 2) - m5[lo]!];
    else if (lo in m6) [DLEN[v], DHI[v]] = [6, 23 - 3 * (blk % 4) - m6[lo]!];
    else [DLEN[v], DHI[v]] = [7, 47 - 3 * (blk % 8) - m7[lo]!];
  }
})();

export function lzhufDecompress(src: Uint8Array, size: number): Uint8Array {
  const freq = new Uint32Array(T + 1);
  const son = new Int32Array(T);
  const prnt = new Int32Array(T + NCHAR + 1);
  for (let i = 0; i < NCHAR; i++) freq[i] = 1;
  for (let j = NCHAR; j < T; j++) freq[j] = freq[2 * (j - NCHAR)]! + freq[2 * (j - NCHAR) + 1]!;
  freq[T] = 0xffff;
  for (let i = 0; i < NCHAR; i++) son[i] = (i + T) * 2;
  for (let k = 0; k < T - NCHAR; k++) son[NCHAR + k] = 2 * k * 2;
  for (let i = 0; i < 640; i++) prnt[i] = (NCHAR + (i >> 1)) * 2;
  prnt[640] = 0;
  for (let s = 0; s < NCHAR; s++) prnt[T + s] = s * 2;
  prnt[962] = 0;
  const nbits = src.length * 8;
  let pos = 0;
  const bit = (p: number) => (p < nbits ? (src[p >> 3]! >> (p & 7)) & 1 : 0);
  const bump = (s: number) => {
    let e = prnt[T + s]! >> 1;
    for (;;) {
      freq[e]!++;
      const a = freq[e]!;
      if (a <= freq[e + 1]!) {
        e = prnt[e]! >> 1;
        if (e === 0) return;
        continue;
      }
      let l = e + 1;
      while (freq[l] === a - 1) l++;
      l--;
      const t = freq[e]!;
      freq[e] = freq[l]!;
      freq[l] = t;
      const i = son[e]!;
      const j = son[l]!;
      prnt[j >> 1] = e * 2;
      if (j < 0x502) prnt[(j >> 1) + 1] = e * 2;
      prnt[i >> 1] = l * 2;
      if (i < 0x502) prnt[(i >> 1) + 1] = l * 2;
      son[e] = j;
      son[l] = i;
      e = prnt[l]! >> 1;
      if (e === 0) return;
    }
  };
  const rescale = () => {
    for (let s = 0; s < NCHAR; s++) if (freq[prnt[T + s]! >> 1]! & 1) bump(s);
    for (let k = 0; k < T; k++) freq[k] = freq[k]! >> 1;
  };
  const out = new Uint8Array(size);
  let n = 0;
  while (n < size) {
    let node = 640;
    let c: number;
    for (;;) {
      c = son[node]! >> 1;
      if (c >= T) break;
      c += bit(pos++);
      node = c;
    }
    const s = c - T;
    if (freq[640] === 0x8000) rescale();
    bump(s);
    if (s < 256) {
      out[n++] = s;
      continue;
    }
    let bv = 0;
    for (let k = 0; k < 8; k++) bv |= bit(pos + k) << k;
    const L = DLEN[bv]!;
    let lo6 = 0;
    for (let k = 0; k < 6; k++) lo6 |= bit(pos + L + k) << k;
    const dist = (DHI[bv]! << 6) | lo6;
    pos += L + 6;
    if (dist === 0xfff) break;
    const cnt = Math.min(s - 253, size - n);
    let p = n - 1 - dist;
    for (let k = 0; k < cnt; k++) out[n++] = out[p++]!;
  }
  return out.subarray(0, n);
}

// ───────────── 颜色 ─────────────
/** RGB555 → [r,g,b]（位复制扩展到 8 位） */
export function rgb555(v: number): [number, number, number] {
  const r = (v >> 10) & 31;
  const g = (v >> 5) & 31;
  const b = v & 31;
  return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2)];
}

// ───────────── GND ─────────────
export interface Gnd {
  tilesW: number;
  tilesH: number;
  /** 256 色 RGBA（索引 0 也是不透明颜色：地面没有透明） */
  palette: Uint8Array;
  /** 排布表（tilesW*tilesH 个 u16，实测恒为恒等映射） */
  arrange: Uint16Array;
  /** 图块像素（8bpp，每块 1024 字节，行主序：行 = 世界 y） */
  tiles: Uint8Array;
}
export function parseGnd(d: Uint8Array): Gnd {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (String.fromCharCode(d[0]!, d[1]!, d[2]!) !== 'GND') throw new Error('不是 GND');
  const tilesW = dv.getUint16(4, true);
  const tilesH = dv.getUint16(6, true);
  const count = dv.getUint32(8, true);
  const palette = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = rgb555(dv.getUint16(16 + i * 2, true));
    palette.set([r, g, b, 255], i * 4);
  }
  const arrange = new Uint16Array(tilesW * tilesH);
  for (let i = 0; i < arrange.length; i++) arrange[i] = dv.getUint16(0x210 + i * 2, true);
  const tilesOff = 0x210 + tilesW * tilesH * 2;
  const tiles = d.subarray(tilesOff, tilesOff + count * 1024);
  return { tilesW, tilesH, palette, arrange, tiles };
}

// ───────────── SPR / SMP ─────────────
export interface Frame {
  w: number;
  h: number;
  ax: number;
  ay: number;
  off: number;
  size: number;
}
export interface SpriteLib {
  sig: 'SPR' | 'SMP';
  frames: Frame[];
  /** SPR：256 色 RGBA，索引 0 透明 */
  palette?: Uint8Array;
  data: Uint8Array;
}
export function parseLib(d: Uint8Array): SpriteLib {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const sig = String.fromCharCode(d[0]!, d[1]!, d[2]!) as 'SPR' | 'SMP';
  if (sig !== 'SPR' && sig !== 'SMP') throw new Error(`未知精灵签名 ${sig}`);
  const n = dv.getUint32(4, true);
  const start = dv.getUint32(8, true);
  let off = start + (sig === 'SPR' ? 512 : 0);
  const frames: Frame[] = [];
  for (let k = 0; k < n; k++) {
    const b = 12 + k * 12;
    const f: Frame = {
      w: dv.getUint16(b, true),
      h: dv.getUint16(b + 2, true),
      ax: dv.getInt16(b + 4, true),
      ay: dv.getInt16(b + 6, true),
      off,
      size: dv.getUint32(b + 8, true),
    };
    frames.push(f);
    off += f.size;
  }
  if (off !== d.length) throw new Error(`精灵数据长度不符：${off} ≠ ${d.length}`);
  let palette: Uint8Array | undefined;
  if (sig === 'SPR') {
    palette = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = rgb555(dv.getUint16(start + i * 2, true));
      palette.set([r, g, b, i === 0 ? 0 : 255], i * 4);
    }
  }
  return { sig, frames, palette, data: d };
}

// ───────────── RGBA 画布 ─────────────
export class Canvas {
  readonly px: Uint8ClampedArray;
  /** 裁剪矩形 [x0, y0, x1, y1)（对应原版 0x483498..0x4834a4） */
  clip: [number, number, number, number];
  constructor(
    readonly w: number,
    readonly h: number,
    bg: [number, number, number] = [0, 0, 0],
  ) {
    this.px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) this.px.set([bg[0], bg[1], bg[2], 255], i * 4);
    this.clip = [0, 0, w, h];
  }
  put(x: number, y: number, r: number, g: number, b: number): void {
    if (x < this.clip[0] || y < this.clip[1] || x >= this.clip[2] || y >= this.clip[3]) return;
    const o = (y * this.w + x) * 4;
    this.px[o] = r;
    this.px[o + 1] = g;
    this.px[o + 2] = b;
    this.px[o + 3] = 255;
  }
  /** 原版 0x454dd0（SPR）/ 0x4542b2（SMP）：左上 = (x − ax, y − ay)，透明像素跳过 */
  blit(lib: SpriteLib, frameIdx: number, x: number, y: number, recolor255?: [number, number, number]): void {
    const f = lib.frames[frameIdx];
    if (!f) throw new Error(`帧 ${frameIdx} 越界（共 ${lib.frames.length}）`);
    const x0 = x - f.ax;
    const y0 = y - f.ay;
    const d = lib.data;
    for (let yy = 0; yy < f.h; yy++) {
      for (let xx = 0; xx < f.w; xx++) {
        if (lib.sig === 'SPR') {
          const c = d[f.off + yy * f.w + xx]!;
          if (c === 0) continue;
          const pal = lib.palette!;
          if (c === 255 && recolor255) this.put(x0 + xx, y0 + yy, ...recolor255);
          else this.put(x0 + xx, y0 + yy, pal[c * 4]!, pal[c * 4 + 1]!, pal[c * 4 + 2]!);
        } else {
          const p = f.off + (yy * f.w + xx) * 2;
          const v = d[p]! | (d[p + 1]! << 8);
          if (v === 0) continue;
          const [r, g, b] = rgb555(v);
          this.put(x0 + xx, y0 + yy, r, g, b);
        }
      }
    }
  }
  /**
   * 把一个 32×32 图块贴到屏幕四边形（角序：纹理 (0,0)、(31,0)、(31,31)、(0,31)，与原版 0x453e01 一致）。
   * 自写实现：拆成两个三角形做仿射纹理映射（原版是按扫描线线性插值，四边形近似平行四边形时等价）。
   */
  texQuad(quad: [number, number][], tile: Uint8Array, tileOff: number, pal: Uint8Array): void {
    const uv: [number, number][] = [
      [0, 0],
      [31, 0],
      [31, 31],
      [0, 31],
    ];
    this.texTri([quad[0]!, quad[1]!, quad[2]!], [uv[0]!, uv[1]!, uv[2]!], tile, tileOff, pal);
    this.texTri([quad[0]!, quad[2]!, quad[3]!], [uv[0]!, uv[2]!, uv[3]!], tile, tileOff, pal);
  }
  private texTri(p: [number, number][], uv: [number, number][], tile: Uint8Array, off: number, pal: Uint8Array): void {
    const [a, b, c] = p as [[number, number], [number, number], [number, number]];
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (den === 0) return;
    const minX = Math.max(this.clip[0], Math.floor(Math.min(a[0], b[0], c[0])));
    const maxX = Math.min(this.clip[2] - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(this.clip[1], Math.floor(Math.min(a[1], b[1], c[1])));
    const maxY = Math.min(this.clip[3] - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / den;
        const l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / den;
        const l3 = 1 - l1 - l2;
        const eps = -1e-6;
        if (l1 < eps || l2 < eps || l3 < eps) continue;
        const u = l1 * uv[0]![0] + l2 * uv[1]![0] + l3 * uv[2]![0];
        const v = l1 * uv[0]![1] + l2 * uv[1]![1] + l3 * uv[2]![1];
        const ci = tile[off + Math.min(31, Math.max(0, Math.round(v))) * 32 + Math.min(31, Math.max(0, Math.round(u)))]!;
        this.put(x, y, pal[ci * 4]!, pal[ci * 4 + 1]!, pal[ci * 4 + 2]!);
      }
    }
  }
  dot(x: number, y: number, rad: number, col: [number, number, number]): void {
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) if (dx * dx + dy * dy <= rad * rad) this.put(Math.round(x) + dx, Math.round(y) + dy, ...col);
  }
  line(x0: number, y0: number, x1: number, y1: number, col: [number, number, number]): void {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= n; i++) this.put(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), ...col);
  }
  /** 最近邻缩小 */
  downscale(k: number): Canvas {
    const c = new Canvas(Math.floor(this.w / k), Math.floor(this.h / k));
    for (let y = 0; y < c.h; y++)
      for (let x = 0; x < c.w; x++) {
        const o = (y * k * this.w + x * k) * 4;
        c.px.set(this.px.subarray(o, o + 4), (y * c.w + x) * 4);
      }
    return c;
  }
  savePng(path: string): void {
    writeFileSync(path, encodePng(this.w, this.h, this.px));
  }
}

// ───────────── PNG ─────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export function encodePng(w: number, h: number, rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ───────────── 地图结构（gm*2+1） ─────────────
export interface MapNode {
  id: number;
  x: number;
  y: number;
  adj: number[];
  type: number;
  decor: number;
  flags: number;
}
export interface Placed {
  id: number;
  x: number;
  y: number;
  facing: number;
  sprite?: number;
  owner?: number;
  level?: number;
  kind?: number;
}
export interface MapData {
  nodes: MapNode[];
  lands: Placed[];
  facilities: Placed[];
  companies: Placed[];
  landscapes: Placed[];
}
export function parseMap(d: Uint8Array): MapData {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const h = Array.from({ length: 10 }, (_, i) => dv.getUint32(i * 4, true));
  const [nN, oN, nL, oL, nF, oF, nC, oC, nS, oS] = h as [number, number, number, number, number, number, number, number, number, number];
  const nodes: MapNode[] = [];
  for (let i = 1; i <= nN; i++) {
    const o = oN + i * 0x28;
    nodes.push({
      id: i,
      x: dv.getInt16(o, true),
      y: dv.getInt16(o + 2, true),
      adj: [0, 1, 2, 3].map((k) => dv.getUint16(o + 0x18 + 2 * k, true)),
      type: dv.getUint16(o + 0x20, true),
      decor: dv.getUint16(o + 0x22, true),
      flags: dv.getUint32(o + 0x24, true),
    });
  }
  const rows = (n: number, off: number, stride: number, f: (o: number, i: number) => Placed) =>
    Array.from({ length: n }, (_, k) => f(off + (k + 1) * stride, k + 1));
  return {
    nodes,
    lands: rows(nL, oL, 0x34, (o, i) => ({ id: i, x: dv.getInt16(o, true), y: dv.getInt16(o + 2, true), facing: d[o + 0x1b]!, owner: d[o + 0x19]!, level: d[o + 0x1a]! })),
    facilities: rows(nF, oF, 0x38, (o, i) => ({ id: i, x: dv.getInt16(o, true), y: dv.getInt16(o + 2, true), facing: d[o + 0x1b]!, kind: d[o + 0x18]!, owner: d[o + 0x19]!, level: d[o + 0x1a]! })),
    companies: rows(nC, oC, 0x34, (o, i) => ({ id: i, x: dv.getInt16(o, true), y: dv.getInt16(o + 2, true), facing: d[o + 0x1b]!, owner: d[o + 0x18]!, sprite: dv.getUint16(o + 0x20, true) })),
    landscapes: rows(nS, oS, 0x1c, (o, i) => ({ id: i, x: dv.getInt16(o, true), y: dv.getInt16(o + 2, true), facing: d[o + 0x18]!, sprite: dv.getUint16(o + 0x1a, true) })),
  };
}
