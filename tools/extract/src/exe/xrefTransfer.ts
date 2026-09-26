import { type BytePattern, hexVa, type PeFile, patternFromBytes, patternToString } from '../pe/scan';

/**
 * xrefTransfer（data-pipeline.md §6.2）：把「参考版本中引用某地址的代码」迁移到另一版本，读出同位置的地址。
 * 1. 在参考 exe 的代码节中找所有 imm32/disp32 ∈ [target, target+span)（表内字段引用也算），
 *    并按前导字节过滤掉不像指令操作数的巧合（例如 `push ebp; call rel32` 的字节恰好拼出映像地址）；
 * 2. 取引用点前后各 radius 字节作模式：引用本身、其他像映像内地址的 4 字节窗口、call/jmp/jcc 的 rel32 一律通配；
 * 3. 在目标 exe 的代码节中搜索，半径从大到小尝试，要求唯一命中；读出同位置的 u32，减去字段偏移得到目标版本的表 VA；
 * 4. 各引用点迁移结果一致 → 采用；不一致时只接受「至少 2 个点、且占已迁移点 2/3 以上」的多数，离群点列入明细。
 */

export interface XrefSite {
  /** 参考 exe 中 imm32 所在 VA */
  at: string;
  /** 该 imm32 相对 target 的字段偏移 */
  field: number;
  radius: number | null;
  pattern: string | null;
  hits: number;
  /** 迁移出的目标表 VA；未唯一命中时为 null */
  result: string | null;
}

export interface XrefTransferResult {
  target: string;
  /** 采用的目标 VA（全体一致或多数一致） */
  va: number | null;
  sites: XrefSite[];
  resolved: number;
  /** 已迁移点全部一致 */
  agreed: boolean;
  /** 支持采用结果的点数 */
  support: number;
}

export interface XrefOptions {
  /** 视作同一张表的字节跨度（字段引用），默认 1 */
  span?: number;
  /** 依次尝试的模式半径（从大到小） */
  radii?: readonly number[];
  /** 最多使用的引用点数 */
  maxSites?: number;
}

/** 单字节操作码后直接跟 imm32/moffs32：mov/push/算术 eax,imm32/test eax,imm32 */
const OPCODE_IMM32 = new Set([
  0xa0, 0xa1, 0xa2, 0xa3, 0x68, 0x05, 0x0d, 0x15, 0x1d, 0x25, 0x2d, 0x35, 0x3d, 0xa9, 0xb8, 0xb9, 0xba, 0xbb, 0xbc,
  0xbd, 0xbe, 0xbf,
]);

/** off 处的 4 字节是否可能是指令的 imm32/disp32 操作数（启发式，只看前导字节） */
export function plausibleOperand(bytes: Uint8Array, off: number): boolean {
  if (off < 1) return false;
  const b1 = bytes[off - 1]!;
  if (OPCODE_IMM32.has(b1)) return true;
  // off-1 是 ModRM：mod=00 rm=101（[disp32]）或 mod=10 rm≠100（[reg+disp32]）
  const mod1 = b1 >> 6;
  const rm1 = b1 & 7;
  if ((mod1 === 0 && rm1 === 5) || (mod1 === 2 && rm1 !== 4)) return true;
  if (off >= 2) {
    // off-2 是 ModRM（rm=100 → 带 SIB），off-1 是 SIB：mod=00 且 base=101，或 mod=10
    const b2 = bytes[off - 2]!;
    const mod2 = b2 >> 6;
    if ((b2 & 7) === 4 && ((mod2 === 0 && (b1 & 7) === 5) || mod2 === 2)) return true;
    // 寄存器形式的 imm32：c7 /0、81 /x、69 /r（ModRM mod=11）
    if ((b2 === 0xc7 || b2 === 0x81 || b2 === 0x69) && mod1 === 3) return true;
  }
  // mov dword [disp32], imm32：c7 05 disp32 imm32
  if (off >= 6 && bytes[off - 6] === 0xc7 && bytes[off - 5] === 0x05) return true;
  return false;
}

/** 构造通配模式：见文件头第 2 步 */
export function sitePattern(file: PeFile, at: number, radius: number): { pattern: BytePattern; start: number } | null {
  const off = file.tryVaToOff(at);
  if (off === null) return null;
  const code = file.spans('code').find((s) => off >= s.off && off < s.end);
  if (!code) return null;
  const start = Math.max(code.off, off - radius);
  const end = Math.min(code.end, off + 4 + radius);
  const bytes = file.bytes.subarray(start, end);
  const wild = new Array<boolean>(bytes.length).fill(false);
  /** 以文件偏移给出的区间与窗口求交后通配（窗口边缘被截断的操作数也要通配） */
  const wildAt = (fileOff: number, n: number) => {
    for (let k = Math.max(start, fileOff); k < Math.min(end, fileOff + n); k++) wild[k - start] = true;
  };
  wildAt(off, 4);
  const all = file.bytes;
  const u32 = (k: number) => (all[k]! | (all[k + 1]! << 8) | (all[k + 2]! << 16) | (all[k + 3]! << 24)) >>> 0;
  const i32 = (k: number) => all[k]! | (all[k + 1]! << 8) | (all[k + 2]! << 16) | (all[k + 3]! << 24);
  const lo = Math.max(code.off, start - 5);
  const hi = Math.min(code.end, end + 1);
  for (let k = lo; k + 4 <= hi; k++) {
    if (file.isImageAddress(u32(k))) wildAt(k, 4);
  }
  for (let k = lo; k + 5 <= hi; k++) {
    const op = all[k]!;
    // call rel32 / jmp rel32：目标在代码节内时视为相对跳转
    if (op === 0xe8 || op === 0xe9) {
      const tgt = file.offToVa(k) + 5 + i32(k + 1);
      if (file.kindOfVa(tgt) === 'code') wildAt(k + 1, 4);
    }
    // jcc rel32：0f 80..8f
    if (op === 0x0f && k + 6 <= hi && all[k + 1]! >= 0x80 && all[k + 1]! <= 0x8f) wildAt(k + 2, 4);
  }
  // 短跳转 jcc rel8（70..7f）与 jmp rel8（eb）：两版函数体长度不同会改变偏移
  for (let k = Math.max(code.off, start - 1); k + 2 <= hi; k++) {
    const op = all[k]!;
    if ((op >= 0x70 && op <= 0x7f) || op === 0xeb) wildAt(k + 1, 1);
  }
  return { pattern: patternFromBytes(bytes, wild), start };
}

export function findCodeRefs(file: PeFile, target: number, span = 1): { at: number; value: number }[] {
  return file
    .findU32InRange(target, target + span, 'code')
    .filter((r) => plausibleOperand(file.bytes, file.vaToOff(r.at)));
}

export function xrefTransfer(src: PeFile, dst: PeFile, target: number, opts: XrefOptions = {}): XrefTransferResult {
  const span = opts.span ?? 1;
  const radii = opts.radii ?? [24, 16, 12];
  const refs = findCodeRefs(src, target, span).slice(0, opts.maxSites ?? 16);
  const sites: XrefSite[] = [];
  for (const ref of refs) {
    const field = ref.value - target;
    const site: XrefSite = { at: hexVa(ref.at), field, radius: null, pattern: null, hits: 0, result: null };
    for (const r of radii) {
      const sp = sitePattern(src, ref.at, r);
      if (!sp) break;
      const hits = dst.findPattern(sp.pattern, 'code');
      site.radius = r;
      site.pattern = patternToString(sp.pattern);
      site.hits = hits.length;
      if (hits.length === 1) {
        const immVa = hits[0]! + (src.vaToOff(ref.at) - sp.start);
        const value = dst.u32(immVa);
        if (dst.isImageAddress(value)) site.result = hexVa(value - field);
        break;
      }
    }
    sites.push(site);
  }
  const tally = new Map<string, number>();
  for (const s of sites) if (s.result !== null) tally.set(s.result, (tally.get(s.result) ?? 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const resolved = sites.filter((s) => s.result !== null).length;
  const agreed = ranked.length === 1;
  const [best, support] = ranked[0] ?? [null, 0];
  const majority = support >= 2 && support * 3 >= resolved * 2;
  return {
    target: hexVa(target),
    va: best !== null && (agreed || majority) ? Number.parseInt(best, 16) : null,
    sites,
    resolved,
    agreed,
    support,
  };
}
