// 浏览器端 FLC 解码器（原版皮肤 A5；docs/design/original-skin.md §5 A5、design-draft §3.1、§3.5）。
// 自写实现，不依赖 tools/extract（apps 不得依赖 extract）；格式要点与素材管线一致（sprites.md §8、containers.md §5）：
// - 128 字节文件头：u32 size、u16 magic 0xAF12、u16 frames、u16 w、u16 h、u16 depth(8)、u16 flags、u32 speed(ms)；
// - 顶层块：0xF100 前缀块（跳过）与 0xF1FA 帧块；帧块数 = frames 或 frames + 1（末块是回到首帧的循环帧）；
// - 帧块头 16 字节：u32 size、u16 0xF1FA、u16 子块数、u16 delay、u16 保留、u16 w、u16 h；
// - 子块：4 COLOR_256、7 DELTA_FLC、11 COLOR_64、12 DELTA_FLI、13 BLACK、15 BYTE_RUN、16 FLI_COPY、18 PSTAMP（跳过）；
// - 怪癖：原版 Panel#20 末帧的 COPY 子块把 size 写成 307204（应为 6 + W·H）。COPY 数据按 W·H 读取，
//   子块按 max(声明值, 6 + W·H) 前进，帧按帧块大小前进；解析时记一条告警。
// 解码器是有状态的：pixels（W·H 索引）与 palette（256×3）是内部缓冲，每次 next() 原地更新，
// 调用方用 toRgba() 把当前帧写进一块可复用的 RGBA 缓冲（索引 0 透明，opaque 条目例外）。

export const FLC_MAGIC = 0xaf12;
export const FLC_HEADER_BYTES = 128;
export const FLC_FRAME_TYPE = 0xf1fa;
export const FLC_PREFIX_TYPE = 0xf100;
const FRAME_HEADER_BYTES = 16;
const SUB_HEADER_BYTES = 6;

export const FLC_CHUNK = {
  COLOR_256: 4,
  DELTA_FLC: 7,
  COLOR_64: 11,
  DELTA_FLI: 12,
  BLACK: 13,
  BYTE_RUN: 15,
  FLI_COPY: 16,
  PSTAMP: 18,
} as const;

const KNOWN: ReadonlySet<number> = new Set<number>(Object.values(FLC_CHUNK));
/** 整字写入 RGBA 的快速路径只在小端平台上成立（浏览器与常见 Node 平台都是小端） */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export class FlcError extends Error {
  override name = 'FlcError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface FlcSub {
  type: number;
  /** 数据区 [data, end) */
  data: number;
  end: number;
}

export interface FlcFrameChunk {
  index: number;
  offset: number;
  size: number;
  /** 帧块里的 delay（ms，0 表示用文件头 speed） */
  delay: number;
  subs: FlcSub[];
}

export interface FlcFile {
  data: Uint8Array;
  width: number;
  height: number;
  /** 文件头声明的帧数（不含循环帧） */
  frames: number;
  /** 帧间隔（ms） */
  speed: number;
  /** 全部帧块（含循环帧） */
  chunks: FlcFrameChunk[];
  hasRingFrame: boolean;
  warnings: string[];
}

const u16 = (d: Uint8Array, o: number): number => d[o]! | (d[o + 1]! << 8);
const u32 = (d: Uint8Array, o: number): number =>
  (d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24)) >>> 0;

function toBytes(src: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (src instanceof Uint8Array) return src;
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  return new Uint8Array(src);
}

/** 解析文件头与块链（不解码像素）；结构不对时抛 FlcError */
export function parseFlc(src: ArrayBuffer | ArrayBufferView, label = 'FLC'): FlcFile {
  const d = toBytes(src);
  if (d.length < FLC_HEADER_BYTES) throw new FlcError('E_FLC_TRUNCATED', `${label}: 只有 ${d.length} 字节`);
  const magic = u16(d, 4);
  if (magic !== FLC_MAGIC) throw new FlcError('E_FLC_MAGIC', `${label}: magic=0x${magic.toString(16)}，只支持 0xAF12`);
  const declared = u32(d, 0);
  if (declared !== d.length) throw new FlcError('E_FLC_SIZE', `${label}: 头部 size=${declared} ≠ ${d.length}`);
  const frames = u16(d, 6);
  const width = u16(d, 8);
  const height = u16(d, 10);
  const depth = u16(d, 12);
  if (depth !== 8) throw new FlcError('E_FLC_DEPTH', `${label}: depth=${depth}，只支持 8 位`);
  if (width === 0 || height === 0) throw new FlcError('E_FLC_HEADER', `${label}: 尺寸 ${width}×${height}`);
  const flc: FlcFile = {
    data: d,
    width,
    height,
    frames,
    speed: u32(d, 16),
    chunks: [],
    hasRingFrame: false,
    warnings: [],
  };
  const copyBytes = width * height;
  let p = FLC_HEADER_BYTES;
  while (p < d.length) {
    if (p + SUB_HEADER_BYTES > d.length) throw new FlcError('E_FLC_CHAIN', `${label}: 块头越过文件尾（${p}）`);
    const size = u32(d, p);
    const type = u16(d, p + 4);
    if (size < SUB_HEADER_BYTES || p + size > d.length) {
      throw new FlcError('E_FLC_CHAIN', `${label}: 偏移 ${p} 的块大小 ${size} 非法`);
    }
    if (type === FLC_FRAME_TYPE) {
      if (size < FRAME_HEADER_BYTES) throw new FlcError('E_FLC_CHAIN', `${label}: 帧块 ${p} 只有 ${size} 字节`);
      const index = flc.chunks.length;
      const frameEnd = p + size;
      const nsub = u16(d, p + 6);
      const subs: FlcSub[] = [];
      let q = p + FRAME_HEADER_BYTES;
      for (let s = 0; s < nsub; s++) {
        if (q + SUB_HEADER_BYTES > frameEnd)
          throw new FlcError('E_FLC_SUBCHUNK', `${label}: 帧 ${index} 子块 ${s} 越界`);
        const ssize = u32(d, q);
        const stype = u16(d, q + 4);
        if (!KNOWN.has(stype)) throw new FlcError('E_FLC_SUBCHUNK', `${label}: 帧 ${index} 子块类型 ${stype} 未知`);
        let end = q + ssize;
        let advance = ssize;
        if (stype === FLC_CHUNK.FLI_COPY && ssize !== SUB_HEADER_BYTES + copyBytes) {
          flc.warnings.push(`W_FLC_COPY_SIZE: 帧 ${index} COPY size=${ssize}，按 W·H=${copyBytes} 读取`);
          end = q + SUB_HEADER_BYTES + copyBytes;
          advance = Math.max(ssize, SUB_HEADER_BYTES + copyBytes);
        }
        if (ssize < SUB_HEADER_BYTES || end > frameEnd || q + advance > frameEnd) {
          throw new FlcError('E_FLC_SUBCHUNK', `${label}: 帧 ${index} 子块 ${s}（类型 ${stype}）越过帧块`);
        }
        subs.push({ type: stype, data: q + SUB_HEADER_BYTES, end });
        q += advance;
      }
      flc.chunks.push({ index, offset: p, size, delay: u16(d, p + 8), subs });
    } else if (type !== FLC_PREFIX_TYPE) {
      throw new FlcError('E_FLC_CHUNK', `${label}: 偏移 ${p} 的顶层块类型 0x${type.toString(16)} 未知`);
    }
    p += size;
  }
  const n = flc.chunks.length;
  if (n !== frames && n !== frames + 1) {
    throw new FlcError('E_FLC_FRAME_COUNT', `${label}: 帧块 ${n} 个，文件头 frames=${frames}`);
  }
  flc.hasRingFrame = n === frames + 1;
  return flc;
}

/** 帧 i 的间隔（ms）：帧块 delay 非 0 时优先，否则用文件头 speed；都为 0 时按 1ms */
export function flcFrameDelay(flc: FlcFile, i: number): number {
  const c = flc.chunks[i];
  const ms = c && c.delay !== 0 ? c.delay : flc.speed;
  return ms > 0 ? ms : 1;
}

/** 有状态的逐帧解码器 */
export class FlcDecoder {
  readonly pixels: Uint8Array;
  readonly palette: Uint8Array;
  private cursor = 0;
  private readonly lut = new Uint32Array(256);
  private lutDirty = true;

  constructor(readonly flc: FlcFile) {
    this.pixels = new Uint8Array(flc.width * flc.height);
    this.palette = new Uint8Array(256 * 3);
  }

  /** 下一个将要解码的帧块序号 */
  get position(): number {
    return this.cursor;
  }

  /** 已解码到最后一个帧块（含循环帧） */
  get done(): boolean {
    return this.cursor >= this.flc.chunks.length;
  }

  /** 回到开头（像素与调色板清零） */
  rewind(): void {
    this.cursor = 0;
    this.pixels.fill(0);
    this.palette.fill(0);
    this.lutDirty = true;
  }

  /** 解码下一个帧块（含循环帧），返回其序号 */
  next(): number {
    const c = this.flc.chunks[this.cursor];
    if (!c) throw new FlcError('E_FLC_EOF', `已没有帧块（共 ${this.flc.chunks.length}）`);
    for (const s of c.subs) this.apply(s, c.index);
    this.cursor++;
    return c.index;
  }

  /** 解码到帧 frame（0 基，帧块序号）为止：必要时从头重解；返回后 pixels 即为该帧 */
  seek(frame: number): void {
    const target = Math.max(0, Math.min(frame, this.flc.chunks.length - 1));
    if (this.cursor > target + 1) this.rewind();
    while (this.cursor <= target) this.next();
  }

  /**
   * 把当前帧写进 RGBA 缓冲（长度 W·H·4，可复用）：opaque=false 时索引 0 透明（alpha 0、RGB 0），
   * 其余像素 alpha 255。按小端序整字写入。
   */
  toRgba(out: Uint8ClampedArray | Uint8Array, opaque = false): void {
    const n = this.pixels.length;
    if (out.length < n * 4) throw new RangeError(`RGBA 缓冲只有 ${out.length} 字节，需要 ${n * 4}`);
    if (this.lutDirty) this.rebuildLut();
    const lut = this.lut;
    const px = this.pixels;
    if (LITTLE_ENDIAN && out.byteOffset % 4 === 0) {
      const o32 = new Uint32Array(out.buffer, out.byteOffset, n);
      if (opaque) {
        for (let i = 0; i < n; i++) o32[i] = lut[px[i]!]!;
      } else {
        for (let i = 0; i < n; i++) {
          const v = px[i]!;
          o32[i] = v === 0 ? 0 : lut[v]!;
        }
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      const v = px[i]!;
      const j = i * 4;
      if (v === 0 && !opaque) {
        out[j] = 0;
        out[j + 1] = 0;
        out[j + 2] = 0;
        out[j + 3] = 0;
      } else {
        out[j] = this.palette[v * 3]!;
        out[j + 1] = this.palette[v * 3 + 1]!;
        out[j + 2] = this.palette[v * 3 + 2]!;
        out[j + 3] = 255;
      }
    }
  }

  /** 小端 RGBA 打包（与 Uint32Array 视图写入字节序一致） */
  private rebuildLut(): void {
    const pal = this.palette;
    for (let i = 0; i < 256; i++) {
      this.lut[i] = (pal[i * 3]! | (pal[i * 3 + 1]! << 8) | (pal[i * 3 + 2]! << 16) | (255 << 24)) >>> 0;
    }
    this.lutDirty = false;
  }

  private fail(frame: number, s: FlcSub, what: string): FlcError {
    return new FlcError('E_FLC_DECODE', `帧 ${frame} 子块 ${s.type}@${s.data - SUB_HEADER_BYTES}：${what}`);
  }

  private apply(s: FlcSub, frame: number): void {
    const d = this.flc.data;
    const w = this.flc.width;
    const h = this.flc.height;
    const px = this.pixels;
    const end = s.end;
    let p = s.data;
    const need = (n: number): void => {
      if (p + n > end) throw this.fail(frame, s, `读取越过子块末尾（${p}+${n} > ${end}）`);
    };
    switch (s.type) {
      case FLC_CHUNK.COLOR_256:
      case FLC_CHUNK.COLOR_64: {
        need(2);
        const packets = u16(d, p);
        p += 2;
        let idx = 0;
        for (let k = 0; k < packets; k++) {
          need(2);
          idx += d[p]!;
          let cnt = d[p + 1]!;
          p += 2;
          if (cnt === 0) cnt = 256;
          if (idx + cnt > 256) throw this.fail(frame, s, `调色板索引越界 ${idx}+${cnt}`);
          need(cnt * 3);
          for (let c = 0; c < cnt * 3; c++) {
            const v = d[p++]!;
            this.palette[idx * 3 + c] = s.type === FLC_CHUNK.COLOR_64 ? ((v << 2) | (v >> 4)) & 0xff : v;
          }
          idx += cnt;
        }
        this.lutDirty = true;
        return;
      }
      case FLC_CHUNK.BYTE_RUN: {
        for (let y = 0; y < h; y++) {
          need(1);
          p++; // 旧式包数：FLC 忽略，按行宽解到填满为止
          let x = 0;
          const row = y * w;
          while (x < w) {
            need(1);
            const cnt = (d[p++]! << 24) >> 24;
            if (cnt > 0) {
              need(1);
              if (x + cnt > w) throw this.fail(frame, s, `BYTE_RUN 行 ${y} 越过行宽`);
              px.fill(d[p++]!, row + x, row + x + cnt);
              x += cnt;
            } else if (cnt < 0) {
              const n = -cnt;
              need(n);
              if (x + n > w) throw this.fail(frame, s, `BYTE_RUN 行 ${y} 越过行宽`);
              px.set(d.subarray(p, p + n), row + x);
              p += n;
              x += n;
            } else {
              throw this.fail(frame, s, `BYTE_RUN 行 ${y} 出现 0 长度包`);
            }
          }
        }
        return;
      }
      case FLC_CHUNK.DELTA_FLC: {
        need(2);
        let lines = u16(d, p);
        p += 2;
        let y = 0;
        while (lines > 0) {
          let lastPixel = -1;
          let packets = -1;
          while (packets < 0) {
            need(2);
            const op = u16(d, p);
            p += 2;
            const tag = op & 0xc000;
            if (tag === 0xc000) y += 0x10000 - op;
            else if (tag === 0x8000) lastPixel = op & 0xff;
            else if (tag === 0) packets = op;
            else throw this.fail(frame, s, `DELTA_FLC 未定义的操作字 0x${op.toString(16)}`);
          }
          if (y >= h) throw this.fail(frame, s, `DELTA_FLC 行 ${y} 越界`);
          const row = y * w;
          let x = 0;
          for (let k = 0; k < packets; k++) {
            need(2);
            x += d[p]!;
            const cnt = (d[p + 1]! << 24) >> 24;
            p += 2;
            if (cnt > 0) {
              const n = cnt * 2;
              need(n);
              if (x + n > w) throw this.fail(frame, s, `DELTA_FLC 行 ${y} 越过行宽`);
              px.set(d.subarray(p, p + n), row + x);
              p += n;
              x += n;
            } else if (cnt < 0) {
              need(2);
              const a = d[p]!;
              const b = d[p + 1]!;
              p += 2;
              if (x - 2 * cnt > w) throw this.fail(frame, s, `DELTA_FLC 行 ${y} 越过行宽`);
              for (let r = 0; r < -cnt; r++) {
                px[row + x++] = a;
                px[row + x++] = b;
              }
            }
          }
          if (lastPixel >= 0) px[row + w - 1] = lastPixel;
          y++;
          lines--;
        }
        return;
      }
      case FLC_CHUNK.DELTA_FLI: {
        need(4);
        let y = u16(d, p);
        const lines = u16(d, p + 2);
        p += 4;
        for (let l = 0; l < lines; l++, y++) {
          if (y >= h) throw this.fail(frame, s, `DELTA_FLI 行 ${y} 越界`);
          const row = y * w;
          need(1);
          const packets = d[p++]!;
          let x = 0;
          for (let k = 0; k < packets; k++) {
            need(2);
            x += d[p]!;
            const cnt = (d[p + 1]! << 24) >> 24;
            p += 2;
            if (cnt > 0) {
              need(cnt);
              if (x + cnt > w) throw this.fail(frame, s, `DELTA_FLI 行 ${y} 越过行宽`);
              px.set(d.subarray(p, p + cnt), row + x);
              p += cnt;
              x += cnt;
            } else if (cnt < 0) {
              need(1);
              if (x - cnt > w) throw this.fail(frame, s, `DELTA_FLI 行 ${y} 越过行宽`);
              px.fill(d[p++]!, row + x, row + x - cnt);
              x -= cnt;
            }
          }
        }
        return;
      }
      case FLC_CHUNK.BLACK:
        px.fill(0);
        return;
      case FLC_CHUNK.FLI_COPY:
        need(w * h);
        px.set(d.subarray(p, p + w * h));
        return;
      case FLC_CHUNK.PSTAMP:
        return;
      default:
        throw this.fail(frame, s, '未知子块类型');
    }
  }
}
