import { hexVa } from '../pe/scan';
import { type CodeIndex, disasmFunction } from './code';
import { type AddressTranslator, lcsAlign, shapeToken } from './insnTransfer';
import { formatInsn, type Insn, relTarget } from './x86';

/**
 * 函数级对比（data-pipeline.md §6.4）：
 * 1. 种子配对：同名指针表 / 跳表的第 k 项、常量锚点所在函数；
 * 2. 函数体：递归下降（不进入同一张表的其他入口）；
 * 3. 规范化：助记符 + 操作数；栈上位移（esp/ebp 基址）记为 D、栈帧调整（sub/add esp, N）记为 F、
 *    映像内地址能换算为同文 Big5 串的记为串地址（按目标版本地址比较）、
 *    其他映像地址记为 A、相对跳转记为 J；其余立即数与结构体偏移保留数值；
 * 4. 比较：形状（shapeToken，不含数值）序列相同 → 逐条比较完整记号：全同 = same，只有数值不同 = const（列出差异）；
 *    形状不同 → struct，给 LCS 相似度，并列出对齐位置上的数值差异；
 * 5. 扩散：same / const 的函数中，对齐位置上的 call 目标成为新配对（深度受限）。
 */

export type FuncClass = 'same' | 'const' | 'struct';

export interface FuncSeed {
  system: string;
  label: string;
  v311: number;
  v206: number;
  /** 不跟随进入的地址（同表其他入口） */
  stop311?: ReadonlySet<number>;
  stop206?: ReadonlySet<number>;
}

export interface FuncDiff {
  system: string;
  label: string;
  v311: string;
  v206: string;
  class: FuncClass;
  /** 形状序列的 LCS 相似度 2L/(n+m) */
  similarity: number;
  insns: [number, number];
  /** 数值差异（「v3.11 指令 → v2.06 指令」），不含表现层差异 */
  diffs: string[];
  /** 表现层差异条数：资源号整体偏移（push 常数相差 0x29）、资源按名/按号加载的参数差异 */
  presentation: number;
  /** 由扩散得到（非种子） */
  propagated: boolean;
}

const isStack = (r: string | null) => r === 'esp' || r === 'ebp';

/** 完整记号：side = 'ref' 时映像地址先经 translate 换算到目标版本 */
export function fullToken(
  code: CodeIndex,
  i: Insn,
  side: 'ref' | 'dst',
  translate: AddressTranslator,
  dstStrings: ReadonlySet<number>,
): string {
  const addr = (v: number): string => {
    if (side === 'ref') {
      const t = translate(v);
      return t === null ? 'A' : `S${hexVa(t)}`;
    }
    return dstStrings.has(v) ? `S${hexVa(v)}` : 'A';
  };
  // 栈帧大小（sub/add esp, N）两版常不同（局部缓冲 0x80 vs 0x50），不算规则差异
  if ((i.mnem === 'sub' || i.mnem === 'add') && i.ops[0]?.t === 'reg' && i.ops[0].name === 'esp')
    return `${i.mnem} esp,F`;
  const ops = i.ops.map((o) => {
    switch (o.t) {
      case 'reg':
        return o.name;
      case 'rel':
        return 'J';
      case 'imm':
        return o.size === 4 && code.file.isImageAddress(o.value >>> 0) ? addr(o.value >>> 0) : String(o.value);
      default: {
        let d = '';
        if (o.dispSize > 0) {
          if (isStack(o.base)) d = '+D';
          else if (o.dispSize === 4 && code.file.isImageAddress(o.dispU)) d = `+${addr(o.dispU)}`;
          else d = `+${o.disp}`;
        }
        return `${o.size}[${o.base ?? ''}${o.index ? `+${o.index}*${o.scale}` : ''}${d}]`;
      }
    }
  });
  return `${i.mnem} ${ops.join(',')}`;
}

export interface FuncDiffOptions {
  translate: AddressTranslator;
  /** 目标版本中可换算的串地址集合（translate 的值域） */
  dstStrings: ReadonlySet<number>;
  /** 扩散深度（0 = 不扩散） */
  depth?: number;
  maxFuncs?: number;
}

function compare(
  ref: CodeIndex,
  dst: CodeIndex,
  a: Insn[],
  b: Insn[],
  opts: FuncDiffOptions,
): { cls: FuncClass; similarity: number; diffs: string[]; presentation: number; aligned: [number, number][] } {
  const sa = a.map(shapeToken);
  const sb = b.map(shapeToken);
  const fa = a.map((i) => fullToken(ref, i, 'ref', opts.translate, opts.dstStrings));
  const fb = b.map((i) => fullToken(dst, i, 'dst', opts.translate, opts.dstStrings));
  const sameShape = sa.length === sb.length && sa.every((t, k) => t === sb[k]);
  const aligned: [number, number][] = [];
  if (sameShape) {
    for (let k = 0; k < a.length; k++) aligned.push([k, k]);
  } else {
    const map = lcsAlign(sa, sb);
    for (const [i, j] of [...map.entries()].sort((x, y) => x[0] - y[0])) aligned.push([i, j]);
  }
  const lcs = aligned.length;
  const diffs: string[] = [];
  let presentation = 0;
  for (const [kx, ky] of aligned) {
    if (fa[kx] === fb[ky]) continue;
    const x = a[kx]!;
    const y = b[ky]!;
    if (isPresentationDiff(ref, dst, x, y)) presentation++;
    else diffs.push(`${hexVa(x.va)} ${formatInsn(x)} → ${hexVa(y.va)} ${formatInsn(y)}`);
  }
  const n = sa.length + sb.length;
  const similarity = n === 0 ? 1 : Math.round(((2 * lcs) / n) * 1000) / 1000;
  const cls: FuncClass = sameShape ? (diffs.length + presentation === 0 ? 'same' : 'const') : 'struct';
  return { cls, similarity, diffs, presentation, aligned };
}

/** v3.11 资源号比 v2.06 整体大 0x29（map.mkf 资源数不同）；v2.06 另有按文件名（数据地址）加载资源的参数 */
export const RESOURCE_SHIFT = 0x29;

function isPresentationDiff(ref: CodeIndex, dst: CodeIndex, x: Insn, y: Insn): boolean {
  if (x.mnem !== y.mnem || x.ops.length !== y.ops.length) return false;
  const ix = x.ops.findIndex((o) => o.t === 'imm');
  const iy = y.ops.findIndex((o) => o.t === 'imm');
  if (ix < 0 || ix !== iy) return false;
  const vx = (x.ops[ix] as { value: number }).value;
  const vy = (y.ops[iy] as { value: number }).value;
  if (vx - vy === RESOURCE_SHIFT && vy >= 0x100 && vx < 0x400) return true;
  const ax = ref.file.isImageAddress(vx >>> 0);
  const ay = dst.file.isImageAddress(vy >>> 0);
  return x.mnem === 'push' && ax !== ay && (ax ? vy : vx) < 0x100;
}

export interface FuncDiffReport {
  seeds: number;
  /** 两版入口都有效的种子数 */
  paired: number;
  results: FuncDiff[];
  /** 扩散新增的配对数 */
  propagated: number;
}

export function funcDiff(
  ref: CodeIndex,
  dst: CodeIndex,
  seeds: readonly FuncSeed[],
  opts: FuncDiffOptions,
): FuncDiffReport {
  const results: FuncDiff[] = [];
  const done = new Set<string>();
  const queue: { seed: FuncSeed; depth: number; propagated: boolean }[] = [];
  let paired = 0;
  for (const s of seeds) {
    if (!ref.inCode(s.v311) || !dst.inCode(s.v206)) continue;
    paired++;
    queue.push({ seed: s, depth: 0, propagated: false });
  }
  const maxDepth = opts.depth ?? 1;
  const maxFuncs = opts.maxFuncs ?? 1500;
  let propagated = 0;
  const pending = new Set<string>();
  while (queue.length > 0 && results.length < maxFuncs) {
    const { seed, depth, propagated: prop } = queue.shift()!;
    const key = `${seed.v311}:${seed.v206}`;
    if (done.has(key)) continue;
    done.add(key);
    const a = disasmFunction(ref, seed.v311, {
      ...(seed.stop311 ? { stopAt: seed.stop311 } : {}),
      maxInsns: 4000,
    }).insns;
    const b = disasmFunction(dst, seed.v206, {
      ...(seed.stop206 ? { stopAt: seed.stop206 } : {}),
      maxInsns: 4000,
    }).insns;
    const c = compare(ref, dst, a, b, opts);
    results.push({
      system: seed.system,
      label: seed.label,
      v311: hexVa(seed.v311),
      v206: hexVa(seed.v206),
      class: c.cls,
      similarity: c.similarity,
      insns: [a.length, b.length],
      diffs: c.diffs,
      presentation: c.presentation,
      propagated: prop,
    });
    if (depth >= maxDepth) continue;
    for (const [kx, ky] of c.aligned) {
      const x = a[kx]!;
      const y = b[ky]!;
      if (x.mnem !== 'call' || y.mnem !== 'call') continue;
      const tx = relTarget(x);
      const ty = relTarget(y);
      if (tx === null || ty === null || !ref.inCode(tx) || !dst.inCode(ty)) continue;
      if (done.has(`${tx}:${ty}`) || pending.has(`${tx}:${ty}`)) continue;
      pending.add(`${tx}:${ty}`);
      propagated++;
      queue.push({
        seed: { system: `${seed.system}·callee`, label: `${seed.label} → ${hexVa(tx)}`, v311: tx, v206: ty },
        depth: depth + 1,
        propagated: true,
      });
    }
  }
  return { seeds: seeds.length, paired, results, propagated };
}

// ───────────────────────── 种子 ─────────────────────────

export interface SeedSource {
  eventTables: {
    newsHandlers: string[];
    fateHandlers: string[];
    magicEffectJump: string[];
    magicCondJump: string[];
    helpers: Record<string, string | null>;
  } | null;
}

/** 不大于 va 的最近入口（call 目标 ∪ 额外入口） */
function enclosing(code: CodeIndex, extra: readonly number[], va: number): number | null {
  const a = code.enclosingEntry(va);
  let best = a;
  for (const e of extra) if (e <= va && (best === null || e > best)) best = e;
  return best;
}

/** 常量 id → 系统名 */
export function systemOf(id: string): string {
  const head = id.split('.')[0]!;
  if (head === 'news' || head === 'fate') return head;
  if (head === 'magic' || id.startsWith('ai.magic')) return 'magic';
  if (['penguin', 'balloon', 'xicong', 'minigame'].includes(head)) return 'minigame';
  if (head === 'ai') return 'ai';
  return 'rules';
}

/**
 * 种子：新闻 36、命运 49、魔法屋效果 12 与条件 12（按表下标配对，函数体不进入同组其他入口）、
 * 两版都识别出的辅助函数，以及每个常量锚点在两版中所在函数（不大于该 VA 的最近 call 目标或表入口）。
 */
export function buildFuncSeeds(
  ref: CodeIndex,
  dst: CodeIndex,
  a: SeedSource,
  b: SeedSource,
  constants: readonly { id: string; v311: string | null; v206: string | null }[],
): FuncSeed[] {
  const seeds: FuncSeed[] = [];
  const parse = (xs: readonly string[]) => xs.map((x) => Number.parseInt(x, 16));
  const extra311: number[] = [];
  const extra206: number[] = [];
  if (a.eventTables && b.eventTables) {
    const all311 = new Set<number>();
    const all206 = new Set<number>();
    const groups: [string, string, number[], number[]][] = [];
    for (const [system, key] of [
      ['news', 'newsHandlers'],
      ['fate', 'fateHandlers'],
      ['magic', 'magicEffectJump'],
      ['magic', 'magicCondJump'],
    ] as const) {
      const x = parse(a.eventTables[key]);
      const y = parse(b.eventTables[key]);
      for (const v of x) all311.add(v);
      for (const v of y) all206.add(v);
      groups.push([system, key, x, y]);
    }
    extra311.push(...all311);
    extra206.push(...all206);
    for (const [system, key, x, y] of groups) {
      const n = Math.min(x.length, y.length);
      for (let k = 0; k < n; k++) {
        seeds.push({
          system,
          label: `${key}[${k}]`,
          v311: x[k]!,
          v206: y[k]!,
          stop311: new Set([...all311].filter((v) => v !== x[k])),
          stop206: new Set([...all206].filter((v) => v !== y[k])),
        });
      }
    }
  }
  const seen = new Set(seeds.map((s) => `${s.v311}:${s.v206}`));
  if (a.eventTables && b.eventTables) {
    for (const [name, x] of Object.entries(a.eventTables.helpers)) {
      const y = b.eventTables.helpers[name];
      if (!x || !y) continue;
      const key = `${Number.parseInt(x, 16)}:${Number.parseInt(y, 16)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seeds.push({ system: 'helper', label: name, v311: Number.parseInt(x, 16), v206: Number.parseInt(y, 16) });
    }
  }
  for (const c of constants) {
    if (c.v311 === null || c.v206 === null) continue;
    const va = Number.parseInt(c.v311, 16);
    const vb = Number.parseInt(c.v206, 16);
    if (!ref.inCode(va) || !dst.inCode(vb)) continue;
    const ea = enclosing(ref, extra311, va);
    const eb = enclosing(dst, extra206, vb);
    if (ea === null || eb === null) continue;
    const key = `${ea}:${eb}`;
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push({ system: systemOf(c.id), label: `${c.id} 所在函数`, v311: ea, v206: eb });
  }
  return seeds;
}

export interface SystemSummary {
  system: string;
  functions: number;
  same: number;
  const: number;
  struct: number;
  minSimilarity: number;
}

export function summarizeFuncDiff(r: FuncDiffReport): SystemSummary[] {
  const m = new Map<string, SystemSummary>();
  for (const x of r.results) {
    const s = m.get(x.system) ?? { system: x.system, functions: 0, same: 0, const: 0, struct: 0, minSimilarity: 1 };
    s.functions++;
    s[x.class]++;
    s.minSimilarity = Math.min(s.minSimilarity, x.similarity);
    m.set(x.system, s);
  }
  return [...m.values()].sort((x, y) => (x.system < y.system ? -1 : 1));
}
