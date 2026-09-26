import { decodeBig5Strict } from '../bin/big5';
import { f32FromBits } from '../bin/f32';
import { BinReader } from '../bin/reader';
import { ExtractError } from '../context';
import { type PeImage, type PeSection, parsePe } from './pe';

/**
 * PE 扫描基础（data-pipeline.md §6.1，零依赖）：
 * - PeFile：VA ↔ 文件偏移、按 VA 读取、按节分类（代码 / 已初始化数据）；
 * - 带通配的字节模式（"8b 0d ?? ?? 46 00"）与 u32 指针搜索；
 * - Big5 字符串索引：数据节中以 NUL 分隔、能严格解码且含双字节字的串，按去空格文本反查 VA。
 */

/** IMAGE_SCN_CNT_CODE / MEM_EXECUTE / CNT_INITIALIZED_DATA */
const SCN_CODE = 0x20;
const SCN_EXEC = 0x20000000;
const SCN_IDATA = 0x40;

export const hexVa = (va: number): string => `0x${(va >>> 0).toString(16)}`;

/** 节在文件中的映射范围：Watcom 的 VirtualSize 可能为 0，此时按 rawSize。 */
function mappedSize(s: PeSection): number {
  return s.virtualSize === 0 ? s.rawSize : Math.min(s.virtualSize, s.rawSize);
}

export interface SectionSpan {
  section: PeSection;
  /** 起始 VA（含 ImageBase） */
  va: number;
  /** 文件偏移 [off, end) */
  off: number;
  end: number;
}

export type SectionFilter = 'code' | 'data' | 'all';

export class PeFile {
  readonly bytes: Uint8Array;
  readonly label: string;
  readonly pe: PeImage;
  readonly reader: BinReader;
  /** 映像地址范围 [lo, hi)，用于判断某个 u32 是否像映像内指针 */
  readonly imageLo: number;
  readonly imageHi: number;

  constructor(bytes: Uint8Array, label = 'exe') {
    this.bytes = bytes;
    this.label = label;
    this.pe = parsePe(bytes, label);
    this.reader = new BinReader(bytes, label);
    this.imageLo = this.pe.imageBase;
    let hi = this.pe.imageBase;
    for (const s of this.pe.sections) {
      const span = Math.max(s.virtualSize, s.rawSize);
      hi = Math.max(hi, this.pe.imageBase + s.virtualAddress + span);
    }
    this.imageHi = hi;
  }

  get imageBase(): number {
    return this.pe.imageBase;
  }

  /** 映射到文件内容的节（跳过 .bss 这类无原始数据的节） */
  spans(filter: SectionFilter = 'all'): SectionSpan[] {
    const out: SectionSpan[] = [];
    for (const s of this.pe.sections) {
      if (s.rawPointer === 0 || s.rawSize === 0) continue;
      const isCode = (s.characteristics & (SCN_CODE | SCN_EXEC)) !== 0;
      const isData = !isCode && (s.characteristics & SCN_IDATA) !== 0;
      if (filter === 'code' && !isCode) continue;
      if (filter === 'data' && !isData) continue;
      out.push({
        section: s,
        va: this.pe.imageBase + s.virtualAddress,
        off: s.rawPointer,
        end: Math.min(this.bytes.length, s.rawPointer + mappedSize(s)),
      });
    }
    return out;
  }

  /** VA → 文件偏移；不在任何有原始数据的节内时返回 null */
  tryVaToOff(va: number): number | null {
    for (const sp of this.spans('all')) {
      const d = va - sp.va;
      if (d >= 0 && sp.off + d < sp.end) return sp.off + d;
    }
    return null;
  }

  vaToOff(va: number, size = 1): number {
    const off = this.tryVaToOff(va);
    const last = size > 1 ? this.tryVaToOff(va + size - 1) : off;
    if (off === null || last === null || last !== off + size - 1) {
      throw new ExtractError('E_VA', `${this.label}: VA ${hexVa(va)}（+${size}）不在已映射的节内`);
    }
    return off;
  }

  tryOffToVa(off: number): number | null {
    for (const sp of this.spans('all')) {
      if (off >= sp.off && off < sp.end) return sp.va + (off - sp.off);
    }
    return null;
  }

  offToVa(off: number): number {
    const va = this.tryOffToVa(off);
    if (va === null) throw new ExtractError('E_VA', `${this.label}: 文件偏移 ${hexVa(off)} 不在已映射的节内`);
    return va;
  }

  /** VA 所在的节类别；未映射时 null */
  kindOfVa(va: number): 'code' | 'data' | null {
    for (const f of ['code', 'data'] as const) {
      for (const sp of this.spans(f)) {
        const d = va - sp.va;
        if (d >= 0 && sp.off + d < sp.end) return f;
      }
    }
    return null;
  }

  isImageAddress(v: number): boolean {
    return v >= this.imageLo && v < this.imageHi;
  }

  u8(va: number): number {
    return this.reader.u8(this.vaToOff(va, 1));
  }

  u16(va: number): number {
    return this.reader.u16(this.vaToOff(va, 2));
  }

  u32(va: number): number {
    return this.reader.u32(this.vaToOff(va, 4));
  }

  i32(va: number): number {
    return this.reader.i32(this.vaToOff(va, 4));
  }

  f32(va: number): number {
    return f32FromBits(this.u32(va));
  }

  slice(va: number, len: number): Uint8Array {
    return this.reader.slice(this.vaToOff(va, len), len);
  }

  /** VA 处的 NUL 结尾串（不含 NUL）；越界或超长返回 null */
  cstr(va: number, max = 256): Uint8Array | null {
    const off = this.tryVaToOff(va);
    if (off === null) return null;
    for (let i = off; i < Math.min(this.bytes.length, off + max); i++) {
      if (this.bytes[i] === 0) return this.bytes.subarray(off, i);
    }
    return null;
  }

  /** VA 处的串按 Big5 严格解码；失败返回 null */
  big5At(va: number, max = 256): string | null {
    const b = this.cstr(va, max);
    return b === null ? null : decodeBig5Strict(b);
  }

  /** 在指定节里找模式，返回命中的 VA（升序） */
  findPattern(pat: BytePattern, filter: SectionFilter = 'all'): number[] {
    const out: number[] = [];
    for (const sp of this.spans(filter)) {
      for (const off of findPattern(this.bytes, pat, sp.off, sp.end)) out.push(sp.va + (off - sp.off));
    }
    return out;
  }

  /** 找所有等于 value 的 u32（任意对齐），返回所在 VA */
  findU32(value: number, filter: SectionFilter = 'data'): number[] {
    return this.findPattern(patternFromU32(value), filter);
  }

  /** 找 u32 落在 [lo, hi) 内的位置（代码中的 imm32/disp32 引用），返回 { at, value } */
  findU32InRange(lo: number, hi: number, filter: SectionFilter = 'code'): { at: number; value: number }[] {
    const out: { at: number; value: number }[] = [];
    const b = this.bytes;
    for (const sp of this.spans(filter)) {
      for (let i = sp.off; i + 4 <= sp.end; i++) {
        const v = (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
        if (v >= lo && v < hi) out.push({ at: sp.va + (i - sp.off), value: v });
      }
    }
    return out;
  }
}

// ───────────────────────── 字节模式 ─────────────────────────

export interface BytePattern {
  bytes: Uint8Array;
  /** 1 = 必须相等；0 = 通配 */
  mask: Uint8Array;
}

/** "8b 0d ?? ?? 46 00" → 模式；空白分隔，`??` 表示通配 */
export function parsePattern(src: string): BytePattern {
  const toks = src
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const bytes = new Uint8Array(toks.length);
  const mask = new Uint8Array(toks.length);
  toks.forEach((t, i) => {
    if (t === '??') return;
    if (!/^[0-9a-fA-F]{2}$/.test(t)) throw new ExtractError('E_PATTERN', `非法模式字节「${t}」`);
    bytes[i] = Number.parseInt(t, 16);
    mask[i] = 1;
  });
  if (toks.length === 0) throw new ExtractError('E_PATTERN', '空模式');
  return { bytes, mask };
}

export function patternToString(p: BytePattern): string {
  return Array.from(p.bytes, (b, i) => (p.mask[i] ? b.toString(16).padStart(2, '0') : '??')).join(' ');
}

export function patternFromBytes(bytes: Uint8Array, wild?: readonly boolean[]): BytePattern {
  const mask = new Uint8Array(bytes.length).fill(1);
  if (wild) {
    for (const [i, w] of wild.entries()) if (w) mask[i] = 0;
  }
  return { bytes: Uint8Array.from(bytes), mask };
}

export function patternFromU32(value: number): BytePattern {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0, true);
  return patternFromBytes(b);
}

/** 带通配的朴素搜索（首个非通配字节做预筛），返回 [from, to) 内的命中偏移 */
export function findPattern(hay: Uint8Array, pat: BytePattern, from = 0, to = hay.length): number[] {
  const n = pat.bytes.length;
  const out: number[] = [];
  let anchor = -1;
  for (let k = 0; k < n; k++) {
    if (pat.mask[k]) {
      anchor = k;
      break;
    }
  }
  const end = Math.min(to, hay.length) - n;
  for (let i = Math.max(0, from); i <= end; i++) {
    if (anchor >= 0 && hay[i + anchor] !== pat.bytes[anchor]) continue;
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (pat.mask[k] && hay[i + k] !== pat.bytes[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// ───────────────────────── Big5 字符串索引 ─────────────────────────

/** 比较用的规范化：去掉半角与全角空格（角色名「約 翰 喬」、股票名「台 積 電」） */
export function normalizeText(s: string): string {
  return s.replace(/[ 　]/g, '');
}

export interface StringEntry {
  va: number;
  length: number;
  text: string;
  norm: string;
}

/** 可显示：不含 C0 控制符（允许 \t \r \n）与 DEL */
function printable(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) return false;
  }
  return true;
}

export class Big5StringIndex {
  private readonly byVaMap = new Map<number, StringEntry>();
  private readonly byNorm = new Map<string, StringEntry[]>();

  private constructor(entries: readonly StringEntry[]) {
    for (const e of entries) {
      this.byVaMap.set(e.va, e);
      const list = this.byNorm.get(e.norm);
      if (list) list.push(e);
      else this.byNorm.set(e.norm, [e]);
    }
  }

  /** 扫描已初始化数据节：以 NUL 切分，保留严格解码成功、可显示且含非 ASCII 字符的串 */
  static build(file: PeFile, minBytes = 2): Big5StringIndex {
    const entries: StringEntry[] = [];
    for (const sp of file.spans('data')) {
      let start = sp.off;
      for (let i = sp.off; i <= sp.end; i++) {
        if (i < sp.end && file.bytes[i] !== 0) continue;
        const len = i - start;
        if (len >= minBytes) {
          const raw = file.bytes.subarray(start, i);
          if (raw.some((b) => b >= 0x80)) {
            const text = decodeBig5Strict(raw);
            if (text !== null && printable(text)) {
              entries.push({ va: sp.va + (start - sp.off), length: len, text, norm: normalizeText(text) });
            }
          }
        }
        start = i + 1;
      }
    }
    return new Big5StringIndex(entries);
  }

  get size(): number {
    return this.byVaMap.size;
  }

  at(va: number): StringEntry | undefined {
    return this.byVaMap.get(va);
  }

  /** 按规范化文本精确查找（升序 VA） */
  find(text: string): StringEntry[] {
    return [...(this.byNorm.get(normalizeText(text)) ?? [])].sort((a, b) => a.va - b.va);
  }

  entries(): StringEntry[] {
    return [...this.byVaMap.values()].sort((a, b) => a.va - b.va);
  }
}
