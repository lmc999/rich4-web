// 测试专用：合成 FLC 编码器（自写，不含任何原版字节）。按帧指定子块编码方式，
// 生成与原版同构的 8 位 FLC（0xAF12），用于与解码器逐像素对拍：
// COLOR_256 / COLOR_64（只写变化的调色板区段）、BYTE_RUN、DELTA_FLC（含跳行、行尾奇像素、重复字包）、
// DELTA_FLI、FLI_COPY（可模拟原版 Panel#20 的 size 少写 2 的怪癖）、BLACK、PSTAMP、0xF100 前缀块、循环帧。
import { FLC_CHUNK, FLC_FRAME_TYPE, FLC_HEADER_BYTES, FLC_MAGIC, FLC_PREFIX_TYPE } from '../FlcDecoder';

export type FrameEncoding = 'byterun' | 'delta' | 'deltafli' | 'copy' | 'black';

export interface SynthFrame {
  /** W·H 个调色板索引 */
  pixels: Uint8Array;
  /** 256×3 调色板；与上一帧相同可省略 */
  palette?: Uint8Array;
  encoding: FrameEncoding;
  /** 用 COLOR_64（6 位分量）写调色板；分量须能由 6 位值扩展得到 */
  color64?: boolean;
  /** 附带一个 PSTAMP 子块（解码器应跳过） */
  pstamp?: boolean;
  /** 帧块 delay（ms，0 用文件头 speed） */
  delay?: number;
  /** COPY 子块声明的 size 比实际少 2（原版 Panel#20 怪癖） */
  copyQuirk?: boolean;
}

export interface SynthFlc {
  width: number;
  height: number;
  speed: number;
  frames: SynthFrame[];
  /** 追加回到首帧的循环帧（DELTA_FLC + 必要时调色板） */
  ring?: boolean;
  /** 在首帧前放一个 0xF100 前缀块 */
  prefix?: boolean;
}

class Bytes {
  private buf: number[] = [];

  get length(): number {
    return this.buf.length;
  }

  u8(v: number): this {
    this.buf.push(v & 0xff);
    return this;
  }

  i8(v: number): this {
    return this.u8(v < 0 ? 256 + v : v);
  }

  u16(v: number): this {
    return this.u8(v).u8(v >>> 8);
  }

  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }

  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.buf.push(b[i]! & 0xff);
    return this;
  }

  toArray(): number[] {
    return this.buf;
  }
}

function sub(type: number, body: number[], declaredSize?: number): number[] {
  const b = new Bytes();
  b.u32(declaredSize ?? body.length + 6).u16(type);
  return [...b.toArray(), ...body];
}

/** 调色板：只写与上一版不同的连续区段（多个包，测试 skip 与多包路径）；prev 为 null 时写全 256 色 */
function colorChunk(pal: Uint8Array, prev: Uint8Array | null, six: boolean): number[] | null {
  const runs: [number, number][] = [];
  let i = 0;
  while (i < 256) {
    const same =
      prev !== null &&
      pal[i * 3] === prev[i * 3] &&
      pal[i * 3 + 1] === prev[i * 3 + 1] &&
      pal[i * 3 + 2] === prev[i * 3 + 2];
    if (same) {
      i++;
      continue;
    }
    let j = i;
    while (j < 256) {
      const s2 =
        prev !== null &&
        pal[j * 3] === prev[j * 3] &&
        pal[j * 3 + 1] === prev[j * 3 + 1] &&
        pal[j * 3 + 2] === prev[j * 3 + 2];
      if (s2) break;
      j++;
    }
    runs.push([i, j - i]);
    i = j;
  }
  if (runs.length === 0) return null;
  const b = new Bytes();
  b.u16(runs.length);
  let at = 0;
  for (const [start, count] of runs) {
    b.u8(start - at).u8(count === 256 ? 0 : count);
    for (let c = start * 3; c < (start + count) * 3; c++) b.u8(six ? pal[c]! >> 2 : pal[c]!);
    at = start + count;
  }
  return sub(six ? FLC_CHUNK.COLOR_64 : FLC_CHUNK.COLOR_256, b.toArray());
}

/** BYTE_RUN：≥3 个相同字节用重复包，其余用字面包 */
function byteRun(px: Uint8Array, w: number, h: number): number[] {
  const b = new Bytes();
  for (let y = 0; y < h; y++) {
    const row = px.subarray(y * w, (y + 1) * w);
    const packets = new Bytes();
    let count = 0;
    let x = 0;
    while (x < w) {
      let r = 1;
      while (x + r < w && row[x + r] === row[x] && r < 127) r++;
      if (r >= 3) {
        packets.i8(r).u8(row[x]!);
        x += r;
      } else {
        let n = 0;
        while (x + n < w && n < 128) {
          let rr = 1;
          while (x + n + rr < w && row[x + n + rr] === row[x + n] && rr < 3) rr++;
          if (rr >= 3) break;
          n++;
        }
        if (n === 0) n = 1;
        packets.i8(-n).bytes(row.subarray(x, x + n));
        x += n;
      }
      count++;
    }
    b.u8(Math.min(255, count)).bytes(packets.toArray());
  }
  return sub(FLC_CHUNK.BYTE_RUN, b.toArray());
}

/** DELTA_FLC（按字）：跳过未变行（0xC000 操作字），奇数宽的行尾像素用 0x8000 操作字，连续相同字用重复包 */
function deltaFlc(px: Uint8Array, prev: Uint8Array, w: number, h: number): number[] {
  const b = new Bytes();
  const wordW = w & ~1;
  let lines = 0;
  let skip = 0;
  const body = new Bytes();
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let changed = false;
    for (let x = 0; x < w; x++) if (px[o + x] !== prev[o + x]) changed = true;
    if (!changed) {
      skip++;
      continue;
    }
    if (skip > 0) body.u16(0x10000 - skip);
    skip = 0;
    if (w !== wordW && px[o + w - 1] !== prev[o + w - 1]) body.u16(0x8000 | px[o + w - 1]!);
    // 变化的字区段（按字对齐）
    const packets = new Bytes();
    let np = 0;
    let x = 0;
    let cursor = 0;
    while (x < wordW) {
      if (px[o + x] === prev[o + x] && px[o + x + 1] === prev[o + x + 1]) {
        x += 2;
        continue;
      }
      let end = x;
      while (end < wordW && !(px[o + end] === prev[o + end] && px[o + end + 1] === prev[o + end + 1])) end += 2;
      // 跳过量超过 255 时先发 count=0 的空包
      let gap = x - cursor;
      while (gap > 255) {
        packets.u8(254).u8(0);
        np++;
        gap -= 254;
      }
      let first = true;
      let s = x;
      while (s < end) {
        const a = px[o + s]!;
        const c = px[o + s + 1]!;
        let rep = 1;
        while (s + rep * 2 < end && px[o + s + rep * 2] === a && px[o + s + rep * 2 + 1] === c && rep < 127) rep++;
        const skipByte = first ? gap : 0;
        first = false;
        if (rep >= 2) {
          packets.u8(skipByte).i8(-rep).u8(a).u8(c);
          s += rep * 2;
        } else {
          let n = 0;
          while (s + n * 2 < end && n < 127) {
            const a2 = px[o + s + n * 2];
            const c2 = px[o + s + n * 2 + 1];
            if (n > 0 && s + n * 2 + 2 < end && px[o + s + n * 2 + 2] === a2 && px[o + s + n * 2 + 3] === c2) break;
            n++;
          }
          packets
            .u8(skipByte)
            .i8(n)
            .bytes(px.subarray(o + s, o + s + n * 2));
          s += n * 2;
        }
        np++;
      }
      cursor = end;
      x = end;
    }
    body.u16(np).bytes(packets.toArray());
    lines++;
  }
  b.u16(lines).bytes(body.toArray());
  return sub(FLC_CHUNK.DELTA_FLC, b.toArray());
}

/** DELTA_FLI（按字节）：从首个变化行到末个变化行，逐行写变化区段 */
function deltaFli(px: Uint8Array, prev: Uint8Array, w: number, h: number): number[] {
  let first = -1;
  let last = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[y * w + x] !== prev[y * w + x]) {
        if (first < 0) first = y;
        last = y;
        break;
      }
    }
  }
  const b = new Bytes();
  if (first < 0) {
    b.u16(0).u16(0);
    return sub(FLC_CHUNK.DELTA_FLI, b.toArray());
  }
  b.u16(first).u16(last - first + 1);
  for (let y = first; y <= last; y++) {
    const o = y * w;
    const packets = new Bytes();
    let np = 0;
    let cursor = 0;
    let x = 0;
    while (x < w) {
      if (px[o + x] === prev[o + x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < w && px[o + end] !== prev[o + end] && end - x < 120) end++;
      const run = px.subarray(o + x, o + end);
      const allSame = run.every((v) => v === run[0]);
      let gap = x - cursor;
      while (gap > 255) {
        packets.u8(255).u8(0);
        np++;
        gap -= 255;
      }
      if (allSame && run.length >= 2) packets.u8(gap).i8(-run.length).u8(run[0]!);
      else packets.u8(gap).i8(run.length).bytes(run);
      np++;
      cursor = end;
      x = end;
    }
    b.u8(np).bytes(packets.toArray());
  }
  return sub(FLC_CHUNK.DELTA_FLI, b.toArray());
}

function frameChunk(subs: number[][], delay: number): number[] {
  const body = subs.flat();
  const b = new Bytes();
  b.u32(16 + body.length)
    .u16(FLC_FRAME_TYPE)
    .u16(subs.length)
    .u16(delay)
    .u16(0)
    .u16(0)
    .u16(0);
  return [...b.toArray(), ...body];
}

function encodeFrame(
  f: SynthFrame,
  prevPx: Uint8Array,
  prevPal: Uint8Array | null,
  pal: Uint8Array,
  w: number,
  h: number,
): number[] {
  const subs: number[][] = [];
  const c = colorChunk(pal, prevPal, f.color64 === true);
  if (c) subs.push(c);
  switch (f.encoding) {
    case 'byterun':
      subs.push(byteRun(f.pixels, w, h));
      break;
    case 'delta':
      subs.push(deltaFlc(f.pixels, prevPx, w, h));
      break;
    case 'deltafli':
      subs.push(deltaFli(f.pixels, prevPx, w, h));
      break;
    case 'copy': {
      const declared = f.copyQuirk ? 6 + w * h - 2 : undefined;
      subs.push(sub(FLC_CHUNK.FLI_COPY, Array.from(f.pixels), declared));
      break;
    }
    case 'black':
      subs.push(sub(FLC_CHUNK.BLACK, []));
      break;
  }
  if (f.pstamp) subs.push(sub(FLC_CHUNK.PSTAMP, [7, 0, 7, 0, 1, 2, 3, 4]));
  return frameChunk(subs, f.delay ?? 0);
}

/** 编码为完整 FLC 文件 */
export function buildFlc(spec: SynthFlc): Uint8Array {
  const { width: w, height: h } = spec;
  const out: number[] = new Array(FLC_HEADER_BYTES).fill(0);
  const chunks: number[][] = [];
  if (spec.prefix) {
    const b = new Bytes();
    b.u32(16).u16(FLC_PREFIX_TYPE).u16(1).u32(0).u32(0);
    chunks.push(b.toArray());
  }
  let prevPx: Uint8Array = new Uint8Array(w * h);
  let prevPal: Uint8Array | null = null;
  let pal: Uint8Array = new Uint8Array(768);
  const firstFrameChunk = chunks.length;
  for (const f of spec.frames) {
    if (f.pixels.length !== w * h) throw new Error('帧像素数与尺寸不符');
    if (f.palette) pal = f.palette;
    chunks.push(encodeFrame(f, prevPx, prevPal, pal, w, h));
    prevPal = pal;
    prevPx = f.encoding === 'black' ? new Uint8Array(w * h) : f.pixels;
  }
  if (spec.ring && spec.frames.length > 0) {
    const f0 = spec.frames[0]!;
    const px0 = f0.encoding === 'black' ? new Uint8Array(w * h) : f0.pixels;
    const pal0 = spec.frames.find((f) => f.palette)?.palette ?? new Uint8Array(768);
    chunks.push(encodeFrame({ pixels: px0, encoding: 'delta' }, prevPx, prevPal, pal0, w, h));
  }
  let offset = FLC_HEADER_BYTES;
  const offsets: number[] = [];
  for (const c of chunks) {
    offsets.push(offset);
    offset += c.length;
  }
  const hdr = new Bytes();
  hdr.u32(offset).u16(FLC_MAGIC).u16(spec.frames.length).u16(w).u16(h).u16(8).u16(3).u32(spec.speed);
  const hb = hdr.toArray();
  for (let i = 0; i < hb.length; i++) out[i] = hb[i]!;
  const o1 = offsets[firstFrameChunk] ?? 0;
  const o2 = offsets[firstFrameChunk + 1] ?? 0;
  const setU32 = (at: number, v: number): void => {
    out[at] = v & 0xff;
    out[at + 1] = (v >>> 8) & 0xff;
    out[at + 2] = (v >>> 16) & 0xff;
    out[at + 3] = (v >>> 24) & 0xff;
  };
  setU32(80, o1);
  setU32(84, o2);
  for (const c of chunks) for (const v of c) out.push(v);
  return Uint8Array.from(out);
}

/** 确定性伪随机（LCG），测试生成像素用 */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 8;
  };
}

/** 6 位分量可精确往返的调色板（COLOR_64 用）：v = (x << 2) | (x >> 4) */
export function palette64(seed: number): Uint8Array {
  const r = lcg(seed);
  const p = new Uint8Array(768);
  for (let i = 0; i < 768; i++) {
    const x = r() & 63;
    p[i] = (x << 2) | (x >> 4);
  }
  return p;
}

export function randomPalette(seed: number): Uint8Array {
  const r = lcg(seed);
  const p = new Uint8Array(768);
  for (let i = 0; i < 768; i++) p[i] = r() & 255;
  return p;
}
