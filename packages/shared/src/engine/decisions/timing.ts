/**
 * 决策 → 计时类别（architecture §5.4 表的 timing 列）。服务器按类别查 shared/net/timing.ts 的 DECISION_TIMEOUT_S；
 * MINIGAME 的截止时间按票据计算（startsAt + maxTicks × tickMs + 5000）。
 */
import type { DecisionKind, DecisionTimingClass } from '../types/decision';
import type { SeatIndex } from '../types/ids';

export const DECISION_TIMING_CLASS = Object.freeze({
  TURN_MENU: 'menu',
  BANK_ATM: 'bank',
  BANK_COUNTER: 'bank',
  BUY_LAND: 'confirm',
  UPGRADE_LAND: 'confirm',
  BUY_FACILITY: 'confirm',
  BUILD_FACILITY: 'pick',
  UPGRADE_FACILITY: 'confirm',
  FACILITY_TYPE: 'pick',
  RESEARCH: 'pick',
  SHOP: 'shop',
  LOTTERY: 'lottery',
  BAIL: 'pick',
  MINIGAME: 'minigame',
  MAGIC_CAST: 'pick',
  CONSTRUCTION_PICK: 'pick',
  SUBSCRIBE_SHARES: 'confirm',
  USE_FREE_CARD: 'confirm',
  SCAPEGOAT: 'pick',
  AUCTION_BID: 'auction',
  BIRTHDAY_PICK: 'pick',
  DISCARD_CARD: 'pick',
  DEATH_GOD_TARGET: 'pick',
} as const satisfies { readonly [K in DecisionKind]: DecisionTimingClass });

export function timingOf(kind: DecisionKind): DecisionTimingClass {
  return DECISION_TIMING_CLASS[kind];
}

/**
 * TURN_MENU 的 budgetKey：每次非终结操作后以新 id 重发，key 相同则继承剩余时间
 * （截止 = max(上一个 deadline, now + 8s)，但不超过本回合首次出现 + 90s，见 architecture §5.9）。
 */
export function turnMenuBudgetKey(turnNo: number, seat: SeatIndex): string {
  return `turn:${turnNo}:${seat}`;
}
