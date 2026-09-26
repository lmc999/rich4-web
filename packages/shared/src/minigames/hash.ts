/**
 * 小游戏状态哈希（design/minigames-ai.md §2.3）：FNV-1a 32，把每个整数按 int32 小端 4 字节喂入。
 * 各 sim 按固定字段顺序调用；fx 不参与。数组先写长度再写元素，避免不同布局碰撞。
 */
import type { SimPhase } from './types';

const FNV32_OFFSET = 0x811c9dc5;
const FNV32_PRIME = 0x01000193;

export function hashInit(): number {
  return FNV32_OFFSET;
}

export function hashInt(h: number, x: number): number {
  const v = x | 0;
  let r = Math.imul(h ^ (v & 0xff), FNV32_PRIME);
  r = Math.imul(r ^ ((v >>> 8) & 0xff), FNV32_PRIME);
  r = Math.imul(r ^ ((v >>> 16) & 0xff), FNV32_PRIME);
  return Math.imul(r ^ (v >>> 24), FNV32_PRIME);
}

export function hashBool(h: number, b: boolean): number {
  return hashInt(h, b ? 1 : 0);
}

export function hashInts(h: number, arr: readonly number[]): number {
  let r = hashInt(h, arr.length);
  for (let i = 0; i < arr.length; i++) r = hashInt(r, arr[i]!);
  return r;
}

export function hashFinish(h: number): number {
  return h >>> 0;
}

export const PHASE_CODE: Readonly<Record<SimPhase, number>> = Object.freeze({ intro: 0, play: 1, ending: 2, over: 3 });

/** 通用前缀：游戏标签、tick、phase、rng */
export function hashBase(tag: number, s: { tick: number; phase: SimPhase; rng: number }): number {
  let h = hashInt(hashInit(), tag);
  h = hashInt(h, s.tick);
  h = hashInt(h, PHASE_CODE[s.phase]);
  return hashInt(h, s.rng);
}
