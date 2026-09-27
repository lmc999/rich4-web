/**
 * FLC（Autodesk Animator Pro，8 位调色板）解析与逐帧解码：只用于素材管线的元数据、预览与校验，
 * 浏览器端播放器另写（A5）。移植自 test/sprite-proto.ts 的 flicInfo/decodeFlic/applyFlicChunk 与
 * test/ui-lib.mjs 的 decodeFlc（均为本项目调研原型）；规格：sprites.md §8、containers.md §5。
 *
 * - 128 字节文件头：u32 size（== 资源长度）、u16 magic 0xAF12、u16 frames、u16 w、u16 h、u16 depth(8)、
 *   u16 flags、u32 speed（毫秒）、…、u32 oframe1@80、u32 oframe2@84。
 * - 顶层块：0xF100 前缀块（跳过）、0xF1FA 帧块；帧块数 = frames + 1（末帧是回到首帧的循环帧）。
 * - 帧块头 16 字节：u32 size、u16 0xF1FA、u16 子块数、u16 delay、u16 保留、u16 w、u16 h。
 * - 子块：4 COLOR_256、7 DELTA_FLC、11 COLOR_64、12 DELTA_FLI、13 BLACK、15 BYTE_RUN、16 FLI_COPY、18 PSTAMP（跳过）。
 * - 怪癖：Panel#20 末帧的 COPY 子块 size 写成 307204（应为 6+W·H=307206）。COPY 数据按 W·H 读取，
 *   子块按 max(声明值, 6+W·H) 前进，帧按帧块大小前进；记录告警 W_FLC_COPY_SIZE。
 * - 透明（由资源目录决定）：索引 0 透明，Panel#16、Panel#20、jump#42 三段例外（不透明）。
 */
import { GfxError, type RgbaImage } from './errors';

export const FLC_MAGIC = 0xaf12;
export const FLC_HEADER_BYTES = 128;
export const FLC_FRAME_TYPE = 0xf1fa;
export const FLC_PREFIX_TYPE = 0xf100;
export const FLC_FRAME_HEADER_BYTES = 16;
export const FLC_SUBCHUNK_HEADER_BYTES = 6;

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

const KNOWN_SUBCHUNKS: ReadonlySet<number> = new Set(Object.values(FLC_CHUNK));

export interface FlcWarning {
  code: string;
  frame: number | null;
  detail: string;
}

export interface FlcSubChunk {
  type: number;
  /** 子块头的绝对偏移 */
  offset: number;
  /** 声明的大小（含 6 字节头） */
  size: number;
  /** 数据区 [dataOffset, dataEnd) */
  dataOffset: number;
  dataEnd: number;
}

export interface FlcFrameChunk {
  /** 帧块序号；等于 FlcFile.frames 的那一块是循环帧 */
  index: number;
  offset: number;
  size: number;
  /** 帧块头里的 delay（毫秒，0 表示用文件头的 speed） */
  delay: number;
  subchunks: FlcSubChunk[];
}

export interface FlcFile {
  label: string;
  data: Uint8Array;
  size: number;
  /** 文件头声明的帧数（不含循环帧） */
  frames: number;
  width: number;
  height: number;
  depth: number;
  flags: number;
  /** 帧间隔（毫秒） */
  speed: number;
  oframe1: number;
  oframe2: number;
  prefixChunks: { offset: number; size: number }[];
  /** 全部帧块（含循环帧） */
  frameChunks: FlcFrameChunk[];
  hasRingFrame: boolean;
  /** 各子块类型出现次数（键为十进制类型号） */
  subchunkCounts: Record<string, number>;
  warnings: FlcWarning[];
}

const u16 = (d: Uint8Array, o: number): number => d[o]! | (d[o + 1]! << 8);
const u32 = (d: Uint8Array, o: number): number =>
  (d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24)) >>> 0;

export function parseFlc(data: Uint8Array, label = 'FLC'): FlcFile {
  if (data.length < FLC_HEADER_BYTES) throw new GfxError('E_FLC_TRUNCATED', `${label}: 只有 ${data.length} 字节`);
  const magic = u16(data, 4);
  if (magic !== FLC_MAGIC) {
    throw new GfxError('E_FLC_MAGIC', `${label}: magic=0x${magic.toString(16)}，只支持 0xAF12（8 位 FLC）`);
  }
  const size = u32(data, 0);
  if (size !== data.length) throw new GfxError('E_FLC_SIZE', `${label}: 头部 size=${size} ≠ 资源长度 ${data.length}`);
  const frames = u16(data, 6);
  const width = u16(data, 8);
  const height = u16(data, 10);
  const depth = u16(data, 12);
  if (depth !== 8) throw new GfxError('E_FLC_DEPTH', `${label}: depth=${depth}，只支持 8 位`);
  if (width === 0 || height === 0) throw new GfxError('E_FLC_HEADER', `${label}: 尺寸 ${width}×${height}`);
  const flc: FlcFile = {
    label,
    data,
    size,
    frames,
    width,
    height,
    depth,
    flags: u16(data, 14),
    speed: u32(data, 16),
    oframe1: u32(data, 80),
    oframe2: u32(data, 84),
    prefixChunks: [],
    frameChunks: [],
    hasRingFrame: false,
    subchunkCounts: {},
    warnings: [],
  };
  const copyBytes = width * height;
  let p = FLC_HEADER_BYTES;
  while (p < data.length) {
    if (p + FLC_SUBCHUNK_HEADER_BYTES > data.length) {
      throw new GfxError('E_FLC_CHAIN', `${label}: 块头越过文件尾（偏移 ${p}）`);
    }
    const csize = u32(data, p);
    const ctype = u16(data, p + 4);
    if (csize < FLC_SUBCHUNK_HEADER_BYTES || p + csize > data.length) {
      throw new GfxError('E_FLC_CHAIN', `${label}: 偏移 ${p} 的块大小 ${csize} 非法（文件 ${data.length} 字节）`);
    }
    if (ctype === FLC_PREFIX_TYPE) {
      flc.prefixChunks.push({ offset: p, size: csize });
    } else if (ctype === FLC_FRAME_TYPE) {
      if (csize < FLC_FRAME_HEADER_BYTES) throw new GfxError('E_FLC_CHAIN', `${label}: 帧块 ${p} 只有 ${csize} 字节`);
      const index = flc.frameChunks.length;
      const frameEnd = p + csize;
      const nsub = u16(data, p + 6);
      const subchunks: FlcSubChunk[] = [];
      let q = p + FLC_FRAME_HEADER_BYTES;
      for (let s = 0; s < nsub; s++) {
        if (q + FLC_SUBCHUNK_HEADER_BYTES > frameEnd) {
          throw new GfxError('E_FLC_SUBCHUNK', `${label}: 帧 ${index} 子块 ${s} 头越过帧块末尾`);
        }
        const ssize = u32(data, q);
        const stype = u16(data, q + 4);
        if (!KNOWN_SUBCHUNKS.has(stype)) {
          throw new GfxError('E_FLC_SUBCHUNK', `${label}: 帧 ${index} 子块 ${s} 类型 ${stype} 未知`);
        }
        let advance = ssize;
        let dataEnd = q + ssize;
        if (stype === FLC_CHUNK.FLI_COPY && ssize !== FLC_SUBCHUNK_HEADER_BYTES + copyBytes) {
          flc.warnings.push({
            code: 'W_FLC_COPY_SIZE',
            frame: index,
            detail: `COPY 子块 size=${ssize}，按 W·H=${copyBytes} 读取`,
          });
          dataEnd = q + FLC_SUBCHUNK_HEADER_BYTES + copyBytes;
          advance = Math.max(ssize, FLC_SUBCHUNK_HEADER_BYTES + copyBytes);
        }
        if (ssize < FLC_SUBCHUNK_HEADER_BYTES || dataEnd > frameEnd || q + advance > frameEnd) {
          throw new GfxError(
            'E_FLC_SUBCHUNK',
            `${label}: 帧 ${index} 子块 ${s}（类型 ${stype}）大小 ${ssize} 越过帧块`,
          );
        }
        subchunks.push({ type: stype, offset: q, size: ssize, dataOffset: q + FLC_SUBCHUNK_HEADER_BYTES, dataEnd });
        flc.subchunkCounts[String(stype)] = (flc.subchunkCounts[String(stype)] ?? 0) + 1;
        q += advance;
      }
      flc.frameChunks.push({ index, offset: p, size: csize, delay: u16(data, p + 8), subchunks });
    } else {
      throw new GfxError('E_FLC_CHUNK', `${label}: 偏移 ${p} 的顶层块类型 0x${ctype.toString(16)} 未知`);
    }
    p += csize;
  }
  const n = flc.frameChunks.length;
  if (n !== frames && n !== frames + 1) {
    throw new GfxError('E_FLC_FRAME_COUNT', `${label}: 帧块 ${n} 个，文件头 frames=${frames}`);
  }
  flc.hasRingFrame = n === frames + 1;
  if (n > 0 && flc.oframe1 !== 0 && flc.oframe1 !== flc.frameChunks[0]!.offset) {
    flc.warnings.push({
      code: 'W_FLC_OFRAME1',
      frame: 0,
      detail: `oframe1=${flc.oframe1}，首帧块在 ${flc.frameChunks[0]!.offset}`,
    });
  }
  if (n > 1 && flc.oframe2 !== 0 && flc.oframe2 !== flc.frameChunks[1]!.offset) {
    flc.warnings.push({
      code: 'W_FLC_OFRAME2',
      frame: 1,
      detail: `oframe2=${flc.oframe2}，第二帧块在 ${flc.frameChunks[1]!.offset}`,
    });
  }
  return flc;
}

/** 帧 i 的实际间隔（毫秒）：帧块 delay 非 0 时优先，否则用文件头 speed */
export function flcFrameDelay(flc: FlcFile, i: number): number {
  const f = flc.frameChunks[i];
  return f && f.delay !== 0 ? f.delay : flc.speed;
}

// ───────────────────────── 逐帧解码 ─────────────────────────

/**
 * 有状态的逐帧解码器：pixels（W·H 索引）与 palette（256×3 RGB，0..255）是内部缓冲，
 * 每次 next() 原地更新；需要保留时自行复制。
 */
export class FlcDecoder {
  readonly flc: FlcFile;
  readonly pixels: Uint8Array;
  readonly palette: Uint8Array;
  private cursor = 0;

  constructor(flc: FlcFile) {
    this.flc = flc;
    this.pixels = new Uint8Array(flc.width * flc.height);
    this.palette = new Uint8Array(256 * 3);
  }

  /** 下一个将要解码的帧块序号 */
  get position(): number {
    return this.cursor;
  }

  get done(): boolean {
    return this.cursor >= this.flc.frameChunks.length;
  }

  /** 解码下一个帧块（含循环帧），返回其序号 */
  next(): number {
    const f = this.flc.frameChunks[this.cursor];
    if (!f) throw new GfxError('E_FLC_EOF', `${this.flc.label}: 已没有帧块（共 ${this.flc.frameChunks.length}）`);
    for (const sc of f.subchunks) this.apply(sc, f.index);
    this.cursor++;
    return f.index;
  }

  private fail(frame: number, sc: FlcSubChunk, what: string): GfxError {
    return new GfxError('E_FLC_DECODE', `${this.flc.label}: 帧 ${frame} 子块 ${sc.type}@${sc.offset}：${what}`);
  }

  private apply(sc: FlcSubChunk, frame: number): void {
    const d = this.flc.data;
    const w = this.flc.width;
    const h = this.flc.height;
    const px = this.pixels;
    const end = sc.dataEnd;
    let p = sc.dataOffset;
    const need = (n: number): void => {
      if (p + n > end) throw this.fail(frame, sc, `读取越过子块末尾（${p}+${n} > ${end}）`);
    };
    switch (sc.type) {
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
          if (idx + cnt > 256) throw this.fail(frame, sc, `调色板索引越界 ${idx}+${cnt}`);
          need(cnt * 3);
          for (let c = 0; c < cnt * 3; c++) {
            const v = d[p++]!;
            this.palette[idx * 3 + c] = sc.type === FLC_CHUNK.COLOR_64 ? (v << 2) | (v >> 4) : v;
          }
          idx += cnt;
        }
        return;
      }
      case FLC_CHUNK.BYTE_RUN: {
        for (let y = 0; y < h; y++) {
          need(1);
          p++; // 旧式包数，FLC 忽略，按行宽解到填满为止
          let x = 0;
          const row = y * w;
          while (x < w) {
            need(1);
            const cnt = (d[p++]! << 24) >> 24;
            if (cnt > 0) {
              need(1);
              if (x + cnt > w) throw this.fail(frame, sc, `BYTE_RUN 行 ${y} 越过行宽`);
              px.fill(d[p++]!, row + x, row + x + cnt);
              x += cnt;
            } else if (cnt < 0) {
              const n = -cnt;
              need(n);
              if (x + n > w) throw this.fail(frame, sc, `BYTE_RUN 行 ${y} 越过行宽`);
              px.set(d.subarray(p, p + n), row + x);
              p += n;
              x += n;
            } else {
              throw this.fail(frame, sc, `BYTE_RUN 行 ${y} 出现 0 长度包`);
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
            else throw this.fail(frame, sc, `DELTA_FLC 未定义的操作字 0x${op.toString(16)}`);
          }
          if (y >= h) throw this.fail(frame, sc, `DELTA_FLC 行 ${y} 越界`);
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
              if (x + n > w) throw this.fail(frame, sc, `DELTA_FLC 行 ${y} 越过行宽`);
              px.set(d.subarray(p, p + n), row + x);
              p += n;
              x += n;
            } else if (cnt < 0) {
              need(2);
              const a = d[p]!;
              const b = d[p + 1]!;
              p += 2;
              if (x - 2 * cnt > w) throw this.fail(frame, sc, `DELTA_FLC 行 ${y} 越过行宽`);
              for (let k2 = 0; k2 < -cnt; k2++) {
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
          if (y >= h) throw this.fail(frame, sc, `DELTA_FLI 行 ${y} 越界`);
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
              if (x + cnt > w) throw this.fail(frame, sc, `DELTA_FLI 行 ${y} 越过行宽`);
              px.set(d.subarray(p, p + cnt), row + x);
              p += cnt;
              x += cnt;
            } else if (cnt < 0) {
              need(1);
              if (x - cnt > w) throw this.fail(frame, sc, `DELTA_FLI 行 ${y} 越过行宽`);
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
        throw this.fail(frame, sc, '未知子块类型');
    }
  }
}

export interface FlcFrame {
  /** 帧块序号 */
  index: number;
  delay: number;
  pixels: Uint8Array;
  palette: Uint8Array;
}

export interface DecodeFlcOptions {
  /** 最多解出多少帧（从 0 起） */
  maxFrames?: number;
  /** 是否把循环帧也作为最后一帧输出，默认 false */
  includeRing?: boolean;
}

/** 解出各帧（每帧复制一份索引缓冲与调色板） */
export function decodeFlcFrames(flc: FlcFile, opts: DecodeFlcOptions = {}): FlcFrame[] {
  const total = opts.includeRing ? flc.frameChunks.length : Math.min(flc.frames, flc.frameChunks.length);
  const n = Math.min(total, opts.maxFrames ?? total);
  const dec = new FlcDecoder(flc);
  const out: FlcFrame[] = [];
  for (let i = 0; i < n; i++) {
    const idx = dec.next();
    out.push({ index: idx, delay: flcFrameDelay(flc, idx), pixels: dec.pixels.slice(), palette: dec.palette.slice() });
  }
  return out;
}

/** 循环帧解完后是否回到首帧（像素与调色板都一致）；没有循环帧时返回 null */
export function verifyFlcRing(flc: FlcFile): boolean | null {
  if (!flc.hasRingFrame) return null;
  const dec = new FlcDecoder(flc);
  dec.next();
  const first = dec.pixels.slice();
  const firstPal = dec.palette.slice();
  while (!dec.done) dec.next();
  return Buffer.from(first).equals(Buffer.from(dec.pixels)) && Buffer.from(firstPal).equals(Buffer.from(dec.palette));
}

export interface FlcRgbaOptions {
  /** 该索引输出透明；null 表示整帧不透明。默认 0 */
  transparentIndex?: number | null;
}

export function flcFrameToRgba(
  frame: { pixels: Uint8Array; palette: Uint8Array },
  w: number,
  h: number,
  opts: FlcRgbaOptions = {},
): RgbaImage {
  const t = opts.transparentIndex === undefined ? 0 : opts.transparentIndex;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = frame.pixels[i]!;
    if (v === t) continue;
    rgba[i * 4] = frame.palette[v * 3]!;
    rgba[i * 4 + 1] = frame.palette[v * 3 + 1]!;
    rgba[i * 4 + 2] = frame.palette[v * 3 + 2]!;
    rgba[i * 4 + 3] = 255;
  }
  return { w, h, rgba };
}
