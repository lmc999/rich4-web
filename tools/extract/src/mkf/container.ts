import { BinReader } from '../bin/reader';
import { ExtractError } from '../context';
import { classifyMkfResource, KIND_SNIFF_BYTES, type MkfKind } from './kind';
import { LzhufError, lzhufDecompress } from './lzhuf';

export type { MkfKind } from './kind';

/** 资源头：{ rawSize, storedSize, imageOffset, imageSize } 四个 u32。 */
export const MKF_ENTRY_HEADER_SIZE = 16;

/**
 * read() 解压失败时的错误码。沿用旧名以保持兼容：含义是「压缩流不符合严格 LZHUF 规格，无法解码」；
 * 细分原因（E_LZHUF_*）写在 message 里，原始 LzhufError 放在 cause。
 */
export const MKF_DECOMPRESS_FAILED = 'COMPRESSED_NOT_SUPPORTED';

export interface MkfEntry {
  index: number;
  /** 资源头的绝对偏移 */
  offset: number;
  rawSize: number;
  storedSize: number;
  imageOffset: number;
  imageSize: number;
  compressed: boolean;
  /** 按解压后内容的魔数与大小规则判定（见 kind.ts）；压缩流损坏时为 UNKNOWN */
  kind: MkfKind;
  /** 本项与下一项起点之间的空隙字节数（正常为 0） */
  gap: number;
}

export interface MkfWarning {
  code: string;
  index: number | null;
  detail: string;
}

export class MkfError extends ExtractError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message);
    this.name = 'MkfError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

/** 压缩资源只解出前 KIND_SNIFF_BYTES 字节来判定类型；只有可能是 TEXT 时才整段解压。解压失败 → UNKNOWN。 */
function sniffKind(stored: Uint8Array, e: Omit<MkfEntry, 'kind' | 'gap'>): MkfKind {
  const base = { rawSize: e.rawSize, imageOffset: e.imageOffset, imageSize: e.imageSize };
  if (!e.compressed) return classifyMkfResource({ ...base, head: stored, body: stored });
  let head: Uint8Array;
  try {
    head = lzhufDecompress(stored, e.rawSize, { limit: KIND_SNIFF_BYTES });
  } catch (err) {
    if (err instanceof LzhufError) return 'UNKNOWN';
    throw err;
  }
  const body = (): Uint8Array | null => {
    try {
      return lzhufDecompress(stored, e.rawSize);
    } catch (err) {
      if (err instanceof LzhufError) return null;
      throw err;
    }
  };
  return classifyMkfResource({ ...base, head, body });
}

/**
 * MKF 容器（data-pipeline.md §4.1/§4.2）：
 * u32 indexTableOffset；资源块从偏移 4 起；索引表位于 indexTableOffset..EOF，为 u32 绝对起点数组。
 */
export class MkfArchive {
  readonly name: string;
  readonly byteLength: number;
  readonly indexTableOffset: number;
  /** 索引表最后一项等于 indexTableOffset 时视为哨兵，不计入资源数 */
  readonly hasSentinel: boolean;
  readonly warnings: readonly MkfWarning[];
  private readonly reader: BinReader;
  private readonly list: readonly MkfEntry[];

  private constructor(
    name: string,
    reader: BinReader,
    x: number,
    sentinel: boolean,
    list: MkfEntry[],
    warnings: MkfWarning[],
  ) {
    this.name = name;
    this.reader = reader;
    this.byteLength = reader.length;
    this.indexTableOffset = x;
    this.hasSentinel = sentinel;
    this.list = list;
    this.warnings = warnings;
  }

  /** 解析并校验不变量；违反硬性不变量时抛 MkfError。 */
  static open(bytes: Uint8Array, name: string): MkfArchive {
    const r = new BinReader(bytes, name);
    const size = r.length;
    if (size < 8) throw new MkfError('E_MKF_TOO_SMALL', `${name}: 文件只有 ${size} 字节`);
    const x = r.u32(0);
    // 不变量 1
    if (x < 4 || x >= size || (size - x) % 4 !== 0) {
      throw new MkfError('E_MKF_INDEX_OFFSET', `${name}: indexTableOffset=${x} 非法（文件 ${size} 字节）`);
    }
    const n = (size - x) / 4;
    const starts: number[] = [];
    for (let i = 0; i < n; i++) starts.push(r.u32(x + i * 4));
    // 不变量 2
    if (starts[0] !== 4) throw new MkfError('E_MKF_FIRST_START', `${name}: index[0]=${starts[0]}，应为 4`);
    for (let i = 1; i < n; i++) {
      if (!(starts[i]! > starts[i - 1]!)) {
        throw new MkfError(
          'E_MKF_INDEX_ORDER',
          `${name}: index[${i}]=${starts[i]} 不大于 index[${i - 1}]=${starts[i - 1]}`,
        );
      }
    }
    const last = starts[n - 1]!;
    if (last > x) throw new MkfError('E_MKF_INDEX_RANGE', `${name}: index[${n - 1}]=${last} 越过索引表起点 ${x}`);
    // 不变量 4：哨兵
    const sentinel = last === x;
    const count = sentinel ? n - 1 : n;
    const warnings: MkfWarning[] = [];
    const list: MkfEntry[] = [];
    for (let i = 0; i < count; i++) {
      const off = starts[i]!;
      const next = i + 1 < n ? starts[i + 1]! : x;
      if (off + MKF_ENTRY_HEADER_SIZE > next) {
        throw new MkfError('E_MKF_ENTRY_HEADER', `${name}: 资源 ${i} 的 16 字节头越过下一项起点 ${next}`);
      }
      const rawSize = r.u32(off);
      const storedSize = r.u32(off + 4);
      const imageOffset = r.u32(off + 8);
      const imageSize = r.u32(off + 12);
      // 不变量 3
      const end = off + MKF_ENTRY_HEADER_SIZE + storedSize;
      if (end > next) {
        throw new MkfError('E_MKF_ENTRY_OVERFLOW', `${name}: 资源 ${i} 结束于 ${end}，越过下一项起点 ${next}`);
      }
      if (end < next) {
        warnings.push({ code: 'W_MKF_GAP', index: i, detail: `资源 ${i} 与下一项之间有 ${next - end} 字节空隙` });
      }
      // 不变量 5
      const isImage = imageOffset !== 0 || imageSize !== 0;
      if (isImage && imageOffset + imageSize > rawSize) {
        throw new MkfError(
          'E_MKF_IMAGE_RANGE',
          `${name}: 资源 ${i} imageOffset+imageSize=${imageOffset + imageSize} 超过 rawSize=${rawSize}`,
        );
      }
      const base = {
        index: i,
        offset: off,
        rawSize,
        storedSize,
        imageOffset,
        imageSize,
        compressed: storedSize !== rawSize,
      };
      const stored = r.slice(off + MKF_ENTRY_HEADER_SIZE, storedSize);
      list.push({ ...base, kind: sniffKind(stored, base), gap: next - end });
    }
    return new MkfArchive(name, r, x, sentinel, list, warnings);
  }

  get count(): number {
    return this.list.length;
  }

  entries(): readonly MkfEntry[] {
    return this.list;
  }

  entry(i: number): MkfEntry {
    const e = this.list[i];
    if (!Number.isInteger(i) || e === undefined) {
      throw new MkfError('E_MKF_RESOURCE_INDEX', `${this.name}: 资源号 ${i} 不存在（共 ${this.list.length} 个）`);
    }
    return e;
  }

  /** 资源体原样字节（压缩资源即压缩流；零拷贝）。 */
  readStored(i: number): Uint8Array {
    const e = this.entry(i);
    return this.reader.slice(e.offset + MKF_ENTRY_HEADER_SIZE, e.storedSize);
  }

  /**
   * 读取资源内容：未压缩资源零拷贝返回；压缩资源用严格 LZHUF 解压（每次调用都重新解压，返回新缓冲）。
   * 压缩流不符合规格时抛 MkfError(MKF_DECOMPRESS_FAILED)。
   */
  read(i: number): Uint8Array {
    const e = this.entry(i);
    const stored = this.readStored(i);
    if (!e.compressed) return stored;
    try {
      return lzhufDecompress(stored, e.rawSize);
    } catch (err) {
      if (!(err instanceof LzhufError)) throw err;
      throw new MkfError(
        MKF_DECOMPRESS_FAILED,
        `${this.name}: 资源 ${i} 的压缩流无法严格解码（stored=${e.storedSize} raw=${e.rawSize}）：${err.message}`,
        { cause: err },
      );
    }
  }
}
