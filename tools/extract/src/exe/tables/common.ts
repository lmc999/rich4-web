import { toHex } from '../../bin/reader';
import { hexVa, normalizeText, type PeFile } from '../../pe/scan';
import type { Check, CheckLevel, LocateContext, TableId } from '../types';

export const chk = (id: string, level: CheckLevel, ok: boolean, detail: string): Check => ({ id, level, ok, detail });

/** error 级检查全部通过 */
export const passes = (checks: readonly Check[]): boolean => checks.every((c) => c.ok || c.level !== 'error');

/** 读 VA 处 u32 指针并按 Big5 解码；任何一步失败返回 null */
export function namePtr(file: PeFile, at: number): string | null {
  const off = file.tryVaToOff(at);
  if (off === null || off + 4 > file.bytes.length) return null;
  const p = file.reader.u32(off);
  if (file.kindOfVa(p) !== 'data') return null;
  return file.big5At(p, 64);
}

export function recordHex(file: PeFile, va: number, len: number): string {
  return toHex(file.slice(va, len));
}

/**
 * 「指针表」签名：找所有指向 names[0] 的 u32（数据节），要求 +stride 处指向 names[1]。
 * names 按去空格文本比较（角色名「約 翰 喬」）。
 */
export function pointerPairSignature(
  ctx: LocateContext,
  names: readonly [string, string] | readonly string[],
  stride: number,
): { va: number | null; detail: string } {
  const [a, b] = [names[0]!, names[1]!];
  const strs = ctx.strings.find(a);
  if (strs.length === 0) return { va: null, detail: `数据节中没有「${a}」` };
  const hits: number[] = [];
  for (const s of strs) {
    for (const at of ctx.file.findU32(s.va, 'data')) {
      const next = namePtr(ctx.file, at + stride);
      if (next !== null && normalizeText(next) === normalizeText(b)) hits.push(at);
    }
  }
  if (hits.length !== 1) {
    return {
      va: null,
      detail: `指向「${a}」且 +${stride} 指向「${b}」的位置有 ${hits.length} 处（${hits.map(hexVa).join(', ')}）`,
    };
  }
  return { va: hits[0]!, detail: `唯一：指向「${a}」(${hexVa(strs[0]!.va)}) 且 +${stride} 指向「${b}」` };
}

/** 在数据节中找 u32 序列，要求唯一 */
export function u32SeqSignature(file: PeFile, seq: readonly number[]): { va: number | null; detail: string } {
  const bytes = new Uint8Array(seq.length * 4);
  const dv = new DataView(bytes.buffer);
  for (const [i, v] of seq.entries()) dv.setUint32(i * 4, v >>> 0, true);
  const hits = file.findPattern({ bytes, mask: new Uint8Array(bytes.length).fill(1) }, 'data');
  const txt = seq.map((v) => (v > 0xffffff ? `0x${v.toString(16)}` : String(v))).join(',');
  if (hits.length !== 1) return { va: null, detail: `u32 序列 [${txt}] 命中 ${hits.length} 处` };
  return { va: hits[0]!, detail: `u32 序列 [${txt}] 唯一命中` };
}

/** 用于跨版本比较的「内容」：去掉 hex 字段 */
export function stripHex<T extends object>(rows: readonly T[]): Omit<T, 'hex'>[] {
  return rows.map((r) => {
    const { hex: _hex, ...rest } = r as T & { hex?: string };
    return rest as Omit<T, 'hex'>;
  });
}

/** 每张表的定位/校验/解析规格（locate.ts 统一调度） */
export interface TableSpec<R> {
  id: TableId;
  /** xrefTransfer 时视作本表的字节跨度 */
  xrefSpan: number;
  hint(ctx: LocateContext): number | null;
  signature(ctx: LocateContext): { va: number | null; detail: string };
  /** 结构校验（error 级失败 = 该候选不是这张表） */
  validate(file: PeFile, va: number, ctx: LocateContext): Check[];
  parse(file: PeFile, va: number, ctx: LocateContext): R;
  /** 表区域字节数（摘要用） */
  byteLength(ctx: LocateContext): number;
}

export function hintOf(ctx: LocateContext, h: { v311?: string | undefined; v206?: string | undefined }): number | null {
  if (ctx.edition === 'unknown') return null;
  const s = h[ctx.edition];
  return s === undefined ? null : Number.parseInt(s, 16);
}
