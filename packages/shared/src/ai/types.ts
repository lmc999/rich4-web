/**
 * AI 契约（architecture §5.11；design/minigames-ai.md §9.1）。
 * - AiPolicy.decide 是纯同步函数，只读投影后的 GameView 与本座位的 DecisionForYou，不得接触 GameState / state.secret。
 * - AI 的随机数由 AiDriver 按 (aiSeed, seat, decisionId | turnIndex+salt) 派生后经 ctx 提供，与引擎 RNG 无关。
 * - AiTraits / AiPreset / SeatAiConfig / Personality 定义在 data/tables/ids.ts（resolveTraits 在 data/tables/characters.ts），这里再导出。
 */
import type { MapIndex } from '../data/maps/mapIndex';
import type { AiTraits, Personality } from '../data/tables/ids';
import type { DecisionKind, PlayerIntent, SeatIndex } from '../engine/types/index';
import type { DecisionForYou, GameView, HandVisibility } from '../view/types';

export type { AiPreset, AiTraits, Personality, SeatAiConfig } from '../data/tables/ids';
export { AI_PRESET_PERSONALITY, AI_PRESETS } from '../data/tables/ids';

/** 原版「託管AI」对话框的字段（比例 0..100，步长 10）；借贷比例不在对话框里，沿用角色默认值 */
export interface TrusteeSettings {
  personality: Personality;
  useCards: boolean;
  useItems: boolean;
  cashRatio: number;
  stockRatio: number;
}

export const TRUSTEE_RATIO_STEP = 10;

function isRatio(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 100 && n % TRUSTEE_RATIO_STEP === 0;
}

export function isValidTrusteeSettings(t: TrusteeSettings): boolean {
  return (
    (t.personality === 0 || t.personality === 1 || t.personality === 2) && isRatio(t.cashRatio) && isRatio(t.stockRatio)
  );
}

/** 托管设置合并进现有特质（服务器据此提交 SYS_SET_AI_TRAITS） */
export function applyTrusteeSettings(base: AiTraits, t: TrusteeSettings): AiTraits {
  return {
    personality: t.personality,
    useCards: t.useCards,
    useItems: t.useItems,
    loanRatio: base.loanRatio,
    cashRatio: t.cashRatio,
    stockRatio: t.stockRatio,
  };
}

/** 从特质取出托管对话框的初始值 */
export function trusteeSettingsOf(traits: AiTraits): TrusteeSettings {
  return {
    personality: traits.personality,
    useCards: traits.useCards,
    useItems: traits.useItems,
    cashRatio: traits.cashRatio,
    stockRatio: traits.stockRatio,
  };
}

/** Watcom LCG 语义的随机数（分布与原版 rand()%n 一致） */
export interface AiRng {
  /** 0..32767 */
  next15(): number;
  /** next15() % n */
  mod(n: number): number;
  /** next15() & 1 */
  bit(): 0 | 1;
  /** (next15() * n) >> 15 */
  scale(n: number): number;
}

export interface AiContext {
  seat: SeatIndex;
  traits: AiTraits;
  /** 按 (aiSeed, seat, decisionId) 派生 */
  rng: AiRng;
  /** 按 (aiSeed, seat, turnIndex, salt) 派生；同一回合内同一 salt 多次调用结果稳定 */
  turnRng(salt: string): AiRng;
  map: MapIndex;
  handVisibility: HandVisibility;
}

export type AiPolicyId = 'original-v1' | 'basic';

export interface AiPolicy {
  readonly id: AiPolicyId;
  /** 纯同步，目标 < 5ms；返回的 intent 必须能通过 PlayerIntentSchema 与 ALLOWED_INTENTS[kind] */
  decide(view: GameView, d: DecisionForYou, ctx: AiContext): PlayerIntent;
}

/** 单个 kind 的处理函数 */
export type AiHandler<K extends DecisionKind> = (view: GameView, d: DecisionForYou<K>, ctx: AiContext) => PlayerIntent;

/** 策略分派表：用 satisfies AiHandlers 覆盖全部 23 种（暂无规则的先返回 d.defaultIntent） */
export type AiHandlers = { readonly [K in DecisionKind]: AiHandler<K> };
