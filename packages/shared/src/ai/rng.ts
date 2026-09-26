/**
 * AI 随机数（architecture §4 RNG；design/minigames-ai.md §9.1、§9.10）。
 * Watcom LCG（分布与原版 rand()%n 一致），种子 = mix32(aiSeed, keys…)：
 *   决策 rng   = createAiRng(aiSeed, seat, fnv1a32(decisionId))
 *   回合 rng   = createAiRng(aiSeed, seat, turnNo, fnv1a32(salt))（同一回合内同一 salt 结果稳定）
 * 不持久化 RNG 状态；与引擎 RNG 完全独立。服务器 AiDriver、模拟脚本与测试都用 makeAiContext 构造 ctx。
 */
import type { MapIndex } from '../data/maps/mapIndex';
import type { AiTraits, SeatIndex } from '../engine/types/index';
import { fnv1a32, mix32 } from '../util/hash';
import { createWatcomState, watcomInt, watcomRand, watcomScale } from '../util/rng/watcom';
import type { HandVisibility } from '../view/types';
import type { AiContext, AiRng } from './types';

/** 由种子直接构造 */
export function aiRngFromSeed(seed: number): AiRng {
  const s = createWatcomState(seed);
  return {
    next15: () => watcomRand(s),
    mod: (n) => watcomInt(s, n),
    bit: () => (watcomRand(s) & 1) as 0 | 1,
    scale: (n) => watcomScale(s, n),
  };
}

/** 种子 = mix32(aiSeed, keys…)；字符串 key 先做 fnv1a32 */
export function createAiRng(aiSeed: number, ...keys: (number | string)[]): AiRng {
  return aiRngFromSeed(mix32(aiSeed >>> 0, ...keys.map((k) => (typeof k === 'string' ? fnv1a32(k) : k))));
}

export interface MakeAiContextParams {
  aiSeed: number;
  seat: SeatIndex;
  decisionId: string;
  /** view.clock.turnNo */
  turnNo: number;
  traits: AiTraits;
  map: MapIndex;
  handVisibility: HandVisibility;
}

/** 与服务器 AiDriver 相同的派生方式：rng 按 (aiSeed, seat, decisionId)，turnRng 按 (aiSeed, seat, turnNo, salt) */
export function makeAiContext(p: MakeAiContextParams): AiContext {
  return {
    seat: p.seat,
    traits: p.traits,
    rng: createAiRng(p.aiSeed, p.seat, fnv1a32(p.decisionId)),
    turnRng: (salt) => createAiRng(p.aiSeed, p.seat, p.turnNo, fnv1a32(salt)),
    map: p.map,
    handVisibility: p.handVisibility,
  };
}
