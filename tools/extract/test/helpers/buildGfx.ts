/** 测试专用：合成 SPR / SMP / GND / FLC / WAVE 资源（与原版无关）。 */

class Bytes {
  private parts: number[] = [];
  get length(): number {
    return this.parts.length;
  }
  u8(...v: number[]): this {
    for (const x of v) this.parts.push(x & 0xff);
    return this;
  }
  i8(v: number): this {
    return this.u8(v & 0xff);
  }
  u16(v: number): this {
    return this.u8(v, v >> 8);
  }
  i16(v: number): this {
    return this.u16(v & 0xffff);
  }
  u32(v: number): this {
    return this.u8(v, v >> 8, v >> 16, v >>> 24);
  }
  ascii(s: string): this {
    for (const c of s) this.parts.push(c.charCodeAt(0));
    return this;
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]! & 0xff);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export interface SheetFrameSpec {
  w: number;
  h: number;
  ax?: number;
  ay?: number;
  /** SPR：w·h 个索引；SMP：w·h 个 RGB555 值 */
  pixels: ArrayLike<number>;
}

function sheet(kind: 'SPR' | 'SMP', frames: readonly SheetFrameSpec[], palette: ArrayLike<number> | null): Uint8Array {
  const b = new Bytes()
    .ascii(`${kind}\0`)
    .u32(frames.length)
    .u32(12 + 12 * frames.length);
  const bpp = kind === 'SPR' ? 1 : 2;
  for (const f of frames)
    b.i16(f.w)
      .i16(f.h)
      .i16(f.ax ?? 0)
      .i16(f.ay ?? 0)
      .u32(f.w * f.h * bpp);
  if (kind === 'SPR') for (let i = 0; i < 256; i++) b.u16(palette?.[i] ?? 0);
  for (const f of frames) {
    for (let i = 0; i < f.w * f.h; i++) {
      if (kind === 'SPR') b.u8(f.pixels[i]!);
      else b.u16(f.pixels[i]!);
    }
  }
  return b.done();
}

export function buildSpr(frames: readonly SheetFrameSpec[], palette: ArrayLike<number>): Uint8Array {
  return sheet('SPR', frames, palette);
}

export function buildSmp(frames: readonly SheetFrameSpec[]): Uint8Array {
  return sheet('SMP', frames, null);
}

/** tiles[i] 为 1024 字节图块；layout 缺省为恒等 */
export function buildGnd(
  cols: number,
  rows: number,
  palette: ArrayLike<number>,
  tiles: readonly Uint8Array[],
  layout?: readonly number[],
): Uint8Array {
  const n = cols * rows;
  const b = new Bytes().ascii('GND\0').u16(cols).u16(rows).u32(n).u32(0);
  for (let i = 0; i < 256; i++) b.u16(palette[i] ?? 0);
  for (let i = 0; i < n; i++) b.u16(layout?.[i] ?? i);
  for (let i = 0; i < n; i++) b.bytes(tiles[i]!);
  return b.done();
}

// ───────────────────────── FLC ─────────────────────────

export interface FlcSub {
  type: number;
  data: Uint8Array;
  /** 覆盖写入的 size 字段（构造怪癖/损坏用） */
  sizeOverride?: number;
}

export interface FlcFrameSpec {
  subs: FlcSub[];
  delay?: number;
}

export interface FlcSpec {
  w: number;
  h: number;
  /** 文件头 frames；缺省 = frames.length − 1（最后一个是循环帧） */
  headerFrames?: number;
  speed?: number;
  prefix?: boolean;
  frames: FlcFrameSpec[];
  /** 覆盖文件头 size / magic / depth */
  sizeOverride?: number;
  magic?: number;
  depth?: number;
}

export function buildFlc(spec: FlcSpec): Uint8Array {
  const body = new Bytes();
  const offsets: number[] = [];
  if (spec.prefix) body.u32(16).u16(0xf100).u16(0).u32(0).u32(0);
  for (const f of spec.frames) {
    offsets.push(128 + body.length);
    const subs = f.subs.map((s) => {
      const size = 6 + s.data.length;
      return new Bytes()
        .u32(s.sizeOverride ?? size)
        .u16(s.type)
        .bytes(s.data)
        .done();
    });
    const total = 16 + subs.reduce((a, s) => a + s.length, 0);
    body
      .u32(total)
      .u16(0xf1fa)
      .u16(subs.length)
      .u16(f.delay ?? 0)
      .u16(0)
      .u16(0)
      .u16(0);
    for (const s of subs) body.bytes(s);
  }
  const payload = body.done();
  const size = 128 + payload.length;
  const head = new Bytes()
    .u32(spec.sizeOverride ?? size)
    .u16(spec.magic ?? 0xaf12)
    .u16(spec.headerFrames ?? spec.frames.length - 1)
    .u16(spec.w)
    .u16(spec.h)
    .u16(spec.depth ?? 8)
    .u16(0)
    .u32(spec.speed ?? 70);
  while (head.length < 80) head.u8(0);
  head.u32(offsets[0] ?? 0).u32(offsets[1] ?? 0);
  while (head.length < 128) head.u8(0);
  return new Bytes().bytes(head.done()).bytes(payload).done();
}

/** COLOR_256：一个包，从索引 start 起写 rgb.length/3 项 */
export function flcColor256(start: number, rgb: ArrayLike<number>, type = 4): FlcSub {
  const n = rgb.length / 3;
  return {
    type,
    data: new Bytes()
      .u16(1)
      .u8(start, n === 256 ? 0 : n)
      .bytes(rgb)
      .done(),
  };
}

/** BYTE_RUN：每行长度 ≥3 的相同字节用重复包，其余用字面包 */
export function flcByteRun(pixels: Uint8Array, w: number, h: number): FlcSub {
  const b = new Bytes();
  for (let y = 0; y < h; y++) {
    const row = pixels.subarray(y * w, (y + 1) * w);
    const packets = new Bytes();
    let count = 0;
    let x = 0;
    while (x < w) {
      let run = 1;
      while (x + run < w && run < 127 && row[x + run] === row[x]) run++;
      if (run >= 3) {
        packets.i8(run).u8(row[x]!);
        x += run;
      } else {
        let lit = 0;
        while (x + lit < w && lit < 128) {
          let r = 1;
          while (x + lit + r < w && r < 3 && row[x + lit + r] === row[x + lit]) r++;
          if (r >= 3) break;
          lit++;
        }
        if (lit === 0) lit = 1;
        packets.i8(-lit).bytes(row.subarray(x, x + lit));
        x += lit;
      }
      count++;
    }
    b.u8(Math.min(count, 255)).bytes(packets.done());
  }
  return { type: 15, data: b.done() };
}

/**
 * DELTA_FLC：逐行比较 prev→cur；没变的行用跳行操作字；变了的行从第一个变化像素对到最后一个像素对写字面词包；
 * 宽为奇数且最后一个像素变了时用 0x8000 操作字。要求 w ≤ 254。
 */
export function flcDeltaFlc(prev: Uint8Array, cur: Uint8Array, w: number, h: number): FlcSub {
  const b = new Bytes();
  let lines = 0;
  let skip = 0;
  const body = new Bytes();
  const even = w & ~1;
  for (let y = 0; y < h; y++) {
    const r0 = y * w;
    let first = -1;
    let last = -1;
    for (let x = 0; x < even; x++) {
      if (prev[r0 + x] !== cur[r0 + x]) {
        if (first < 0) first = x;
        last = x;
      }
    }
    const oddChanged = w % 2 === 1 && prev[r0 + w - 1] !== cur[r0 + w - 1];
    if (first < 0 && !oddChanged) {
      skip++;
      continue;
    }
    if (skip > 0) body.u16(0x10000 - skip);
    skip = 0;
    if (oddChanged) body.u16(0x8000 | cur[r0 + w - 1]!);
    if (first < 0) {
      body.u16(0);
    } else {
      const x0 = first & ~1;
      const words = ((last | 1) + 1 - x0) / 2;
      const packets: [number, number][] = [];
      for (let k = 0; k < words; k += 127) packets.push([k === 0 ? x0 : 0, Math.min(127, words - k)]);
      body.u16(packets.length);
      let x = x0;
      for (const [sk, n] of packets) {
        body
          .u8(sk)
          .i8(n)
          .bytes(cur.subarray(r0 + x, r0 + x + 2 * n));
        x += 2 * n;
      }
    }
    lines++;
  }
  b.u16(lines).bytes(body.done());
  return { type: 7, data: b.done() };
}

export function flcCopy(pixels: Uint8Array, sizeOverride?: number): FlcSub {
  return { type: 16, data: pixels, sizeOverride };
}

// ───────────────────────── WAVE ─────────────────────────

export interface WaveSpec {
  rate: number;
  channels?: number;
  bits?: number;
  samples: Uint8Array;
  /** 追加在 data 之后的块 */
  extra?: { id: string; data: Uint8Array }[];
  /** 在 fmt 之前插入的块 */
  before?: { id: string; data: Uint8Array }[];
  omitFmt?: boolean;
  riffSizeDelta?: number;
}

export function buildWave(spec: WaveSpec): Uint8Array {
  const ch = spec.channels ?? 1;
  const bits = spec.bits ?? 8;
  const align = ch * Math.ceil(bits / 8);
  const chunks = new Bytes();
  const put = (id: string, data: Uint8Array): void => {
    chunks.ascii(id).u32(data.length).bytes(data);
    if (data.length & 1) chunks.u8(0);
  };
  for (const c of spec.before ?? []) put(c.id, c.data);
  if (!spec.omitFmt) {
    put(
      'fmt ',
      new Bytes()
        .u16(1)
        .u16(ch)
        .u32(spec.rate)
        .u32(spec.rate * align)
        .u16(align)
        .u16(bits)
        .done(),
    );
  }
  put('data', spec.samples);
  for (const c of spec.extra ?? []) put(c.id, c.data);
  const body = chunks.done();
  return new Bytes()
    .ascii('RIFF')
    .u32(4 + body.length + (spec.riffSizeDelta ?? 0))
    .ascii('WAVE')
    .bytes(body)
    .done();
}
