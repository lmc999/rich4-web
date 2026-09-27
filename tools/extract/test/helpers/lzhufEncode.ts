/**
 * 测试专用：LZHUF 编码器（与原版无关，只用来合成压缩流）。
 * 模型（自适应哈夫曼 + 减半）在这里独立再写一遍，与 src/mkf/lzhuf.ts 的解码器互相印证；
 * 表取自 src 的按规则生成函数。比特序 LSB-first，末字节不足 8 位时补 0。
 */
import {
  buildDistanceTables,
  buildInitialTree,
  LZHUF_END_DIST,
  LZHUF_MATCH_BIAS,
  LZHUF_NCHAR,
  LZHUF_RESCALE_AT,
  LZHUF_ROOT,
  LZHUF_T,
} from '../../src/mkf/lzhuf';

export type LzToken =
  | { t: 'lit'; v: number }
  | { t: 'match'; len: number; dist: number }
  /** 结束标记：任意匹配符号（默认 256）+ 距离 0xFFF */
  | { t: 'end'; sym?: number }
  /** 直接写原始比特（构造损坏流用） */
  | { t: 'bits'; value: number; n: number };

class BitWriter {
  private bytes: number[] = [];
  bits = 0;
  put(bit: number): void {
    const i = this.bits >> 3;
    if (i === this.bytes.length) this.bytes.push(0);
    if (bit) this.bytes[i]! |= 1 << (this.bits & 7);
    this.bits++;
  }
  putBits(value: number, n: number): void {
    for (let k = 0; k < n; k++) this.put((value >> k) & 1);
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** 每个 HI（0..63）的前缀码：code 为 LSB-first 的低 len 位 */
function distanceCodes(): { code: number; len: number }[] {
  const { dlen, dhi } = buildDistanceTables();
  const out: { code: number; len: number }[] = [];
  for (let b = 0; b < 256; b++) {
    const hi = dhi[b]!;
    if (out[hi] === undefined) out[hi] = { code: b & ((1 << dlen[b]!) - 1), len: dlen[b]! };
  }
  return out;
}

const DCODES = distanceCodes();

class Model {
  freq: Int32Array;
  son: Int32Array;
  prnt: Int32Array;
  constructor() {
    const t = buildInitialTree();
    this.freq = Int32Array.from(t.freq);
    this.son = Int32Array.from(t.son);
    this.prnt = Int32Array.from(t.prnt);
  }

  /** 从根到叶的比特序列：叶子 s 位于位置 prnt[T+s]，比特 = 本位置是父的 son 还是 son+1 */
  path(s: number): number[] {
    const bits: number[] = [];
    let pos = this.prnt[LZHUF_T + s]!;
    while (pos !== LZHUF_ROOT) {
      const par = this.prnt[pos]!;
      bits.push(pos - this.son[par]!);
      pos = par;
    }
    return bits.reverse();
  }

  update(s: number): void {
    if (this.freq[LZHUF_ROOT] === LZHUF_RESCALE_AT) {
      for (let k = 0; k < LZHUF_NCHAR; k++) if (this.freq[this.prnt[LZHUF_T + k]!]! & 1) this.bump(k);
      for (let k = 0; k < LZHUF_T; k++) this.freq[k] = this.freq[k]! >>> 1;
    }
    this.bump(s);
  }

  private bump(s: number): void {
    const { freq, son, prnt } = this;
    let e = prnt[LZHUF_T + s]!;
    for (;;) {
      freq[e] = freq[e]! + 1;
      const a = freq[e]!;
      if (a > freq[e + 1]!) {
        let l = e + 1;
        while (freq[l] === a - 1) l++;
        l--;
        freq[e] = freq[l]!;
        freq[l] = a;
        const i = son[e]!;
        const j = son[l]!;
        prnt[j] = e;
        if (j < LZHUF_T) prnt[j + 1] = e;
        prnt[i] = l;
        if (i < LZHUF_T) prnt[i + 1] = l;
        son[e] = j;
        son[l] = i;
        e = l;
      }
      e = prnt[e]!;
      if (e === 0) return;
    }
  }
}

export interface EncodeResult {
  bytes: Uint8Array;
  /** 写入的总比特数（含结束标记） */
  bits: number;
}

export function encodeLzhufTokens(tokens: readonly LzToken[]): EncodeResult {
  const m = new Model();
  const w = new BitWriter();
  const sym = (s: number): void => {
    for (const b of m.path(s)) w.put(b);
    m.update(s);
  };
  const dist = (d: number): void => {
    const c = DCODES[d >> 6]!;
    w.putBits(c.code, c.len);
    w.putBits(d & 63, 6);
  };
  for (const tk of tokens) {
    if (tk.t === 'lit') sym(tk.v);
    else if (tk.t === 'match') {
      if (tk.len < 3 || tk.len > 67) throw new Error(`match 长度 ${tk.len} 越界`);
      sym(tk.len + LZHUF_MATCH_BIAS);
      dist(tk.dist);
    } else if (tk.t === 'end') {
      sym(tk.sym ?? 256);
      dist(LZHUF_END_DIST);
    } else w.putBits(tk.value, tk.n);
  }
  return { bytes: w.finish(), bits: w.bits };
}

/** 贪心 LZ77：窗口 4095（dist ≤ 4094，0xFFF 保留给结束标记），长度 3..67 */
export function tokenize(data: Uint8Array, maxDist = 4094): LzToken[] {
  const out: LzToken[] = [];
  let i = 0;
  while (i < data.length) {
    let bestLen = 0;
    let bestDist = 0;
    const lo = Math.max(0, i - 1 - maxDist);
    for (let p = i - 1; p >= lo; p--) {
      let n = 0;
      while (n < 67 && i + n < data.length && data[p + n] === data[i + n]) n++;
      if (n > bestLen) {
        bestLen = n;
        bestDist = i - 1 - p;
        if (n === 67) break;
      }
    }
    if (bestLen >= 3) {
      out.push({ t: 'match', len: bestLen, dist: bestDist });
      i += bestLen;
    } else {
      out.push({ t: 'lit', v: data[i]! });
      i++;
    }
  }
  return out;
}

export function lzhufCompress(data: Uint8Array): EncodeResult {
  return encodeLzhufTokens([...tokenize(data), { t: 'end' }]);
}
