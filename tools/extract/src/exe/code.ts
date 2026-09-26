import { hexVa, type PeFile } from '../pe/scan';
import { decodeAt, flowOf, type Insn, type MemOperand, type Operand, relTarget } from './x86';

/**
 * 代码节视图（data-pipeline.md §6.4）：
 * - CodeIndex：对代码节做线性扫描（与 r2 `pD` 在两版 exe 的整个代码节上逐条一致），再以分支目标重新同步，得到指令边界；
 *   直接 call 的目标记为函数入口；
 * - disasmFunction：从入口做递归下降（跟随 jcc/jmp、解析 `jmp [reg*4+表]` 跳表），得到函数体（含共享尾块）；
 * - mulChain：求 Watcom 用移位/加减链实现的「常数 × 内存量」的系数（金额 = 系数 × 物价指数）。
 */

export class CodeIndex {
  readonly file: PeFile;
  /** 线性扫描得到的指令起点 VA（升序） */
  readonly starts: Uint32Array;
  /** 直接 call 的目标（升序），视作函数入口 */
  readonly entries: Uint32Array;
  private readonly lo: number;
  private readonly hi: number;

  private constructor(file: PeFile, starts: Uint32Array, entries: Uint32Array, lo: number, hi: number) {
    this.file = file;
    this.starts = starts;
    this.entries = entries;
    this.lo = lo;
    this.hi = hi;
  }

  /**
   * 两遍：先整节线性扫描；再以所有直接 call/jmp/jcc 的目标与跳表项为起点重新同步
   * （函数间的填充字节会让线性扫描吞掉下一函数的首条指令），重叠的旧起点作废。
   */
  static build(file: PeFile): CodeIndex {
    const starts = new Set<number>();
    const targets: number[] = [];
    const calls = new Set<number>();
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    const spans = file.spans('code');
    for (const sp of spans) {
      lo = Math.min(lo, sp.va);
      hi = Math.max(hi, sp.va + (sp.end - sp.off));
    }
    const inCode = (va: number) => va >= lo && va < hi;
    for (const sp of spans) {
      for (let off = sp.off; off < sp.end; ) {
        const va = sp.va + (off - sp.off);
        const i = decodeAt(file.bytes, off, va, sp.end);
        starts.add(va);
        const t = relTarget(i);
        if (t !== null && inCode(t)) {
          targets.push(t);
          if (i.mnem === 'call') calls.add(t);
        }
        // 跳表 jmp dword [reg*4 + T]：表项也是重新同步的起点（表本身常在代码节内）
        if (i.mnem === 'jmp' && i.ops[0]?.t === 'mem') {
          const m = i.ops[0];
          if (m.base === null && m.index !== null && m.scale === 4 && m.dispSize === 4) {
            for (let k = 0; k < 256; k++) {
              const at = file.tryVaToOff(m.dispU + 4 * k);
              if (at === null || at + 4 > file.bytes.length) break;
              const e = file.reader.u32(at);
              if (!inCode(e)) break;
              targets.push(e);
            }
          }
        }
        off += i.len;
      }
    }
    const end = (va: number) => {
      const sp = spans.find((x) => va >= x.va && va < x.va + (x.end - x.off))!;
      return sp.end;
    };
    for (const t of new Set(targets)) {
      if (starts.has(t)) continue;
      let va = t;
      for (let k = 0; k < 64 && inCode(va) && !starts.has(va); k++) {
        const i = decodeAt(file.bytes, file.vaToOff(va), va, end(va));
        if (i.mnem === '(bad)') break;
        // 被新指令覆盖的旧起点作废
        for (let b = va + 1; b < va + i.len; b++) starts.delete(b);
        starts.add(va);
        va += i.len;
      }
    }
    const sorted = Uint32Array.from(starts).sort();
    const entries = Uint32Array.from([...calls].filter((c) => starts.has(c))).sort();
    return new CodeIndex(file, sorted, entries, lo, hi);
  }

  /** va 所在函数的入口：不大于 va 的最近一个 call 目标（没有时 null） */
  enclosingEntry(va: number): number | null {
    let a = 0;
    let b = this.entries.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (this.entries[m]! <= va) a = m + 1;
      else b = m;
    }
    return a === 0 ? null : this.entries[a - 1]!;
  }

  inCode(va: number): boolean {
    return va >= this.lo && va < this.hi;
  }

  /** va 所在（或之后第一条）指令在 starts 中的下标 */
  indexOf(va: number): number {
    let a = 0;
    let b = this.starts.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (this.starts[m]! < va) a = m + 1;
      else b = m;
    }
    return a;
  }

  /** va 是否恰好是线性扫描的指令起点 */
  isBoundary(va: number): boolean {
    const i = this.indexOf(va);
    return i < this.starts.length && this.starts[i] === va;
  }

  at(va: number): Insn {
    return insnAt(this.file, va);
  }

  /** va 前 before 条、后 after 条（含 va 本身）指令；va 必须是指令起点 */
  window(va: number, before: number, after: number): Insn[] {
    const i = this.indexOf(va);
    const out: Insn[] = [];
    for (let k = Math.max(0, i - before); k < Math.min(this.starts.length, i + after); k++) {
      out.push(this.at(this.starts[k]!));
    }
    return out;
  }
}

/** 解码 VA 处的一条指令（VA 必须在有原始数据的节内） */
export function insnAt(file: PeFile, va: number): Insn {
  const off = file.vaToOff(va);
  const sp = file.spans('all').find((s) => off >= s.off && off < s.end);
  return decodeAt(file.bytes, off, va, sp ? sp.end : file.bytes.length);
}

export const immOperands = (i: Insn) => i.ops.filter((o): o is Extract<Operand, { t: 'imm' }> => o.t === 'imm');
export const memOperand = (i: Insn): MemOperand | null =>
  (i.ops.find((o) => o.t === 'mem') as MemOperand | undefined) ?? null;

/** 指令中所有「像映像内地址」的 32 位值（imm32 或 disp32），附带其在指令内的字节偏移 */
export function imageRefs(file: PeFile, i: Insn): { value: number; off: number }[] {
  const out: { value: number; off: number }[] = [];
  for (const o of i.ops) {
    if (o.t === 'imm' && o.size === 4 && file.isImageAddress(o.value >>> 0))
      out.push({ value: o.value >>> 0, off: o.off });
    if (o.t === 'mem' && o.dispSize === 4 && file.isImageAddress(o.dispU)) out.push({ value: o.dispU, off: o.dispOff });
  }
  return out;
}

// ───────────────────────── 函数体（递归下降） ─────────────────────────

export interface FunctionBody {
  entry: number;
  /** 按 VA 升序的指令 */
  insns: Insn[];
  /** 调用的直接目标（按首次出现顺序去重） */
  calls: number[];
  /** 解析出的跳表（表 VA → 目标） */
  jumpTables: { table: number; targets: number[] }[];
  /** 达到上限而截断 */
  truncated: boolean;
}

export interface DisasmOptions {
  maxInsns?: number;
  /** 不跟随进入的地址（例如另一个已知函数的入口，避免把相邻函数并进来） */
  stopAt?: ReadonlySet<number>;
}

/**
 * 跳表：`jmp dword [reg*4 + table]`，项数由之前最近的 `cmp reg, imm` + `ja/jae` 给出；
 * 找不到上界时按「连续指向代码节、且离 table 不远」的项读取（最多 64 项）。
 */
function jumpTableTargets(
  file: PeFile,
  code: CodeIndex,
  prev: readonly Insn[],
  i: Insn,
): { table: number; targets: number[] } | null {
  const m = memOperand(i);
  if (!m || m.index === null || m.scale !== 4 || m.dispSize !== 4) return null;
  const table = m.dispU;
  if (file.tryVaToOff(table) === null) return null;
  let bound: number | null = null;
  for (let k = prev.length - 1; k >= Math.max(0, prev.length - 6); k--) {
    const p = prev[k]!;
    if (p.mnem === 'cmp' && p.ops[0]?.t === 'reg' && p.ops[1]?.t === 'imm') {
      bound = (p.ops[1].value >>> 0) + 1;
      break;
    }
  }
  const max = bound !== null && bound <= 256 ? bound : 64;
  const targets: number[] = [];
  for (let k = 0; k < max; k++) {
    const at = table + k * 4;
    if (file.tryVaToOff(at + 3) === null) break;
    const t = file.u32(at);
    if (!code.inCode(t)) {
      if (bound === null) break;
      return null;
    }
    targets.push(t);
  }
  return targets.length > 0 ? { table, targets } : null;
}

export function disasmFunction(code: CodeIndex, entry: number, opts: DisasmOptions = {}): FunctionBody {
  const file = code.file;
  const max = opts.maxInsns ?? 6000;
  const seen = new Map<number, Insn>();
  const calls: number[] = [];
  const callSet = new Set<number>();
  const jumpTables: FunctionBody['jumpTables'] = [];
  const work: number[] = [entry];
  let truncated = false;
  while (work.length > 0) {
    let va = work.pop()!;
    const trail: Insn[] = [];
    for (;;) {
      if (seen.has(va) || !code.inCode(va)) break;
      if (va !== entry && opts.stopAt?.has(va)) break;
      if (seen.size >= max) {
        truncated = true;
        break;
      }
      const i = code.at(va);
      seen.set(va, i);
      trail.push(i);
      const f = flowOf(i);
      if (f === 'ret' || f === 'stop') break;
      if (f === 'jmp') {
        const t = relTarget(i);
        if (t !== null) work.push(t);
        break;
      }
      if (f === 'ijmp') {
        const jt = jumpTableTargets(file, code, trail, i);
        if (jt) {
          jumpTables.push(jt);
          for (const t of jt.targets) work.push(t);
        }
        break;
      }
      if (f === 'jcc') {
        const t = relTarget(i);
        if (t !== null) work.push(t);
      }
      if (f === 'call') {
        const t = relTarget(i);
        if (t !== null && !callSet.has(t)) {
          callSet.add(t);
          calls.push(t);
        }
      }
      va += i.len;
    }
  }
  const insns = [...seen.values()].sort((a, b) => a.va - b.va);
  return { entry, insns, calls, jumpTables, truncated };
}

// ───────────────────────── 常数乘法链 ─────────────────────────

export interface MulChainResult {
  /** 结果寄存器中「源内存量」的系数 */
  factor: number;
  /** 链首 `mov r, [mem]` 读取的内存地址 */
  source: number;
  /** 参与求值的指令（链首起 length 条） */
  insns: Insn[];
}

export class MulChainError extends Error {}

const REG32 = new Set(['eax', 'ecx', 'edx', 'ebx', 'esi', 'edi', 'ebp']);

/**
 * 从 va 起执行 length 条指令，求 reg 中的值 = factor × X（X 为链首从内存读入的量）。
 * 只接受：mov r,[mem]（链首）、mov r,r、shl r,imm、add/sub r,r、lea r,[b+i*s]、imul r,r,imm、imul r,imm、neg r；
 * 其他指令（含对无关寄存器的写入）只要不碰链上寄存器就跳过。
 */
export function mulChain(code: CodeIndex, va: number, length: number, reg: string): MulChainResult {
  const insns: Insn[] = [];
  let at = va;
  for (let k = 0; k < length; k++) {
    const i = code.at(at);
    insns.push(i);
    at += i.len;
  }
  const first = insns[0]!;
  const src = first.ops[1];
  if (
    first.mnem !== 'mov' ||
    first.ops[0]?.t !== 'reg' ||
    src?.t !== 'mem' ||
    src.base !== null ||
    src.index !== null
  ) {
    throw new MulChainError(`${hexVa(va)} 不是 \`mov r, [mem]\` 链首：${first.mnem}`);
  }
  const val = new Map<string, number>([[first.ops[0].name, 1]]);
  const get = (o: Operand | undefined): number => {
    if (o?.t !== 'reg' || !val.has(o.name))
      throw new MulChainError(`${hexVa(va)} 链中引用了未知寄存器 ${o ? JSON.stringify(o) : '?'}`);
    return val.get(o.name)!;
  };
  for (const i of insns.slice(1)) {
    const d = i.ops[0];
    if (d?.t !== 'reg' || !REG32.has(d.name)) {
      if (d?.t === 'mem' || i.mnem === 'push' || i.mnem === 'cmp' || i.mnem === 'test') continue;
      throw new MulChainError(`${hexVa(i.va)} 不支持的指令 ${i.mnem}`);
    }
    const s = i.ops[1];
    switch (i.mnem) {
      case 'mov':
        if (s?.t === 'reg') val.set(d.name, get(s));
        else val.delete(d.name);
        break;
      case 'shl':
        if (s?.t !== 'imm') throw new MulChainError(`${hexVa(i.va)} shl 需要立即数`);
        val.set(d.name, get(d) * 2 ** s.value);
        break;
      case 'add':
        val.set(d.name, get(d) + get(s));
        break;
      case 'sub':
        val.set(d.name, get(d) - get(s));
        break;
      case 'neg':
        val.set(d.name, -get(d));
        break;
      case 'lea': {
        if (s?.t !== 'mem' || s.disp !== 0) throw new MulChainError(`${hexVa(i.va)} lea 只接受无位移形式`);
        let v = 0;
        if (s.base) v += get({ t: 'reg', name: s.base, size: 4 });
        if (s.index) v += get({ t: 'reg', name: s.index, size: 4 }) * s.scale;
        val.set(d.name, v);
        break;
      }
      case 'imul': {
        const k = i.ops.length === 3 ? i.ops[2] : s;
        if (k?.t !== 'imm') throw new MulChainError(`${hexVa(i.va)} imul 只接受立即数因子`);
        val.set(d.name, get(i.ops.length === 3 ? s : d) * k.value);
        break;
      }
      default:
        throw new MulChainError(`${hexVa(i.va)} 不支持的指令 ${i.mnem}`);
    }
  }
  if (!val.has(reg)) throw new MulChainError(`${hexVa(va)} 链末寄存器 ${reg} 不含源量`);
  return { factor: val.get(reg)!, source: src.dispU, insns };
}
