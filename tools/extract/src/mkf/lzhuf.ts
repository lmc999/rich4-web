/**
 * 《大富翁4》MKF 私有压缩（LZHUF 变体）的严格解压。
 *
 * 移植自 test/lzhuf-proto.ts（本项目调研原型）。规格：docs/research/original-assets/containers.md §3、
 * docs/design/original-skin.md §3「其他采纳的修正」第 1 条。
 * 表（DHI/DLEN/初始树）全部按规则生成，不含任何外部项目的代码或数表；
 * 与用户自有 exe 的逐字节核对见 test/local/lzhuf.local.test.ts（v2.06 VA 0x480710/0x480810/0x480910 各只命中一处）。
 *
 * 算法
 * - 自适应哈夫曼：NCHAR=321 个符号（0..255 字面字节；256..320 表示长度 s−253 = 3..67 的回溯），
 *   T=641 个树位置按频率有序，根在 ROOT=640；叶子 s 的位置记在 prnt[T+s]。比特序 LSB-first。
 * - 距离 12 位：**窥视** 8 位 b，只消耗 DLEN[b]（3..8）位得到高 6 位 DHI[b]，再读 6 位作低 6 位；
 *   dist = DHI[b]<<6 | lo6；复制源 = 输出位置 − 1 − dist，逐字节复制（允许重叠）。dist==0xFFF 为结束标记。
 * - freq[ROOT] 达到 0x8000 时先「减半」：频率为奇数的叶子先 bump 一次，再全体右移一位。
 *
 * 严格模式（默认）在原版行为之上额外校验（原版只靠结束标记停止，不检查长度）：
 * 输出恰好写满 size；写满后的下一个符号必须是结束标记；ceil(含结束标记的比特数/8) == 源字节数；
 * 回溯不越过输出起点、不越过输出末尾；不读取越过源数据末尾的比特。
 */
import { ExtractError } from '../context';

export const LZHUF_NCHAR = 321;
/** 树位置总数 = 2·NCHAR − 1 */
export const LZHUF_T = 641;
export const LZHUF_ROOT = 640;
/** 结束标记的距离值 */
export const LZHUF_END_DIST = 0xfff;
/** 频率减半阈值（根频率） */
export const LZHUF_RESCALE_AT = 0x8000;
/** 回溯长度 = 符号 − 253（3..67） */
export const LZHUF_MATCH_BIAS = 253;
/** 原版内存布局中初始树的字节数：freq[642] | son[641] | prnt[641] | prnt_leaf[322]，均为 u16 */
export const LZHUF_TREE_IMAGE_BYTES = (LZHUF_T + 1 + LZHUF_T + LZHUF_T + LZHUF_NCHAR + 1) * 2;

export type LzhufErrorCode =
  | 'E_LZHUF_SRC_OVERRUN'
  | 'E_LZHUF_BACKREF'
  | 'E_LZHUF_OUTPUT_OVERRUN'
  | 'E_LZHUF_EARLY_END'
  | 'E_LZHUF_NO_END'
  | 'E_LZHUF_STORED_MISMATCH'
  | 'E_LZHUF_ARGS';

export class LzhufError extends ExtractError {
  readonly lzhufCode: LzhufErrorCode;
  constructor(code: LzhufErrorCode, message: string) {
    super(code, message);
    this.name = 'LzhufError';
    this.lzhufCode = code;
  }
}

// ───────────────────────── 表（按规则生成） ─────────────────────────

export interface LzhufDistanceTables {
  /** 前缀比特数 3..8，按 LSB-first 窥视到的 8 位 b 索引 */
  readonly dlen: Uint8Array;
  /** 距离高 6 位 */
  readonly dhi: Uint8Array;
}

/**
 * 距离前缀表（docs/research/g_map.md §6.3 的生成规则）。b 的低 4 位 lo 决定前缀长度，
 * 高 4 位 blk 的低若干位与 lo 共同决定高 6 位：
 *   lo==0          → LEN 8, HI = 63 − blk
 *   lo∈{7,15}      → LEN 3, HI = 0
 *   lo∈{3,11,13}   → LEN 4, HI = 3 − rank(lo)
 *   lo∈{1,5,9,14}  → LEN 5, HI = 11 − 4·(blk mod 2) − rank(lo)
 *   lo∈{2,6,10}    → LEN 6, HI = 23 − 3·(blk mod 4) − rank(lo)
 *   lo∈{4,8,12}    → LEN 7, HI = 47 − 3·(blk mod 8) − rank(lo)
 * rank(lo) 为 lo 在所属集合中的序号（按上面列出的顺序，从 0 起）。
 * 各长度的码字数 1/3/8/12/24/16 满足 Kraft 等式，是完备前缀码。
 */
export function buildDistanceTables(): LzhufDistanceTables {
  const dlen = new Uint8Array(256);
  const dhi = new Uint8Array(256);
  const groups: readonly (readonly [len: number, los: readonly number[], top: number, span: number, step: number])[] = [
    [4, [3, 11, 13], 3, 1, 0],
    [5, [1, 5, 9, 14], 11, 2, 4],
    [6, [2, 6, 10], 23, 4, 3],
    [7, [4, 8, 12], 47, 8, 3],
  ];
  for (let b = 0; b < 256; b++) {
    const blk = b >> 4;
    const lo = b & 15;
    if (lo === 0) {
      dlen[b] = 8;
      dhi[b] = 63 - blk;
      continue;
    }
    if (lo === 7 || lo === 15) {
      dlen[b] = 3;
      dhi[b] = 0;
      continue;
    }
    const g = groups.find(([, los]) => los.includes(lo));
    if (!g) throw new Error(`LZHUF 距离表规则未覆盖 lo=${lo}`);
    const [len, los, top, span, step] = g;
    dlen[b] = len;
    dhi[b] = top - step * (blk % span) - los.indexOf(lo);
  }
  return { dlen, dhi };
}

export interface LzhufInitialTree {
  /** freq[0..641]，freq[641] = 0xFFFF 为哨兵 */
  readonly freq: Uint16Array;
  /** son[0..640]：树位置（不乘 2） */
  readonly son: Uint16Array;
  /** prnt[0..962]：0..640 为内部父位置，641+s 为叶子 s 的位置，prnt[962] = 0 */
  readonly prnt: Uint16Array;
}

/**
 * 初始树：叶子 s（0..320）位于位置 s、频率 1；内部节点 321+k 的两个儿子位于 2k、2k+1；根 640 的父为 0。
 */
export function buildInitialTree(): LzhufInitialTree {
  const T = LZHUF_T;
  const N = LZHUF_NCHAR;
  const freq = new Uint16Array(T + 1);
  const son = new Uint16Array(T);
  const prnt = new Uint16Array(T + N + 1);
  for (let s = 0; s < N; s++) {
    freq[s] = 1;
    son[s] = s + T;
    prnt[T + s] = s;
  }
  for (let j = N; j < T; j++) {
    const k = j - N;
    freq[j] = freq[2 * k]! + freq[2 * k + 1]!;
    son[j] = 2 * k;
  }
  freq[T] = 0xffff;
  for (let i = 0; i < LZHUF_ROOT; i++) prnt[i] = N + (i >> 1);
  prnt[LZHUF_ROOT] = 0;
  prnt[T + N] = 0;
  return { freq, son, prnt };
}

/**
 * 初始树按原版内存布局序列化（4492 字节，小端 u16）：freq 原值；son 与 prnt 存「位置×2」（原版按字节偏移索引 u16 数组）。
 * 仅用于与用户自有 exe 核对。
 */
export function initialTreeImage(tree: LzhufInitialTree = INITIAL_TREE): Uint8Array {
  const out = new Uint8Array(LZHUF_TREE_IMAGE_BYTES);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const v of tree.freq) {
    dv.setUint16(o, v, true);
    o += 2;
  }
  for (const arr of [tree.son, tree.prnt]) {
    for (const v of arr) {
      dv.setUint16(o, v * 2, true);
      o += 2;
    }
  }
  return out;
}

const DIST = buildDistanceTables();
const INITIAL_TREE = buildInitialTree();

// ───────────────────────── 解压 ─────────────────────────

export interface LzhufStats {
  /** 写满（或到 limit）时消耗的比特数，不含结束标记 */
  bitsUsed: number;
  /** 含结束标记的总比特数（严格模式且解满时才有） */
  bitsWithEnd: number | null;
  literals: number;
  matches: number;
  rescales: number;
}

export interface LzhufOptions {
  /** 默认 true：校验结束标记与 ceil(bits/8)==src.length，回溯越过输出末尾即报错 */
  strict?: boolean;
  /** 只解出前 limit 字节（用于按魔数分类）；小于 size 时不做结束标记校验 */
  limit?: number;
  /** 传入时回填统计 */
  stats?: LzhufStats;
}

/**
 * 解压 src 得到恰好 size 字节。任何不符合规格的输入都抛 LzhufError（code 见 LzhufErrorCode）。
 * 热路径是模块级函数、状态放在对象里（避免闭包捕获可变变量拖慢 JIT）；9 个 MKF 的 440 个压缩资源全量解压约 2 秒。
 */
export function lzhufDecompress(src: Uint8Array, size: number, opts: LzhufOptions = {}): Uint8Array {
  if (!Number.isInteger(size) || size < 0) throw new LzhufError('E_LZHUF_ARGS', `非法的输出长度 ${size}`);
  const limit = Math.min(size, opts.limit ?? size);
  if (!Number.isInteger(limit) || limit < 0) throw new LzhufError('E_LZHUF_ARGS', `非法的 limit ${opts.limit}`);
  const strict = opts.strict ?? true;
  const full = limit === size;
  const st: DecoderState = newState();
  const out = new Uint8Array(limit);
  let op = 0;
  let literals = 0;
  let matches = 0;

  while (op < limit) {
    const s = decodeSymbol(src, st, op, size);
    if (s < 256) {
      out[op++] = s;
      literals++;
      continue;
    }
    const dist = readDistance(src, st, op, size);
    if (dist === LZHUF_END_DIST) {
      throw new LzhufError('E_LZHUF_EARLY_END', `结束标记提前出现：输出 ${op}/${size}`);
    }
    let n = s - LZHUF_MATCH_BIAS;
    let p = op - 1 - dist;
    if (p < 0) throw new LzhufError('E_LZHUF_BACKREF', `回溯越过输出起点：输出 ${op} 距离 ${dist}`);
    // 原版用 rep movsb 会越界写；严格模式下视为损坏。非严格模式截断到输出末尾。
    if (strict && op + n > size) {
      throw new LzhufError('E_LZHUF_OUTPUT_OVERRUN', `回溯越过输出末尾：输出 ${op}+${n} > ${size}`);
    }
    if (n > limit - op) n = limit - op;
    matches++;
    while (n-- > 0) out[op++] = out[p++]!;
  }

  const bitsUsed = st.pos;
  let bitsWithEnd: number | null = null;
  if (strict && full) {
    // 原版不检查长度、只靠结束标记停止：写满后再解一个符号，必须恰好是结束标记
    let dist = -1;
    let s: number;
    try {
      s = decodeSymbol(src, st, op, size);
      if (s >= 256) dist = readDistance(src, st, op, size);
    } catch (e) {
      if (e instanceof LzhufError) {
        throw new LzhufError('E_LZHUF_NO_END', `输出已满 ${size} 字节，但结束标记缺失或不完整（${e.message}）`);
      }
      throw e;
    }
    if (s < 256) throw new LzhufError('E_LZHUF_NO_END', `输出已满 ${size} 字节，下一个符号是字面量 ${s}`);
    if (dist !== LZHUF_END_DIST) {
      throw new LzhufError('E_LZHUF_NO_END', `输出已满 ${size} 字节，下一个符号是回溯（距离 ${dist}）而非结束标记`);
    }
    bitsWithEnd = st.pos;
    const need = Math.ceil(bitsWithEnd / 8);
    if (need !== src.length) {
      throw new LzhufError(
        'E_LZHUF_STORED_MISMATCH',
        `结束标记后 ceil(${bitsWithEnd}/8)=${need} 与源字节数 ${src.length} 不符`,
      );
    }
  }

  if (opts.stats) {
    opts.stats.bitsUsed = bitsUsed;
    opts.stats.bitsWithEnd = bitsWithEnd;
    opts.stats.literals = literals;
    opts.stats.matches = matches;
    opts.stats.rescales = st.rescales;
  }
  return out;
}

interface DecoderState {
  freq: Int32Array;
  son: Int32Array;
  prnt: Int32Array;
  /** 已消耗的比特数 */
  pos: number;
  rescales: number;
}

const INIT_FREQ = Int32Array.from(INITIAL_TREE.freq);
const INIT_SON = Int32Array.from(INITIAL_TREE.son);
const INIT_PRNT = Int32Array.from(INITIAL_TREE.prnt);

function newState(): DecoderState {
  return { freq: INIT_FREQ.slice(), son: INIT_SON.slice(), prnt: INIT_PRNT.slice(), pos: 0, rescales: 0 };
}

function overrunError(need: number, srcBits: number, op: number, size: number): LzhufError {
  return new LzhufError(
    'E_LZHUF_SRC_OVERRUN',
    `读取越过源数据末尾：需要比特 ${need} > ${srcBits}（输出 ${op}/${size}）`,
  );
}

/** 叶子 s 的频率 +1，沿父链上溯并维持频率有序（必要时与频率仍为 a−1 的最后一个位置交换） */
function bump(freq: Int32Array, son: Int32Array, prnt: Int32Array, s: number): void {
  const T = LZHUF_T;
  let e = prnt[T + s]!;
  do {
    const a = freq[e]! + 1;
    freq[e] = a;
    if (a > freq[e + 1]!) {
      let l = e + 1;
      while (freq[l] === a - 1) l++;
      l--;
      freq[e] = freq[l]!;
      freq[l] = a;
      const i = son[e]!;
      const j = son[l]!;
      prnt[j] = e;
      if (j < T) prnt[j + 1] = e;
      prnt[i] = l;
      if (i < T) prnt[i + 1] = l;
      son[e] = j;
      son[l] = i;
      e = l;
    }
    e = prnt[e]!;
  } while (e !== 0);
}

/** 频率减半：频率为奇数的叶子先 bump 一次，再全体右移一位 */
function rescale(st: DecoderState): void {
  const { freq, son, prnt } = st;
  st.rescales++;
  for (let s = 0; s < LZHUF_NCHAR; s++) if (freq[prnt[LZHUF_T + s]!]! & 1) bump(freq, son, prnt, s);
  for (let k = 0; k < LZHUF_T; k++) freq[k] = freq[k]! >>> 1;
}

/** 从根走到叶子解出一个符号，然后（必要时减半后）更新树 */
function decodeSymbol(src: Uint8Array, st: DecoderState, op: number, size: number): number {
  const T = LZHUF_T;
  const son = st.son;
  const srcBits = src.length * 8;
  let pos = st.pos;
  let c = son[LZHUF_ROOT]!;
  while (c < T) {
    if (pos >= srcBits) throw overrunError(pos + 1, srcBits, op, size);
    c = son[c + ((src[pos >>> 3]! >>> (pos & 7)) & 1)]!;
    pos++;
  }
  st.pos = pos;
  const s = c - T;
  if (st.freq[LZHUF_ROOT] === LZHUF_RESCALE_AT) rescale(st);
  bump(st.freq, son, st.prnt, s);
  return s;
}

/** LSB-first 读 n（≤ 8）位；越过源末尾的位按 0（仅用于窥视，消耗前另行检查） */
function peekBits(src: Uint8Array, p: number, n: number): number {
  let v = 0;
  for (let k = 0; k < n; k++) {
    const q = p + k;
    const byteIdx = q >>> 3;
    if (byteIdx < src.length) v |= ((src[byteIdx]! >>> (q & 7)) & 1) << k;
  }
  return v;
}

/** 读距离：窥视 8 位 b，只消耗 DLEN[b] 位得到高 6 位，再读 6 位作低 6 位 */
function readDistance(src: Uint8Array, st: DecoderState, op: number, size: number): number {
  const b = peekBits(src, st.pos, 8);
  const len = DIST.dlen[b]!;
  const end = st.pos + len + 6;
  const srcBits = src.length * 8;
  if (end > srcBits) throw overrunError(end, srcBits, op, size);
  const dist = (DIST.dhi[b]! << 6) | peekBits(src, st.pos + len, 6);
  st.pos = end;
  return dist;
}

export function emptyLzhufStats(): LzhufStats {
  return { bitsUsed: 0, bitsWithEnd: null, literals: 0, matches: 0, rescales: 0 };
}
