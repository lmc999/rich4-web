/**
 * Open Watcom C 库的 rand()：next = next·0x41C64E6D + 0x3039 (mod 2^32)，返回 (next >>> 16) & 0x7FFF。
 * 给小游戏 sim 与 AI 用，rand()%n 的分布与原版一致（architecture §4 RNG）。
 * @source docs/design/minigames-ai.md §2.3（Watcom rand @v311:0x456f2d）
 */
export interface WatcomState {
  next: number;
}

/** C 标准规定未调用 srand 时种子为 1 */
export const WATCOM_DEFAULT_SEED = 1;
export const WATCOM_RAND_MAX = 0x7fff;

export function createWatcomState(seed: number = WATCOM_DEFAULT_SEED): WatcomState {
  return { next: seed >>> 0 };
}

export function watcomSrand(s: WatcomState, seed: number): void {
  s.next = seed >>> 0;
}

/** 0..32767 */
export function watcomRand(s: WatcomState): number {
  s.next = (Math.imul(s.next, 0x41c64e6d) + 0x3039) >>> 0;
  return (s.next >>> 16) & 0x7fff;
}

/** rand() % n，n 为正整数 */
export function watcomInt(s: WatcomState, n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`watcomInt: n must be a positive integer, got ${n}`);
  return watcomRand(s) % n;
}

/** (rand() * n) >> 15，原版企鹅埋宝等处的用法；要求 0 <= n < 65536 */
export function watcomScale(s: WatcomState, n: number): number {
  return (watcomRand(s) * n) >> 15;
}

export class WatcomRng {
  constructor(readonly state: WatcomState = createWatcomState()) {}

  static fromSeed(seed: number): WatcomRng {
    return new WatcomRng(createWatcomState(seed));
  }

  rand15(): number {
    return watcomRand(this.state);
  }

  int(n: number): number {
    return watcomInt(this.state, n);
  }

  scale(n: number): number {
    return watcomScale(this.state, n);
  }

  snapshot(): WatcomState {
    return { next: this.state.next };
  }
}
