// 事件 → 演出 handler（design/client.md §4.2、§4.5）：对 GameEvent['type'] 用 satisfies 穷举，
// 引擎新增事件时这里编译失败，不会静默漏播。全部 handler 经 wrapHandler 包装：事件前后同步 M6/M7 舞台
// （路面物件、神明、恶人、角色状态外观），并把时长封顶在 EVENT_BUDGET_MS。
import type { GameEventType } from '@rich4/shared/engine';
import type { EventHandler, HandlerMap } from '../types';
import * as cards from './cards';
import * as day from './day';
import * as economy from './economy';
import * as endgame from './endgame';
import * as events from './events';
import * as gods from './gods';
import * as items from './items';
import * as misc from './misc';
import * as property from './property';
import * as status from './status';
import * as turn from './turn';
import { wrapHandler } from './wrap';

/** 未包装的 handler（单测可以直接调用某一个） */
export const RAW_HANDLERS = {
  // turn
  GAME_STARTED: turn.GAME_STARTED,
  TURN_STARTED: turn.TURN_STARTED,
  PARACHUTE: turn.PARACHUTE,
  TURN_BLOCKED: turn.TURN_BLOCKED,
  RELEASED: status.RELEASED,
  RETURNED: turn.RETURNED,
  TURN_ENDED: turn.TURN_ENDED,
  // move
  DICE_ROLLED: turn.DICE_ROLLED,
  MOVE_SEGMENT: turn.MOVE_SEGMENT,
  ROADBLOCK_HIT: turn.ROADBLOCK_HIT,
  REVERSED: turn.REVERSED,
  LANDED: turn.LANDED,
  // money
  MONEY: property.MONEY,
  LOAN: property.LOAN,
  REPAY: property.REPAY,
  LOAN_REMINDER: economy.LOAN_REMINDER,
  LOAN_FORCED: economy.LOAN_FORCED,
  ATM: property.ATM,
  FINANCE: property.FINANCE,
  RESERVE_SHORTFALL: property.RESERVE_SHORTFALL,
  INSURANCE_PAYOUT: property.INSURANCE_PAYOUT,
  POINTS_GAINED: property.POINTS_GAINED,
  // property
  LAND_BOUGHT: property.LAND_BOUGHT,
  LOT_LEVEL: property.LOT_LEVEL,
  FACILITY_BUILT: property.FACILITY_BUILT,
  LOT_MUTATED: property.LOT_MUTATED,
  TOLL_PAID: property.TOLL_PAID,
  TOLL_EXEMPT: property.TOLL_EXEMPT,
  FEE_PAID: property.FEE_PAID,
  HOTEL_STAY: economy.HOTEL_STAY,
  COMPANY_FEE: economy.COMPANY_FEE,
  SUBSCRIBED: economy.SUBSCRIBED,
  INVEST_BLOCKED: property.INVEST_BLOCKED,
  CANNOT_AFFORD: property.CANNOT_AFFORD,
  MARK_SET: property.MARK_SET,
  MARK_EXPIRED: property.MARK_EXPIRED,
  TENURE_EXPIRED: property.TENURE_EXPIRED,
  RESEARCH_STARTED: property.RESEARCH_STARTED,
  RESEARCH_DONE: economy.RESEARCH_DONE,
  RESEARCH_CANCELLED: property.RESEARCH_CANCELLED,
  // card
  CARD_GAINED: misc.CARD_GAINED,
  CARD_LOST: misc.CARD_LOST,
  CARD_USED: cards.CARD_USED,
  CARD_NO_EFFECT: cards.CARD_NO_EFFECT,
  PASSIVE: cards.PASSIVE,
  SHOP_OPENED: misc.SHOP_OPENED,
  SHOP_TRADE: economy.SHOP_TRADE,
  CHAIRMAN_GIFT: economy.CHAIRMAN_GIFT,
  // item
  ITEM_GAINED: misc.ITEM_GAINED,
  ITEM_LOST: misc.ITEM_LOST,
  ITEM_USED: items.ITEM_USED,
  VEHICLE: items.VEHICLE,
  VEHICLE_DESTROYED: items.VEHICLE_DESTROYED,
  OBJECT_PLACED: items.OBJECT_PLACED,
  OBJECT_REMOVED: items.OBJECT_REMOVED,
  DOLL_WALK: items.DOLL_WALK,
  BOMB_ATTACHED: items.BOMB_ATTACHED,
  BOMB_TRANSFERRED: items.BOMB_TRANSFERRED,
  BOMB_EXPLODED: items.BOMB_EXPLODED,
  STRIKE: items.STRIKE,
  TELEPORTED: items.TELEPORTED,
  TIME_REWOUND: items.TIME_REWOUND,
  // god
  GOD_ATTACHED: gods.GOD_ATTACHED,
  GOD_POWER: gods.GOD_POWER,
  GOD_LEFT: gods.GOD_LEFT,
  GOD_SPAWNED: gods.GOD_SPAWNED,
  GOD_MANIFEST: gods.GOD_MANIFEST,
  DOG_BITE: gods.DOG_BITE,
  DOG_KNOCKED: gods.DOG_KNOCKED,
  DEATH_GOD_SUMMONED: gods.DEATH_GOD_SUMMONED,
  // status
  CONFINED: status.CONFINED,
  BLESSING: status.BLESSING,
  STATUS_SET: status.STATUS_SET,
  ALLIANCE_FORMED: status.ALLIANCE_FORMED,
  ALLIANCE_BROKEN: status.ALLIANCE_BROKEN,
  ALLIANCE_EXPIRED: status.ALLIANCE_EXPIRED,
  BANK_REJECTED: status.BANK_REJECTED,
  // event
  NEWS: events.NEWS,
  FATE: events.FATE,
  MAGIC_CONDITION: events.MAGIC_CONDITION,
  MAGIC_CAST: events.MAGIC_CAST,
  LOTTERY_TICKET: economy.LOTTERY_TICKET,
  LOTTERY_DRAW: economy.LOTTERY_DRAW,
  MINIGAME_STARTED: misc.MINIGAME_STARTED,
  MINIGAME_ENDED: misc.MINIGAME_ENDED,
  BAIL: status.BAIL,
  VILLAIN_HIRED: events.VILLAIN_HIRED,
  VILLAIN_ACTION: events.VILLAIN_ACTION,
  VILLAIN_HOME: events.VILLAIN_HOME,
  BEGGAR_ALMS: events.BEGGAR_ALMS,
  // stock
  STOCK_TRADED: economy.STOCK_TRADED,
  CHAIRMAN_CHANGED: day.CHAIRMAN_CHANGED,
  STOCK_FLAG: day.STOCK_FLAG,
  SUSPENDED: day.SUSPENDED,
  RESUMED: day.RESUMED,
  MARKET_TICK: day.MARKET_TICK,
  MARKET_CLOSED: day.MARKET_CLOSED,
  LISTING_ADDED: endgame.LISTING_ADDED,
  LISTING_REMOVED: endgame.LISTING_REMOVED,
  LISTING_SOLD: endgame.LISTING_SOLD,
  // auction
  AUCTION_STARTED: endgame.AUCTION_STARTED,
  AUCTION_BID: endgame.AUCTION_BID,
  AUCTION_PASS: endgame.AUCTION_PASS,
  AUCTION_QUIT: endgame.AUCTION_QUIT,
  AUCTION_ENDED: endgame.AUCTION_ENDED,
  // day
  DAY_ADVANCED: day.DAY_ADVANCED,
  PRICE_INDEX: day.PRICE_INDEX,
  HOLIDAY: day.HOLIDAY,
  DIVIDENDS: economy.DIVIDENDS,
  MONTHLY_REPORT: economy.MONTHLY_REPORT,
  OBJECTS_RESPAWNED: day.OBJECTS_RESPAWNED,
  DAY_END: day.DAY_END,
  // end
  BANKRUPT: day.BANKRUPT,
  LIQUIDATION: day.LIQUIDATION,
  BECAME_BEGGAR: day.BECAME_BEGGAR,
  SURRENDERED: endgame.SURRENDERED,
  GAME_OVER: endgame.GAME_OVER,
  // system
  CONTROLLER_CHANGED: misc.CONTROLLER_CHANGED,
  AI_TRAITS_CHANGED: misc.AI_TRAITS_CHANGED,
  DEBUG_APPLIED: misc.DEBUG_APPLIED,
  SYNC: misc.SYNC,
} as const satisfies HandlerMap;

function wrapAll(raw: HandlerMap): HandlerMap {
  const out: Partial<Record<GameEventType, EventHandler<GameEventType>>> = {};
  for (const type of Object.keys(raw) as GameEventType[]) {
    out[type] = wrapHandler(raw[type] as EventHandler<GameEventType>);
  }
  return out as HandlerMap;
}

export const HANDLERS: HandlerMap = wrapAll(RAW_HANDLERS);
