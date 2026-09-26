import { Big5StringIndex, hexVa, type PeFile, patternFromBytes, patternToString } from '../pe/scan';
import { type CodeIndex, imageRefs } from './code';
import type { Insn } from './x86';

/**
 * 指令级迁移（data-pipeline.md §6.4 第 7 条「在 v2.06 上找到对应指令」）：
 * 以参考版本（v3.11）中目标指令为中心，取前后若干条指令的字节作模式，
 * 通配：映像内地址（imm32/disp32）、相对跳转/调用位移、目标指令自身的立即数（允许两版常量不同）；
 * 映像内地址若指向两版都唯一的同文 Big5 串，则换成目标版本的串地址参与精确匹配（区分结构相同的处理函数）；
 * 在目标版本代码节中搜索，要求唯一命中；窗口从小到大尝试，取第一个唯一命中的窗口。
 * 命中后再按指令边界与助记符复核（目标版本的对应位置必须是同一助记符的指令起点）。
 */

export interface InsnTransferResult {
  /** 参考版本指令 VA */
  from: string;
  /** 目标版本指令 VA；未唯一命中时为 null */
  va: number | null;
  /** 采用的窗口（前/后指令条数） */
  window: [number, number] | null;
  hits: number;
  pattern: string | null;
  detail: string;
}

export interface InsnTransferOptions {
  /** 依次尝试的窗口（前 n 条、后 m 条），默认从 4/4 到 24/24 */
  windows?: readonly (readonly [number, number])[];
  /** 目标指令的立即数是否也通配（默认 true：常量可能改动） */
  wildTargetImm?: boolean;
  /** 参考版本地址 → 目标版本地址（能换算的地址参与精确匹配，其余映像地址通配） */
  translate?: AddressTranslator;
}

export type AddressTranslator = (va: number) => number | null;

/** 两版都恰好出现一次的同文 Big5 串：参考 VA → 目标 VA */
export function stringTranslator(src: PeFile, dst: PeFile): AddressTranslator {
  return stringMapping(src, dst).translate;
}

/** 同 stringTranslator，另给出目标版本中被映射到的串地址集合 */
export function stringMapping(src: PeFile, dst: PeFile): { translate: AddressTranslator; targets: Set<number> } {
  const a = Big5StringIndex.build(src);
  const b = Big5StringIndex.build(dst);
  const count = (idx: Big5StringIndex) => {
    const m = new Map<string, number[]>();
    for (const e of idx.entries()) {
      const l = m.get(e.text);
      if (l) l.push(e.va);
      else m.set(e.text, [e.va]);
    }
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  const map = new Map<number, number>();
  for (const [text, vas] of ca) {
    const other = cb.get(text);
    if (vas.length === 1 && other?.length === 1) map.set(vas[0]!, other[0]!);
  }
  return { translate: (va) => map.get(va) ?? null, targets: new Set(map.values()) };
}

const DEFAULT_WINDOWS: readonly (readonly [number, number])[] = [
  [3, 4],
  [4, 6],
  [6, 8],
  [8, 10],
  [12, 12],
  [16, 16],
  [24, 24],
];

/** 由指令序列构造模式；返回模式与目标指令在模式内的字节偏移 */
export function insnPattern(
  code: CodeIndex,
  insns: readonly Insn[],
  target: number,
  wildTargetImm: boolean,
  translate?: AddressTranslator,
): { bytes: Uint8Array; mask: Uint8Array; targetOff: number } {
  const total = insns.reduce((s, i) => s + i.len, 0);
  const bytes = new Uint8Array(total);
  const mask = new Uint8Array(total).fill(1);
  let pos = 0;
  let targetOff = -1;
  for (const i of insns) {
    bytes.set(i.bytes, pos);
    if (i.va === target) targetOff = pos;
    const translated = new Set<number>();
    for (const r of imageRefs(code.file, i)) {
      const t = translate?.(r.value) ?? null;
      if (t === null) mask.fill(0, pos + r.off, pos + r.off + 4);
      else {
        new DataView(bytes.buffer).setUint32(pos + r.off, t >>> 0, true);
        translated.add(r.off);
      }
    }
    for (const o of i.ops) {
      if (o.t === 'rel') mask.fill(0, pos + o.off, pos + o.off + o.size);
      if (i.va === target && wildTargetImm && o.t === 'imm' && o.off >= 0 && !translated.has(o.off)) {
        mask.fill(0, pos + o.off, pos + o.off + o.size);
      }
    }
    pos += i.len;
  }
  return { bytes, mask, targetOff };
}

export function transferInsn(
  src: CodeIndex,
  dst: CodeIndex,
  va: number,
  opts: InsnTransferOptions = {},
): InsnTransferResult {
  const base: InsnTransferResult = { from: hexVa(va), va: null, window: null, hits: 0, pattern: null, detail: '' };
  if (!src.isBoundary(va)) return { ...base, detail: `${hexVa(va)} 不是参考版本的指令起点` };
  const target = src.at(va);
  const wild = opts.wildTargetImm ?? true;
  let last = base;
  for (const [b, a] of opts.windows ?? DEFAULT_WINDOWS) {
    const win = src.window(va, b, a + 1);
    const p = insnPattern(src, win, va, wild, opts.translate);
    const hits = dst.file.findPattern({ bytes: p.bytes, mask: p.mask }, 'code');
    last = {
      ...base,
      window: [b, a],
      hits: hits.length,
      pattern: patternToString(
        patternFromBytes(
          p.bytes,
          Array.from(p.mask, (m) => m === 0),
        ),
      ),
      detail: `窗口 ${b}/${a} 命中 ${hits.length} 处`,
    };
    if (hits.length === 0) return { ...last, detail: `${last.detail}（目标版本代码不同）` };
    if (hits.length > 1) continue;
    const at = hits[0]! + p.targetOff;
    if (!dst.isBoundary(at)) return { ...last, detail: `${last.detail}，但 ${hexVa(at)} 不是目标版本的指令起点` };
    const got = dst.at(at);
    if (got.mnem !== target.mnem || got.len !== target.len) {
      return { ...last, detail: `${last.detail}，但 ${hexVa(at)} 是 ${got.mnem}（期望 ${target.mnem}）` };
    }
    return { ...last, va: at, detail: `窗口 ${b}/${a} 唯一命中` };
  }
  return { ...last, detail: `${last.detail}（最大窗口仍不唯一）` };
}

// ───────────────────────── 锚点 + 序列对齐（字节模式失败时的回退） ─────────────────────────

/**
 * 规范化指令记号：助记符 + 操作数「形状」（寄存器名、内存的基址/变址/比例、是否有位移），
 * 不含立即数与位移数值——两版栈帧大小不同（例如 sprintf 缓冲 0x80 vs 0x50）会改变位移与编码长度。
 */
export function shapeToken(i: Insn): string {
  const ops = i.ops.map((o) => {
    switch (o.t) {
      case 'reg':
        return o.name;
      case 'imm':
        return 'I';
      case 'rel':
        return 'J';
      default:
        return `${o.size}[${o.base ?? ''}${o.index ? `+${o.index}*${o.scale}` : ''}${o.dispSize > 0 ? '+D' : ''}]`;
    }
  });
  return `${i.mnem} ${ops.join(',')}`;
}

/** 最长公共子序列对齐：返回 a 下标 → b 下标 */
export function lcsAlign(a: readonly string[], b: readonly string[]): Map<number, number> {
  const n = a.length;
  const m = b.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        a[i] === b[j]
          ? dp[(i + 1) * (m + 1) + j + 1]! + 1
          : Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + j + 1]!);
    }
  }
  const out = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.set(i, j);
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j]! >= dp[i * (m + 1) + j + 1]!) i++;
    else j++;
  }
  return out;
}

export interface AlignTransferResult {
  va: number | null;
  /** 采用的锚点（参考版本 → 目标版本） */
  anchor: [string, string] | null;
  detail: string;
}

/** 单条引用可换算地址（唯一 Big5 串）的指令在目标版本中的唯一位置 */
function anchorIn(src: CodeIndex, dst: CodeIndex, i: Insn, translate: AddressTranslator): number | null {
  const refs = imageRefs(src.file, i);
  if (!refs.some((r) => translate(r.value) !== null)) return null;
  const p = insnPattern(src, [i], i.va, false, translate);
  // 位移（栈偏移等）也通配，只保留操作码与换算后的地址
  for (const o of i.ops) {
    if (o.t === 'mem' && o.dispSize > 0 && !refs.some((r) => r.off === o.dispOff && translate(r.value) !== null)) {
      p.mask.fill(0, o.dispOff, o.dispOff + o.dispSize);
    }
  }
  const hits = dst.file.findPattern({ bytes: p.bytes, mask: p.mask }, 'code').filter((h) => dst.isBoundary(h));
  return hits.length === 1 ? hits[0]! : null;
}

/** 锚点：引用唯一 Big5 串的单条指令，或小窗口字节模式（含立即数）唯一命中的指令 */
function findAnchor(src: CodeIndex, dst: CodeIndex, i: Insn, translate: AddressTranslator): number | null {
  const byString = anchorIn(src, dst, i, translate);
  if (byString !== null) return byString;
  if (i.len < 3) return null;
  const t = transferInsn(src, dst, i.va, {
    translate,
    wildTargetImm: false,
    windows: [
      [2, 3],
      [3, 4],
      [4, 6],
    ],
  });
  return t.va;
}

/**
 * 回退迁移：在目标指令前后 maxDist 条内找锚点（引用唯一 Big5 串的指令，或小窗口字节模式唯一命中的指令），
 * 定位其在目标版本的位置，然后对锚点两侧各 span 条指令做规范化记号的 LCS 对齐，取目标指令的对齐位置；
 * 依次尝试最近的若干锚点，要求结果一致。
 */
export function alignTransfer(
  src: CodeIndex,
  dst: CodeIndex,
  va: number,
  translate: AddressTranslator,
  opts: { maxDist?: number; span?: number; anchors?: number } = {},
): AlignTransferResult {
  if (!src.isBoundary(va)) return { va: null, anchor: null, detail: `${hexVa(va)} 不是参考版本的指令起点` };
  const maxDist = opts.maxDist ?? 160;
  const span = opts.span ?? 200;
  const want = opts.anchors ?? 2;
  const ti = src.indexOf(va);
  const target = src.at(va);
  const results: { va: number; anchor: [string, string] }[] = [];
  for (let d = 1; d <= maxDist && results.length < want; d++) {
    for (const k of [ti - d, ti + d]) {
      if (k < 0 || k >= src.starts.length || results.length >= want) continue;
      const ai = src.at(src.starts[k]!);
      const at = findAnchor(src, dst, ai, translate);
      if (at === null) continue;
      const sa = src.window(ai.va, span, span + 1);
      const da = dst.window(at, span, span + 1);
      const map = lcsAlign(sa.map(shapeToken), da.map(shapeToken));
      const idx = sa.findIndex((x) => x.va === va);
      const aIdx = sa.findIndex((x) => x.va === ai.va);
      const j = idx < 0 ? undefined : map.get(idx);
      // 锚点本身也必须对齐到其目标版本位置，否则这次对齐不可信
      if (j === undefined || map.get(aIdx) === undefined || da[map.get(aIdx)!]!.va !== at) continue;
      const got = da[j]!;
      if (got.mnem !== target.mnem) continue;
      results.push({ va: got.va, anchor: [hexVa(ai.va), hexVa(at)] });
    }
  }
  if (results.length === 0) return { va: null, anchor: null, detail: `前后 ${maxDist} 条内没有可用锚点或对齐失败` };
  const vas = new Set(results.map((r) => r.va));
  if (vas.size > 1) {
    return { va: null, anchor: null, detail: `锚点对齐结果不一致：${[...vas].map(hexVa).join(' / ')}` };
  }
  const r = results[0]!;
  return {
    va: r.va,
    anchor: r.anchor,
    detail: `锚点 ${r.anchor[0]}→${r.anchor[1]} 对齐（${results.length} 个锚点一致）`,
  };
}
