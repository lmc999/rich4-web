/**
 * sim 自带的 Watcom rand()（design/minigames-ai.md §2.3）：状态是 SimBase.rng（uint32），
 * 公式复用 util/rng/watcom.ts，因此 rand()%n 的分布与原版逐位一致。
 */
import { type WatcomState, watcomRand } from '../util/rng/watcom';

/** 复用的暂存对象：只在单次调用内使用，调用结束即写回 s.rng */
const scratch: WatcomState = { next: 0 };

/** 0..32767，推进 s.rng */
export function rand15(s: { rng: number }): number {
  scratch.next = s.rng;
  const r = watcomRand(scratch);
  s.rng = scratch.next;
  return r;
}

/** rand() % n（n 为正整数；非负数上与原版 idiv 一致） */
export function randMod(s: { rng: number }, n: number): number {
  return rand15(s) % n;
}

/** (rand() * n) >> 15：企鹅埋宝的取法，要求 0 <= n < 65536 */
export function randScale(s: { rng: number }, n: number): number {
  return (rand15(s) * n) >> 15;
}

/** C 截断除法（|a| < 2^26 时与 idiv 一致） */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}
