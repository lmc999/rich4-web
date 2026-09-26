import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { f32FromBits } from '../bin/f32';
import { ExtractError, PACKAGE_DIR } from '../context';
import { hexVa, type PeFile } from '../pe/scan';
import { type CodeIndex, immOperands, MulChainError, memOperand, mulChain } from './code';
import { type AddressTranslator, alignTransfer, stringTranslator, transferInsn } from './insnTransfer';
import type { ExeEdition } from './types';

/**
 * 规则常量锚点（anchors/constants.json，入库；data-pipeline.md §6.4 第 7 条）。
 * 每项：id、期望值、v3.11 位置（参考）、v2.06 位置（由 v3.11 指令迁移得到，入库以便复核）、是否已人工确认语义。
 * 位置种类：
 *   imm       指令的立即数（多个立即数时取 operand 指定的那个，默认最后一个）
 *   mulChain  从链首 `mov r,[mem]` 起 length 条指令后 reg 中「内存量」的系数（金额 × 物价指数一类）
 *   f64 / f32 指令内存操作数指向的浮点常量
 *   data      数据：v311/v206 为数据 VA，ref 为引用它的代码指令（用于跨版本迁移）
 *   derived   由其他锚点计算（sum / dot / rangeCount / pctGe）
 * 只含数值、地址与自拟说明，不含原版字节。
 */

const Va = z.string().regex(/^0x[0-9a-f]+$/);
const Num = z.number();

const LocSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('imm'), operand: z.number().int().min(0).optional() }),
  z.strictObject({
    kind: z.literal('mulChain'),
    length: z.number().int().min(1).max(40),
    reg: z.enum(['eax', 'ecx', 'edx', 'ebx', 'esi', 'edi', 'ebp']),
    /** 链首读取的量（同一版本内同名 source 的链必须读同一地址） */
    source: z.string(),
  }),
  z.strictObject({ kind: z.literal('f64') }),
  z.strictObject({ kind: z.literal('f32') }),
  z.strictObject({
    kind: z.literal('data'),
    type: z.enum(['u8', 'i8', 'u16', 'i16', 'u32', 'i32']),
    count: z.number().int().min(1).max(4096),
    /** v3.11 中引用该数据的指令（内存操作数或立即数 = 数据 VA + refDelta） */
    ref: Va,
    refDelta: z.number().int().optional(),
    /** v2.06 中对应的引用指令（迁移得到） */
    ref206: Va.nullable().optional(),
  }),
  z.strictObject({
    kind: z.literal('derived'),
    op: z.enum(['sum', 'dot', 'rangeCount', 'pctGe']),
    args: z.array(z.union([z.string(), Num, z.array(z.union([z.string(), Num]))])),
  }),
]);

export const ConstantEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/),
  value: z.union([Num, z.array(Num)]),
  /** v2.06 的值与 value 不同时显式给出（版本差异） */
  v206Value: z.union([Num, z.array(Num)]).optional(),
  desc: z.string().min(1),
  loc: LocSchema,
  v311: Va.nullable(),
  v206: Va.nullable(),
  confirmed: z.boolean(),
  /** 对应的 VERIFY 条目与规则出处 */
  verify: z.string(),
  source: z.string(),
});

export const ConstantAnchorsSchema = z.strictObject({
  schema: z.literal('rich4.anchors-constants/1'),
  note: z.string(),
  reference: z.literal('v311'),
  constants: z.array(ConstantEntrySchema),
});

export type ConstantEntry = z.infer<typeof ConstantEntrySchema>;
export type ConstantAnchors = z.infer<typeof ConstantAnchorsSchema>;
export type ConstLoc = ConstantEntry['loc'];

export const CONSTANTS_FILE = path.join(PACKAGE_DIR, 'anchors', 'constants.json');

export function parseConstantAnchors(json: unknown, label = 'anchors/constants.json'): ConstantAnchors {
  const r = ConstantAnchorsSchema.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ExtractError('E_ANCHORS', `${label} 结构不符：${i ? `${i.path.join('.')}: ${i.message}` : ''}`);
  }
  const ids = new Set<string>();
  for (const c of r.data.constants) {
    if (ids.has(c.id)) throw new ExtractError('E_ANCHORS', `${label} 重复的 id：${c.id}`);
    ids.add(c.id);
    if (c.loc.kind === 'derived' && (c.v311 !== null || c.v206 !== null)) {
      throw new ExtractError('E_ANCHORS', `${label} ${c.id}：derived 项不应有 VA`);
    }
    if (c.loc.kind !== 'derived' && c.v311 === null)
      throw new ExtractError('E_ANCHORS', `${label} ${c.id}：缺 v311 VA`);
  }
  return r.data;
}

let cached: ConstantAnchors | null = null;

export function loadConstantAnchors(file = CONSTANTS_FILE): ConstantAnchors {
  if (file === CONSTANTS_FILE && cached) return cached;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ExtractError('E_ANCHORS', `读取 ${file} 失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const a = parseConstantAnchors(json);
  if (file === CONSTANTS_FILE) cached = a;
  return a;
}

// ───────────────────────── 读取 ─────────────────────────

export type ConstValue = number | number[];

export interface ReadResult {
  value: ConstValue | null;
  /** 实际读取的位置（数据项为数据 VA） */
  at: string | null;
  /** 附加信息：链首读取地址、浮点常量地址等 */
  extra: string | null;
  error: string | null;
}

const fail = (error: string, at: number | null = null): ReadResult => ({
  value: null,
  at: at === null ? null : hexVa(at),
  extra: null,
  error,
});

function readData(file: PeFile, va: number, type: string, count: number): number[] {
  const size = type.endsWith('8') ? 1 : type.endsWith('16') ? 2 : 4;
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const at = va + k * size;
    const u = size === 1 ? file.u8(at) : size === 2 ? file.u16(at) : file.u32(at);
    const signed = type.startsWith('i');
    out.push(signed ? (size === 1 ? (u << 24) >> 24 : size === 2 ? (u << 16) >> 16 : u | 0) : u);
  }
  return out;
}

/** 在一个版本上按位置读取常量（非 derived；refVa 只对 data 有意义） */
export function readConstant(code: CodeIndex, loc: ConstLoc, va: number, refVa: number | null = null): ReadResult {
  const file = code.file;
  try {
    switch (loc.kind) {
      case 'imm': {
        if (!code.isBoundary(va)) return fail('不是指令起点', va);
        const imms = immOperands(code.at(va));
        if (imms.length === 0) return fail('指令没有立即数', va);
        const o = loc.operand === undefined ? imms[imms.length - 1]! : imms[loc.operand];
        if (!o) return fail(`没有第 ${loc.operand} 个立即数`, va);
        return { value: o.value, at: hexVa(va), extra: null, error: null };
      }
      case 'mulChain': {
        if (!code.isBoundary(va)) return fail('不是指令起点', va);
        const r = mulChain(code, va, loc.length, loc.reg);
        return { value: r.factor, at: hexVa(va), extra: hexVa(r.source), error: null };
      }
      case 'f64':
      case 'f32': {
        if (!code.isBoundary(va)) return fail('不是指令起点', va);
        const m = memOperand(code.at(va));
        if (m?.dispSize !== 4) return fail('指令没有绝对地址内存操作数', va);
        const size = loc.kind === 'f64' ? 8 : 4;
        if (m.size !== size) return fail(`内存操作数宽度 ${m.size}（期望 ${size}）`, va);
        const bytes = file.slice(m.dispU, size);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, size);
        const v = size === 8 ? dv.getFloat64(0, true) : f32FromBits(dv.getUint32(0, true));
        return { value: v, at: hexVa(va), extra: hexVa(m.dispU), error: null };
      }
      case 'data': {
        let dataVa = va;
        if (refVa !== null) {
          if (!code.isBoundary(refVa)) return fail('引用指令不是指令起点', refVa);
          const i = code.at(refVa);
          const cand = [
            ...i.ops.filter((o) => o.t === 'mem' && o.dispSize === 4).map((o) => (o as { dispU: number }).dispU),
            ...immOperands(i).map((o) => o.value >>> 0),
          ].map((x) => x - (loc.refDelta ?? 0));
          if (!cand.includes(va)) return fail(`引用指令 ${hexVa(refVa)} 不指向 ${hexVa(va)}`, va);
          dataVa = va;
        }
        return { value: readData(file, dataVa, loc.type, loc.count), at: hexVa(dataVa), extra: null, error: null };
      }
      case 'derived':
        return fail('derived 不直接读取');
    }
  } catch (e) {
    return fail(e instanceof MulChainError || e instanceof ExtractError ? e.message : String(e), va);
  }
}

/** data 项在某版本的数据 VA：读引用指令的地址操作数（减去 refDelta） */
export function dataVaFromRef(code: CodeIndex, loc: Extract<ConstLoc, { kind: 'data' }>, refVa: number): number | null {
  if (!code.isBoundary(refVa)) return null;
  const i = code.at(refVa);
  const vals = [
    ...i.ops.filter((o) => o.t === 'mem' && o.dispSize === 4).map((o) => (o as { dispU: number }).dispU),
    ...immOperands(i).map((o) => o.value >>> 0),
  ].filter((v) => code.file.isImageAddress(v));
  return vals.length === 1 ? vals[0]! - (loc.refDelta ?? 0) : null;
}

// ───────────────────────── derived ─────────────────────────

type Arg = string | number | (string | number)[];

function argValue(a: Arg, get: (id: string) => ConstValue | null): ConstValue | null {
  if (typeof a === 'number') return a;
  if (typeof a === 'string') return get(a);
  const out: number[] = [];
  for (const x of a) {
    const v = typeof x === 'number' ? x : get(x);
    if (v === null || Array.isArray(v)) return null;
    out.push(v);
  }
  return out;
}

export function evalDerived(op: string, args: readonly Arg[], get: (id: string) => ConstValue | null): number | null {
  const vs = args.map((a) => argValue(a, get));
  if (vs.some((v) => v === null)) return null;
  const nums = (v: ConstValue | null): number[] => (Array.isArray(v) ? v : [v as number]);
  switch (op) {
    case 'sum':
      return nums(vs[0]!).reduce((s, x) => s + x, 0);
    case 'dot': {
      const [a, b] = [nums(vs[0]!), nums(vs[1]!)];
      if (a.length !== b.length) return null;
      return a.reduce((s, x, i) => s + x * b[i]!, 0);
    }
    case 'rangeCount': {
      // [start, end) 按 step 递增的项数
      const [start, end, step] = vs.map((v) => v as number) as [number, number, number];
      return step > 0 && end > start ? Math.ceil((end - start) / step) : null;
    }
    case 'pctGe': {
      // rand % mod >= threshold 的百分比
      const [mod, thr] = vs.map((v) => v as number) as [number, number];
      return mod > 0 ? ((mod - thr) * 100) / mod : null;
    }
    default:
      return null;
  }
}

// ───────────────────────── 两版解析 ─────────────────────────

export interface EditionCode {
  edition: ExeEdition;
  code: CodeIndex;
}

export interface ConstantResult {
  id: string;
  desc: string;
  kind: ConstLoc['kind'];
  expected: ConstValue;
  confirmed: boolean;
  verify: string;
  v311: { va: string | null; value: ConstValue | null; ok: boolean; extra: string | null; error: string | null };
  v206: {
    va: string | null;
    /** anchors 中登记的 v2.06 VA */
    anchored: string | null;
    /** 由 v3.11 迁移得到的 VA（null = 迁移失败或未尝试） */
    transferred: string | null;
    /** data 项：v2.06 中引用该数据的指令 VA */
    refVa: string | null;
    expected: ConstValue;
    value: ConstValue | null;
    ok: boolean;
    extra: string | null;
    error: string | null;
  } | null;
  /** 两版值相同 */
  same: boolean | null;
}

const eq = (a: ConstValue | null, b: ConstValue | null): boolean => {
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return a === b;
};

export interface ResolveOptions {
  /** 迁移失败时是否仍采用 anchors 中登记的 v2.06 VA（默认 true） */
  trustAnchored?: boolean;
  /** 两版地址换算（默认按唯一同文 Big5 串） */
  translate?: AddressTranslator;
  /** 'always'（默认）：每项都由 v3.11 迁移并与登记值比较；'missing'：登记了 v2.06 VA 的直接用登记值（exe tables 用，快） */
  transfer?: 'always' | 'missing';
}

/**
 * 在 v3.11（参考）与 v2.06 上解析全部常量。v2.06 的位置：先由 v3.11 迁移（transferInsn），
 * 与 anchors 登记值比较；迁移失败时退回登记值。derived 项在两版分别计算。
 */
export function resolveConstants(
  anchors: ConstantAnchors,
  ref: CodeIndex | null,
  dst: CodeIndex | null,
  opts: ResolveOptions = {},
): ConstantResult[] {
  const out: ConstantResult[] = [];
  const byId = new Map<string, ConstantResult>();
  const translate = opts.translate ?? (ref && dst ? stringTranslator(ref.file, dst.file) : undefined);
  const xfer = (va: number): { va: number | null } => {
    const t = transferInsn(ref!, dst!, va, translate ? { translate } : {});
    if (t.va !== null || !translate) return t;
    return alignTransfer(ref!, dst!, va, translate);
  };
  for (const c of anchors.constants) {
    if (c.loc.kind === 'derived') continue;
    const loc = c.loc;
    const v311Va = c.v311 === null ? null : Number.parseInt(c.v311, 16);
    const refVa311 = loc.kind === 'data' ? Number.parseInt(loc.ref, 16) : null;
    const r311 = ref && v311Va !== null ? readConstant(ref, loc, v311Va, refVa311) : null;
    let v206: ConstantResult['v206'] = null;
    if (dst) {
      const expected206 = c.v206Value ?? c.value;
      const anchored = c.v206 === null ? null : Number.parseInt(c.v206, 16);
      let transferred: number | null = null;
      let refVa206: number | null = null;
      const skip = opts.transfer === 'missing' && anchored !== null;
      if (loc.kind === 'data') {
        const t = ref && !skip ? xfer(refVa311!) : null;
        refVa206 = t?.va ?? (loc.ref206 ? Number.parseInt(loc.ref206, 16) : null);
        if (t?.va != null) transferred = dataVaFromRef(dst, loc, t.va);
      } else if (ref && v311Va !== null && !skip) {
        transferred = xfer(v311Va).va;
      }
      const use = transferred ?? (opts.trustAnchored === false ? null : anchored);
      const r = use === null ? null : readConstant(dst, loc, use, refVa206);
      v206 = {
        va: use === null ? null : hexVa(use),
        anchored: c.v206,
        transferred: transferred === null ? null : hexVa(transferred),
        refVa: refVa206 === null ? null : hexVa(refVa206),
        expected: expected206,
        value: r?.value ?? null,
        ok: r !== null && r.error === null && eq(r.value, expected206),
        extra: r?.extra ?? null,
        error: use === null ? '无法定位（迁移失败且 anchors 未登记）' : (r?.error ?? null),
      };
    }
    const res: ConstantResult = {
      id: c.id,
      desc: c.desc,
      kind: loc.kind,
      expected: c.value,
      confirmed: c.confirmed,
      verify: c.verify,
      v311: {
        va: c.v311,
        value: r311?.value ?? null,
        ok: r311 !== null && r311.error === null && eq(r311.value, c.value),
        extra: r311?.extra ?? null,
        error: ref ? (r311?.error ?? null) : '缺少 v3.11 exe',
      },
      v206,
      same: r311 && v206 ? eq(r311.value, v206.value) : null,
    };
    out.push(res);
    byId.set(c.id, res);
  }
  for (const c of anchors.constants) {
    if (c.loc.kind !== 'derived') continue;
    const loc = c.loc;
    const calc = (pick: (r: ConstantResult) => ConstValue | null) =>
      evalDerived(loc.op, loc.args, (id) => {
        const r = byId.get(id);
        return r ? pick(r) : null;
      });
    const v311 = ref ? calc((r) => r.v311.value) : null;
    const v206v = dst ? calc((r) => r.v206?.value ?? null) : null;
    const expected206 = c.v206Value ?? c.value;
    const res: ConstantResult = {
      id: c.id,
      desc: c.desc,
      kind: 'derived',
      expected: c.value,
      confirmed: c.confirmed,
      verify: c.verify,
      v311: { va: null, value: v311, ok: eq(v311, c.value), extra: null, error: ref ? null : '缺少 v3.11 exe' },
      v206: dst
        ? {
            va: null,
            anchored: null,
            transferred: null,
            refVa: null,
            expected: expected206,
            value: v206v,
            ok: eq(v206v, expected206),
            extra: null,
            error: null,
          }
        : null,
      same: ref && dst ? eq(v311, v206v) : null,
    };
    out.push(res);
    byId.set(c.id, res);
  }
  // 同名 source 的乘法链必须在同一版本内读同一地址（例如物价指数）
  const order = new Map(anchors.constants.map((c, i) => [c.id, i]));
  out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return out;
}

/** 同一 source 的乘法链读取地址是否一致（每版本、每 source 一条检查） */
export function chainSourceChecks(
  anchors: ConstantAnchors,
  results: readonly ConstantResult[],
): { edition: ExeEdition; source: string; addrs: string[]; ok: boolean }[] {
  const out: { edition: ExeEdition; source: string; addrs: string[]; ok: boolean }[] = [];
  const src = new Map(
    anchors.constants.filter((c) => c.loc.kind === 'mulChain').map((c) => [c.id, (c.loc as { source: string }).source]),
  );
  for (const ed of ['v311', 'v206'] as const) {
    const groups = new Map<string, Set<string>>();
    for (const r of results) {
      const s = src.get(r.id);
      if (!s) continue;
      const extra = ed === 'v311' ? r.v311.extra : (r.v206?.extra ?? null);
      if (extra === null) continue;
      const g = groups.get(s) ?? new Set<string>();
      g.add(extra);
      groups.set(s, g);
    }
    for (const [s, g] of groups) out.push({ edition: ed, source: s, addrs: [...g].sort(), ok: g.size === 1 });
  }
  return out;
}

export function constantsFailed(results: readonly ConstantResult[], editions: readonly ExeEdition[]): ConstantResult[] {
  return results.filter(
    (r) => (editions.includes('v311') && !r.v311.ok) || (editions.includes('v206') && (r.v206 === null || !r.v206.ok)),
  );
}
