/**
 * 个性闸门（design/minigames-ai.md §8.2；@0x41e69e 用于卡片、@0x420e9a 用于道具）：
 *   d = f7 − personality；d ≥ 2 从不做；d == 1 时 rng%3 == 0 才做；d ≤ 0 照做。
 * f7 取自 data/tables 的卡表 / 道具表（exe 表 +7 字节），personality：0 乖宝宝、1 普通人、2 大老奸。
 * 商店的「f7 − 个性 == 2 的卡 / 道具不买、先卖」用的是同一个差值（ai/decisions/shop.ts）。
 */
import type { Personality } from '../data/tables/ids';
import { GATE_NEVER, GATE_ONE_IN } from './constants';
import type { AiRng } from './types';

export function gateDelta(f7: number, personality: Personality): number {
  return f7 - personality;
}

/** 过闸门才可以考虑出这张卡 / 这个道具；d == 1 时消耗一次 rng */
export function passesGate(f7: number, personality: Personality, rng: AiRng): boolean {
  const d = gateDelta(f7, personality);
  if (d >= GATE_NEVER) return false;
  if (d === 1) return rng.mod(GATE_ONE_IN) === 0;
  return true;
}
