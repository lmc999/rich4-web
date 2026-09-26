/** 测试专用：合成 MKF 容器（与原版无关）。 */
export interface MkfResourceSpec {
  /** 存储的资源体（压缩资源即压缩后的字节） */
  body: Uint8Array;
  /** 头部原始大小；默认 = body.length（未压缩） */
  rawSize?: number;
  imageOffset?: number;
  imageSize?: number;
  /** 资源体之后追加的空隙字节数 */
  gapAfter?: number;
}

export interface BuildMkfOptions {
  /** 索引表末尾追加哨兵（= indexTableOffset） */
  sentinel?: boolean;
}

export function buildMkf(resources: readonly MkfResourceSpec[], opts: BuildMkfOptions = {}): Uint8Array {
  const starts: number[] = [];
  let pos = 4;
  for (const r of resources) {
    starts.push(pos);
    pos += 16 + r.body.length + (r.gapAfter ?? 0);
  }
  const x = pos;
  const index = opts.sentinel ? [...starts, x] : starts;
  const out = new Uint8Array(x + index.length * 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, x, true);
  resources.forEach((r, i) => {
    const o = starts[i]!;
    dv.setUint32(o, r.rawSize ?? r.body.length, true);
    dv.setUint32(o + 4, r.body.length, true);
    dv.setUint32(o + 8, r.imageOffset ?? 0, true);
    dv.setUint32(o + 12, r.imageSize ?? 0, true);
    out.set(r.body, o + 16);
  });
  index.forEach((s, i) => {
    dv.setUint32(x + i * 4, s, true);
  });
  return out;
}

/** 读写合成字节里的 u32（用于构造损坏样例）。 */
export function setU32(bytes: Uint8Array, off: number, v: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(off, v, true);
}

export function getU32(bytes: Uint8Array, off: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(off, true);
}

export function ascii(s: string): Uint8Array {
  return Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
}
