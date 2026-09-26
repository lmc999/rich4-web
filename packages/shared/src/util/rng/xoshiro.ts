import { SPLITMIX32_GAMMA, splitmix32, splitmix32Mix } from '../hash';

/**
 * xoshiro128**（只给引擎用，状态存 state.secret.rng，见 architecture §4 RNG、DEV-02）。
 * 状态是 4 个 uint32 组成的 JSON 数组，可直接序列化；所有函数原地推进状态。
 */
export type XoshiroState = [number, number, number, number];

/** 全零状态不可用，替换成这个常量 */
export const XOSHIRO_ZERO_FALLBACK: Readonly<XoshiroState> = [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x6a09e667];

const HEX_RE = /^[0-9a-fA-F]{1,64}$/;

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

function normalize(s: XoshiroState): XoshiroState {
  const r: XoshiroState = [s[0] >>> 0, s[1] >>> 0, s[2] >>> 0, s[3] >>> 0];
  if ((r[0] | r[1] | r[2] | r[3]) === 0) return [...XOSHIRO_ZERO_FALLBACK];
  return r;
}

/** 由 4 个 uint32 直接构造状态（全零时替换为常量） */
export function xoshiroFromWords(words: readonly [number, number, number, number]): XoshiroState {
  return normalize([words[0], words[1], words[2], words[3]]);
}

/** 由 32 位种子经 splitmix32 展开 */
export function seedFromU32(seed: number): XoshiroState {
  const w = splitmix32(seed, 4);
  return normalize([w[0]!, w[1]!, w[2]!, w[3]!]);
}

/**
 * 由 hex 种子（1..64 位 hex，大小写不敏感）得到状态。
 * 左补 0 到 8 的倍数后切成 uint32 字，按下标 mod 4 异或折叠成 4 个字，
 * 再逐字用 splitmix32 的混合函数展开：state[i] = mix(w[i] + (i+1)·gamma)。
 * 32 位 hex 以内的种子到状态是单射。
 */
export function seedFromHex(hex: string): XoshiroState {
  if (!HEX_RE.test(hex)) throw new RangeError(`seedFromHex: invalid hex seed "${hex}"`);
  const h = hex.toLowerCase();
  const padded = h.padStart(((h.length + 7) >> 3) * 8, '0');
  const w: XoshiroState = [0, 0, 0, 0];
  const chunks = padded.length / 8;
  for (let j = 0; j < chunks; j++) {
    const word = Number.parseInt(padded.slice(j * 8, j * 8 + 8), 16) >>> 0;
    // 靠右对齐：最后一个字落在 w[3]
    const slot = (4 - chunks + j + 64) & 3;
    w[slot] = (w[slot] ^ word) >>> 0;
  }
  return normalize([
    splitmix32Mix(w[0] + SPLITMIX32_GAMMA),
    splitmix32Mix(w[1] + Math.imul(2, SPLITMIX32_GAMMA)),
    splitmix32Mix(w[2] + Math.imul(3, SPLITMIX32_GAMMA)),
    splitmix32Mix(w[3] + Math.imul(4, SPLITMIX32_GAMMA)),
  ]);
}

/** 输出一个 uint32 并推进状态 */
export function xoshiroNext32(s: XoshiroState): number {
  const s0 = s[0];
  const s1 = s[1];
  const s2 = s[2] ^ s0;
  const s3 = s[3] ^ s1;
  const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
  const t = s1 << 9;
  s[0] = (s0 ^ s3) >>> 0;
  s[1] = (s1 ^ s2) >>> 0;
  s[2] = (s2 ^ t) >>> 0;
  s[3] = rotl(s3, 11) >>> 0;
  return result;
}

/** 0..32767，取高 15 位；模拟 Watcom rand() 的取值范围 */
export function xoshiroRand15(s: XoshiroState): number {
  return xoshiroNext32(s) >>> 17;
}

/** rand15() % n（与原版 rand()%n 公式同形），n 为正整数 */
export function xoshiroInt(s: XoshiroState, n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`xoshiroInt: n must be a positive integer, got ${n}`);
  return xoshiroRand15(s) % n;
}

/** 面向对象的包装：方法原地推进构造时传入的状态数组 */
export class XoshiroRng {
  constructor(readonly state: XoshiroState) {}

  static fromHex(hex: string): XoshiroRng {
    return new XoshiroRng(seedFromHex(hex));
  }

  next32(): number {
    return xoshiroNext32(this.state);
  }

  rand15(): number {
    return xoshiroRand15(this.state);
  }

  int(n: number): number {
    return xoshiroInt(this.state, n);
  }

  /** 状态副本，可直接 JSON 序列化 */
  snapshot(): XoshiroState {
    return [this.state[0], this.state[1], this.state[2], this.state[3]];
  }
}
