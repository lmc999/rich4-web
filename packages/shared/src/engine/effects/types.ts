/**
 * 卡片、道具效果的注册表接口（design/engine.md §10.1）。
 *
 * - menu：TURN_MENU 里这一行能否使用、不能用的原因，以及合法候选（全部由引擎算好，客户端只高亮、AI 按它选）。
 * - check：目标已经匹配候选之后的额外校验（例如购地卡现金不足）；返回不为 null 时抛 EngineRuleError，卡 / 道具保留。
 * - before：校验通过之后、扣卡与 CARD_USED 之前的即时变化（敌意）：随 CARD_USED 的 post 一起公布，
 *   避免效果链接着就发决策时这些变化没有事件可以携带。
 * - apply：扣卡 / 扣道具与 CARD_USED / ITEM_USED 之后执行效果；可以直接结算，也可以压帧（伤害链、查税链、GOD 帧）。
 * 「已选定合法目标但结果无变化」时照样扣卡（例如天使卡打满级地块）；验证失败或取消时不扣。
 */
import type { Ctx } from '../core/ctx';
import type { EngineMap } from '../core/mapCache';
import type { TargetCandidates } from '../types/decision';
import type { ReasonKey, SeatIndex } from '../types/ids';
import type { UseTarget } from '../types/intent';
import type { GameState } from '../types/state';

export type MenuRow =
  | { usable: true; reason: null; targets: TargetCandidates }
  | { usable: false; reason: ReasonKey; targets: TargetCandidates };

export function usable(targets: TargetCandidates): MenuRow {
  return { usable: true, reason: null, targets };
}

export function unusable(reason: ReasonKey, targets: TargetCandidates = { t: 'none' }): MenuRow {
  return { usable: false, reason, targets };
}

/** 候选为空时不可用（noTarget） */
export function usableIf(targets: TargetCandidates, empty: boolean): MenuRow {
  return empty ? unusable('noTarget', targets) : usable(targets);
}

export interface CheckFail {
  rule: 'NOT_USABLE' | 'CANNOT_AFFORD' | 'INVALID_TARGET';
  msg: string;
}

export interface Effect {
  menu(s: GameState, em: EngineMap, seat: SeatIndex): MenuRow;
  check?(s: GameState, em: EngineMap, seat: SeatIndex, t: UseTarget): CheckFail | null;
  before?(ctx: Ctx, seat: SeatIndex, t: UseTarget): void;
  apply(ctx: Ctx, seat: SeatIndex, t: UseTarget): void;
}

export type CardEffect = Effect;

export interface ItemEffect extends Effect {
  /**
   * 使用后道具的去向：'pool' = removeItem（1..8 回共享库存、9..13 消失）；
   * 'placed' = 背包 −1、放到地图上或装备在身上（共享库存不变，由不变量按物件 / 装备计数）。
   */
  consume: 'pool' | 'placed';
}
