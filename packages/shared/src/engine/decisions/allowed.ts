/**
 * 每种决策允许的玩家 intent（architecture §5.4/§5.5；design/engine.md §9.2，按 architecture 修订：
 * 删除 SET_DICE（改为 ROLL{dice?}）、MINIGAME 只允许 MINIGAME_DECLINE）。
 * 服务器 GameRunner 第 7 步、AiDriver 的合法性兜底与引擎 applyAction 都查这张表。
 */
import type { DecisionKind } from '../types/decision';
import type { IntentType, SystemActionType } from '../types/intent';

export const ALLOWED_INTENTS = Object.freeze({
  TURN_MENU: [
    'ROLL',
    'USE_CARD',
    'USE_ITEM',
    'STOW_VEHICLE',
    'STOCK_BUY',
    'STOCK_SELL',
    'BOARD_LIST',
    'BOARD_DELIST',
    'BOARD_BUY',
    'SURRENDER',
  ],
  BANK_ATM: ['ATM', 'SKIP'],
  BANK_COUNTER: ['LOAN', 'REPAY', 'FINANCE', 'SKIP'],
  BUY_LAND: ['CONFIRM', 'DECLINE'],
  UPGRADE_LAND: ['CONFIRM', 'DECLINE'],
  BUY_FACILITY: ['CONFIRM', 'DECLINE'],
  BUILD_FACILITY: ['BUILD_FACILITY', 'DECLINE'],
  UPGRADE_FACILITY: ['CONFIRM', 'DECLINE'],
  FACILITY_TYPE: ['CHOOSE_FACILITY_TYPE'],
  RESEARCH: ['RESEARCH', 'SKIP'],
  SHOP: ['SHOP_BUY_CARD', 'SHOP_BUY_ITEM', 'SHOP_SELL_CARD', 'SHOP_SELL_ITEM', 'LEAVE'],
  LOTTERY: ['LOTTERY_BUY', 'SKIP'],
  BAIL: ['BAIL', 'HIRE', 'SKIP'],
  MINIGAME: ['MINIGAME_DECLINE'],
  MAGIC_CAST: ['MAGIC_CAST'],
  /** SKIP 能否跳过待 V-R19 核实；options.canSkip=false 时引擎拒绝 SKIP */
  CONSTRUCTION_PICK: ['PICK_LOT', 'SKIP'],
  SUBSCRIBE_SHARES: ['SUBSCRIBE', 'SKIP'],
  USE_FREE_CARD: ['CONFIRM', 'DECLINE'],
  SCAPEGOAT: ['SCAPEGOAT', 'DECLINE'],
  AUCTION_BID: ['BID', 'PASS', 'QUIT'],
  BIRTHDAY_PICK: ['PICK_CARDS'],
  DISCARD_CARD: ['DISCARD'],
  DEATH_GOD_TARGET: ['DEATH_GOD_TARGET'],
} as const satisfies { readonly [K in DecisionKind]: readonly IntentType[] });

/** 某种决策允许的 intent 类型 */
export type AllowedIntentType<K extends DecisionKind> = (typeof ALLOWED_INTENTS)[K][number];

export function allowedIntents(kind: DecisionKind): readonly IntentType[] {
  return ALLOWED_INTENTS[kind];
}

export function isIntentAllowed(kind: DecisionKind, type: string): type is IntentType {
  return (ALLOWED_INTENTS[kind] as readonly string[]).includes(type);
}

/** 可以解决某种决策的系统 action（只能由服务器产生） */
export const SYSTEM_RESOLVERS = Object.freeze({
  MINIGAME: ['MINIGAME_RESULT'],
} as const satisfies { readonly [K in DecisionKind]?: readonly SystemActionType[] });
