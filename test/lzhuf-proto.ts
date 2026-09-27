/**
 * 大富翁4 MKF 私有压缩（LZHUF 变体）解压原型 —— 自写实现（调试脚本，放在 test/ 下）。
 *
 * 依据 docs/research/g_map.md §6.3 的伪代码；参考思路：mytbk csrc/mkf、nurockplayer decompress_private。
 * 未复制任何第三方代码或表：所有表均按规则生成，并由 test/mkf-survey.ts 与用户自有 rich4.exe 中的原表逐字节比对。
 *
 * 算法要点
 *  - 自适应哈夫曼（NCHAR=321 个符号：0..255 字面量，256..320 表示长度 3..67 的回溯），
 *    树节点按频率有序存放在 freq[0..640]，根在 640；leaf s 的位置记在 prnt[641+s]。
 *  - 比特序 LSB-first：bit(p) = (src[p>>3] >> (p&7)) & 1。
 *  - 回溯距离 12 位：先取 8 位查表得前缀长度 LEN 与高 6 位 HI，再取紧随前缀之后的 6 位作为低 6 位；
 *    dist == 0xFFF 为流结束标记。复制源 = 当前输出位置 - 1 - dist，逐字节（允许重叠）。
 *  - freq[640]（根）达到 0x8000 时先“半衰”：对每个叶子，若其所在位置频率为奇数则先 +1 路径更新，再全体 >>1。
 */

export const NCHAR = 321;
export const T = 641; // 叶子位置总数 + 内部节点总数 = 2*NCHAR-1
export const ROOT = 640;

/** 距离前缀表：DLEN[b] = 前缀比特数(3..8)，DHI[b] = 距离高 6 位。按 LSB-first 读到的 8 位 b 索引。 */
export function buildDistanceTables(): { DLEN: Uint8Array; DHI: Uint8Array } {
  const DLEN = new Uint8Array(256);
  const DHI = new Uint8Array(256);
  const m4: Record<number, number> = { 3: 0, 11: 1, 13: 2 };
  const m5: Record<number, number> = { 1: 0, 5: 1, 9: 2, 14: 3 };
  const m6: Record<number, number> = { 2: 0, 6: 1, 10: 2 };
  const m7: Record<number, number> = { 4: 0, 8: 1, 12: 2 };
  for (let v = 0; v < 256; v++) {
    const blk = v >> 4;
    const lo = v & 15;
    if (lo === 0) {
      DLEN[v] = 8;
      DHI[v] = 63 - blk;
    } else if (lo === 7 || lo === 15) {
      DLEN[v] = 3;
      DHI[v] = 0;
    } else if (lo in m4) {
      DLEN[v] = 4;
      DHI[v] = 3 - m4[lo]!;
    } else if (lo in m5) {
      DLEN[v] = 5;
      DHI[v] = 11 - 4 * (blk % 2) - m5[lo]!;
    } else if (lo in m6) {
      DLEN[v] = 6;
      DHI[v] = 23 - 3 * (blk % 4) - m6[lo]!;
    } else if (lo in m7) {
      DLEN[v] = 7;
      DHI[v] = 47 - 3 * (blk % 8) - m7[lo]!;
    } else {
      throw new Error(`distance table: unmapped lo=${lo}`);
    }
  }
  return { DLEN, DHI };
}

/**
 * 初始树（按原版内存布局以“索引×2”表示，便于与 exe 字节比对）：
 *   freq[642]、son[641]、prnt[963]（prnt[641+s] 为叶子 s 的位置）。
 */
export function buildInitialTree(): { freq: Uint16Array; son2: Uint16Array; prnt2: Uint16Array } {
  const freq = new Uint16Array(T + 1);
  const son2 = new Uint16Array(T);
  const prnt2 = new Uint16Array(T + NCHAR + 1); // 963
  for (let i = 0; i < NCHAR; i++) {
    freq[i] = 1;
    son2[i] = (i + T) * 2;
    prnt2[T + i] = i * 2;
  }
  for (let j = NCHAR; j < T; j++) {
    const k = j - NCHAR;
    freq[j] = freq[2 * k]! + freq[2 * k + 1]!;
    son2[j] = 2 * k * 2;
  }
  freq[T] = 0xffff;
  for (let i = 0; i < ROOT; i++) prnt2[i] = (NCHAR + (i >> 1)) * 2;
  prnt2[ROOT] = 0;
  prnt2[T + NCHAR] = 0; // prnt[962]
  return { freq, son2, prnt2 };
}

const DIST = buildDistanceTables();
const INIT = buildInitialTree();

export class LzhufError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.code = code;
  }
}

export interface DecompressStats {
  /** 消耗的比特数 */
  bitsUsed: number;
  /** 是否因 dist==0xFFF 结束标记而提前结束 */
  endMarker: boolean;
  literals: number;
  matches: number;
  rescales: number;
  /** 原版解码器不检查长度、只靠结束标记停止：输出满 size 后再解一个符号，应为 dist==0xFFF 的结束标记 */
  tailEndMarker?: boolean;
  /** 结束标记之后消耗的总比特数（含结束标记） */
  bitsWithTail?: number;
  /** 最后一个回溯超出 size 的字节数（原版会越界写；良构流应为 0） */
  overrun: number;
}

/**
 * 解压。输出长度严格等于 size；若结束标记先于 size 到达，则 endMarker=true 且剩余字节为 0（与原版行为一致：原版不会清零缓冲，
 * 这里我们把它视为异常情况并在统计里报告）。
 */
export function lzhufDecompress(src: Uint8Array, size: number, stats?: DecompressStats): Uint8Array {
  // 工作状态：直接使用“位置索引”（非 ×2）
  const freq = new Uint16Array(INIT.freq); // 642
  const son = new Uint16Array(T);
  const prnt = new Uint16Array(T + NCHAR + 1);
  for (let i = 0; i < T; i++) son[i] = INIT.son2[i]! >> 1;
  for (let i = 0; i < prnt.length; i++) prnt[i] = INIT.prnt2[i]! >> 1;
  const { DLEN, DHI } = DIST;

  const out = new Uint8Array(size);
  let op = 0;
  let pos = 0; // bit position
  const srcBits = src.length * 8;
  let literals = 0;
  let matches = 0;
  let rescales = 0;
  let endMarker = false;
  let overrun = 0;

  const bump = (s: number): void => {
    let e = prnt[T + s]!;
    for (;;) {
      const a = ++freq[e]!;
      // freq 为 Uint16Array，++ 已写回；a 取写回后的值
      if (a <= freq[e + 1]!) {
        e = prnt[e]!;
        if (e === 0) return;
        continue;
      }
      let l = e + 1;
      while (freq[l] === a - 1) l++;
      l--;
      // 交换位置 e 与 l 的频率与子树
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
      e = prnt[l]!;
      if (e === 0) return;
    }
  };

  const rescale = (): void => {
    rescales++;
    for (let s = 0; s < NCHAR; s++) {
      if (freq[prnt[T + s]!]! & 1) bump(s);
    }
    for (let k = 0; k < T; k++) freq[k] = freq[k]! >> 1;
  };

  const readBits = (p: number, n: number): number => {
    // LSB-first，n <= 24
    let v = 0;
    for (let k = 0; k < n; k++) {
      const q = p + k;
      const byte = q >> 3 < src.length ? src[q >> 3]! : 0;
      v |= ((byte >> (q & 7)) & 1) << k;
    }
    return v;
  };

  while (op < size) {
    // decode_symbol
    let c = son[ROOT]!;
    while (c < T) {
      if (pos >= srcBits + 32) throw new LzhufError('E_LZHUF_OVERRUN', `源数据耗尽：pos=${pos} bits, out=${op}/${size}`);
      const byteIdx = pos >> 3;
      const bit = byteIdx < src.length ? (src[byteIdx]! >> (pos & 7)) & 1 : 0;
      pos++;
      c = son[c + bit]!;
    }
    const s = c - T;
    if (freq[ROOT] === 0x8000) rescale();
    bump(s);

    if (s < 256) {
      out[op++] = s;
      literals++;
      continue;
    }
    const b = readBits(pos, 8);
    const L = DLEN[b]!;
    const hi = DHI[b]!;
    const lo6 = readBits(pos + L, 6);
    pos += L + 6;
    const dist = (hi << 6) | lo6;
    if (dist === 0xfff) {
      endMarker = true;
      break;
    }
    matches++;
    let n = s - 253;
    if (n > size - op) {
      overrun += n - (size - op);
      n = size - op;
    }
    let p = op - 1 - dist;
    if (p < 0) throw new LzhufError('E_LZHUF_DIST', `回溯越界：op=${op} dist=${dist}`);
    while (n-- > 0) out[op++] = out[p++]!;
  }
  if (pos > srcBits) {
    throw new LzhufError('E_LZHUF_OVERRUN', `读取越过源数据末尾：pos=${pos} > ${srcBits}`);
  }
  let tailEndMarker: boolean | undefined;
  let bitsWithTail: number | undefined;
  if (stats && !endMarker) {
    // 按原版逻辑再解一个符号，检验结束标记
    let q = pos;
    let c = son[ROOT]!;
    while (c < T) {
      const byteIdx = q >> 3;
      const bit = byteIdx < src.length ? (src[byteIdx]! >> (q & 7)) & 1 : 0;
      q++;
      c = son[c + bit]!;
    }
    const s = c - T;
    tailEndMarker = false;
    if (s >= 256) {
      const b = readBits(q, 8);
      const L = DLEN[b]!;
      const dist = (DHI[b]! << 6) | readBits(q + L, 6);
      q += L + 6;
      tailEndMarker = dist === 0xfff;
    }
    bitsWithTail = q;
  }
  if (stats) {
    stats.tailEndMarker = tailEndMarker;
    stats.bitsWithTail = bitsWithTail;
    stats.overrun = overrun;
    stats.bitsUsed = pos;
    stats.endMarker = endMarker;
    stats.literals = literals;
    stats.matches = matches;
    stats.rescales = rescales;
  }
  return out;
}
