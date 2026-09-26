/**
 * 动画时长预算（architecture §5.9；design/net.md §5.4）。服务器用它计算截止时间（动画不占用思考时间），
 * 客户端开发模式下实测 handler 时长，超预算 10% 告警。两端引用同一份常量。
 *
 * 初版预算（M2）：数值按原版演出节奏粗估，M3/M10 实测后调整；调整只影响倒计时公平性，不影响规则。
 */
import type { GameEvent, GameEventOf, GameEventType } from '../engine/types/events';
import type { EstimateAnimMsFn } from './types';

/** 棋子每走一格的时长 */
export const STEP_MS = 180;

/** 单个事件的预算：常数，或按载荷计算 */
export type EventBudget<T extends GameEventType> = number | ((e: GameEventOf<T>) => number);

/** 以 GameEvent['type'] 为键，对全部事件穷举 */
export const EVENT_BUDGET_MS = Object.freeze({
  // turn
  GAME_STARTED: 1500,
  TURN_STARTED: 600,
  PARACHUTE: 1500,
  TURN_BLOCKED: 1200,
  RELEASED: 1000,
  RETURNED: 800,
  TURN_ENDED: 0,
  // move
  DICE_ROLLED: 900,
  MOVE_SEGMENT: (e) => e.path.length * STEP_MS + 250,
  ROADBLOCK_HIT: 800,
  REVERSED: 500,
  LANDED: 200,
  // money
  MONEY: 600,
  LOAN: 900,
  REPAY: 700,
  LOAN_REMINDER: 1200,
  LOAN_FORCED: 1200,
  ATM: 600,
  FINANCE: 900,
  RESERVE_SHORTFALL: 1000,
  INSURANCE_PAYOUT: 1200,
  POINTS_GAINED: 700,
  // property
  LAND_BOUGHT: 1000,
  LOT_LEVEL: 900,
  FACILITY_BUILT: 1000,
  LOT_MUTATED: 1200,
  TOLL_PAID: 1100,
  TOLL_EXEMPT: 800,
  FEE_PAID: (e) => (e.wheel === null ? 1100 : 2600),
  HOTEL_STAY: 1200,
  COMPANY_FEE: (e) => (e.wheel === null ? 1100 : 2600),
  SUBSCRIBED: 800,
  INVEST_BLOCKED: 900,
  CANNOT_AFFORD: 800,
  MARK_SET: 1000,
  MARK_EXPIRED: 500,
  TENURE_EXPIRED: 900,
  RESEARCH_STARTED: 800,
  RESEARCH_DONE: 1000,
  RESEARCH_CANCELLED: 600,
  // card
  CARD_GAINED: 700,
  CARD_LOST: 500,
  CARD_USED: 1400,
  CARD_NO_EFFECT: 800,
  PASSIVE: 1200,
  SHOP_OPENED: 400,
  SHOP_TRADE: 400,
  CHAIRMAN_GIFT: 1000,
  // item
  ITEM_GAINED: 600,
  ITEM_LOST: 400,
  ITEM_USED: 1200,
  VEHICLE: 900,
  VEHICLE_DESTROYED: 1000,
  OBJECT_PLACED: 600,
  OBJECT_REMOVED: 500,
  DOLL_WALK: (e) => e.path.length * STEP_MS + 400,
  BOMB_ATTACHED: 900,
  BOMB_TRANSFERRED: 900,
  BOMB_EXPLODED: 2000,
  STRIKE: 2400,
  TELEPORTED: 1400,
  TIME_REWOUND: 2000,
  // god
  GOD_ATTACHED: 1500,
  GOD_POWER: (e) => (e.slot === null ? 1600 : 3000),
  GOD_LEFT: 900,
  GOD_SPAWNED: 600,
  GOD_MANIFEST: 1800,
  DOG_BITE: 1500,
  DOG_KNOCKED: 900,
  DEATH_GOD_SUMMONED: 1800,
  // status
  CONFINED: 1500,
  BLESSING: 1200,
  STATUS_SET: 700,
  ALLIANCE_FORMED: 1200,
  ALLIANCE_BROKEN: 1000,
  ALLIANCE_EXPIRED: 700,
  BANK_REJECTED: 900,
  // event
  NEWS: 3800,
  FATE: 2600,
  MAGIC_CONDITION: 1800,
  MAGIC_CAST: 2000,
  LOTTERY_TICKET: 600,
  LOTTERY_DRAW: 4200,
  MINIGAME_STARTED: 800,
  MINIGAME_ENDED: (e) => (e.mode === 'played' ? 1500 : 2500),
  BAIL: 1000,
  VILLAIN_HIRED: 1000,
  VILLAIN_ACTION: 1600,
  VILLAIN_HOME: 600,
  BEGGAR_ALMS: 1200,
  // stock
  STOCK_TRADED: 400,
  CHAIRMAN_CHANGED: 1000,
  STOCK_FLAG: 900,
  SUSPENDED: 900,
  RESUMED: 600,
  MARKET_TICK: 0,
  MARKET_CLOSED: 0,
  LISTING_ADDED: 500,
  LISTING_REMOVED: 400,
  LISTING_SOLD: 800,
  // auction
  AUCTION_STARTED: 1500,
  AUCTION_BID: 500,
  AUCTION_PASS: 300,
  AUCTION_QUIT: 300,
  AUCTION_ENDED: 1500,
  // day
  DAY_ADVANCED: 800,
  PRICE_INDEX: 1200,
  HOLIDAY: 2000,
  DIVIDENDS: 1500,
  MONTHLY_REPORT: 3000,
  OBJECTS_RESPAWNED: 600,
  DAY_END: 0,
  // end
  BANKRUPT: 2500,
  LIQUIDATION: 1500,
  BECAME_BEGGAR: 1200,
  SURRENDERED: 2000,
  GAME_OVER: 3000,
  // system（不演出）
  CONTROLLER_CHANGED: 0,
  AI_TRAITS_CHANGED: 0,
  DEBUG_APPLIED: 0,
  SYNC: 0,
} as const satisfies { readonly [T in GameEventType]: EventBudget<T> });

/** 单个事件的预算（ms，非负整数） */
export function eventBudgetMs(e: GameEvent): number {
  const b = EVENT_BUDGET_MS[e.type] as number | ((x: GameEvent) => number);
  const ms = typeof b === 'number' ? b : b(e);
  return Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : 0;
}

/** 一批事件的动画总时长（顺序播放，直接求和） */
export const estimateAnimMs: EstimateAnimMsFn = (events) => {
  let total = 0;
  for (const e of events) total += eventBudgetMs(e);
  return total;
};
