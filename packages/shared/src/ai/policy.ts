/**
 * OriginalAiPolicy：原版电脑 AI（design/minigames-ai.md §8–§9；architecture §5.11）。
 * M4 覆盖经济决策：TURN_MENU（股票买卖与骰子颗数）、BUY_*、UPGRADE_*、BUILD_FACILITY / FACILITY_TYPE、RESEARCH、
 * BANK_ATM、BANK_COUNTER、SHOP、LOTTERY、SUBSCRIBE_SHARES、CONSTRUCTION_PICK、DISCARD_CARD；
 * 其余 kind 暂时委托 BasicAiPolicy（M6/M7 补上卡片、道具、保释、拍卖、魔法屋等）。
 * 返回前按 options 做一次合法性自检（PlayerIntentSchema、ALLOWED_INTENTS、数量上限），不合法就退回 defaultIntent，防止活锁。
 */
import { isIntentAllowed } from '../engine/index';
import { type DecisionKind, type PlayerIntent, PlayerIntentSchema, type SeatIndex } from '../engine/types/index';
import type { DecisionForYou, GameView } from '../view/types';
import { BASIC_HANDLERS } from './basic';
import { atm, bankCounter } from './decisions/bank';
import { discard, lottery, subscribe } from './decisions/misc';
import { buildFacility, buyLand, construction, facilityType, research, upgrade } from './decisions/property';
import { shop } from './decisions/shop';
import { turnMenu } from './decisions/turnMenu';
import type { AiContext, AiHandler, AiHandlers, AiPolicy } from './types';
import { AiView } from './view';

function viewOf(view: GameView, seat: SeatIndex, ctx: AiContext): AiView {
  return new AiView(view, seat, ctx.map);
}

export const ORIGINAL_HANDLERS = Object.freeze({
  TURN_MENU: (view, d, ctx) => turnMenu(viewOf(view, d.seat, ctx), d, ctx),
  BANK_ATM: (view, d, ctx) => atm(viewOf(view, d.seat, ctx), d, ctx),
  BANK_COUNTER: (view, d, ctx) => bankCounter(viewOf(view, d.seat, ctx), d, ctx),
  BUY_LAND: (view, d, ctx) => buyLand(viewOf(view, d.seat, ctx), d),
  UPGRADE_LAND: (view, d, ctx) => upgrade(viewOf(view, d.seat, ctx), d),
  BUY_FACILITY: (view, d, ctx) => buyLand(viewOf(view, d.seat, ctx), d),
  BUILD_FACILITY: (view, d, ctx) => buildFacility(viewOf(view, d.seat, ctx), d, ctx),
  UPGRADE_FACILITY: (view, d, ctx) => upgrade(viewOf(view, d.seat, ctx), d),
  FACILITY_TYPE: (view, d, ctx) => facilityType(viewOf(view, d.seat, ctx), d, ctx),
  RESEARCH: (view, d, ctx) => research(viewOf(view, d.seat, ctx), d),
  SHOP: (view, d, ctx) => shop(viewOf(view, d.seat, ctx), d, ctx),
  LOTTERY: (view, d, ctx) => lottery(viewOf(view, d.seat, ctx), d, ctx),
  BAIL: BASIC_HANDLERS.BAIL,
  MINIGAME: BASIC_HANDLERS.MINIGAME,
  MAGIC_CAST: BASIC_HANDLERS.MAGIC_CAST,
  CONSTRUCTION_PICK: (view, d, ctx) => construction(viewOf(view, d.seat, ctx), d),
  SUBSCRIBE_SHARES: (view, d, ctx) => subscribe(viewOf(view, d.seat, ctx), d),
  USE_FREE_CARD: BASIC_HANDLERS.USE_FREE_CARD,
  SCAPEGOAT: BASIC_HANDLERS.SCAPEGOAT,
  AUCTION_BID: BASIC_HANDLERS.AUCTION_BID,
  BIRTHDAY_PICK: BASIC_HANDLERS.BIRTHDAY_PICK,
  DISCARD_CARD: (view, d, ctx) => discard(viewOf(view, d.seat, ctx), d),
  DEATH_GOD_TARGET: BASIC_HANDLERS.DEATH_GOD_TARGET,
} satisfies AiHandlers);

/** 按 options 检查数量、候选与上限（结构与 ALLOWED_INTENTS 另查） */
export function fitsOptions(d: DecisionForYou, intent: PlayerIntent): boolean {
  const a = d as DecisionForYou & { options: Record<string, unknown> };
  switch (d.kind) {
    case 'TURN_MENU': {
      const o = (a as DecisionForYou<'TURN_MENU'>).options;
      if (intent.type === 'ROLL') return intent.dice === undefined || o.dice.allowed.includes(intent.dice);
      if (intent.type === 'STOCK_BUY' || intent.type === 'STOCK_SELL') {
        if (o.menuActions.used >= o.menuActions.limit) return false;
        const row = o.stock.rows.find((r) => r.idx === intent.stock);
        const max = intent.type === 'STOCK_BUY' ? row?.maxBuy : row?.maxSell;
        return max !== undefined && intent.shares >= 1 && intent.shares <= max;
      }
      return true;
    }
    case 'BANK_ATM': {
      const o = (a as DecisionForYou<'BANK_ATM'>).options;
      if (intent.type !== 'ATM') return true;
      if (intent.amount < 1) return false;
      return intent.op === 'deposit' ? intent.amount <= o.cash : o.canWithdraw && intent.amount <= o.deposit;
    }
    case 'BANK_COUNTER': {
      const o = (a as DecisionForYou<'BANK_COUNTER'>).options;
      if (intent.type === 'LOAN') return o.loanBlocked === null && intent.amount >= 1 && intent.amount <= o.loanLimit;
      if (intent.type === 'REPAY') return intent.amount >= 1 && intent.amount <= o.repayMax;
      if (intent.type === 'FINANCE') return intent.amount >= 1 && intent.amount <= (o.financeLimit ?? 0);
      return true;
    }
    case 'SHOP': {
      const o = (a as DecisionForYou<'SHOP'>).options;
      switch (intent.type) {
        case 'SHOP_BUY_CARD':
          return o.shelf.some((r) => r.idx === intent.shelfIdx && r.buyable);
        case 'SHOP_BUY_ITEM':
          return o.items.some((r) => r.item === intent.item && intent.qty <= r.maxQty);
        case 'SHOP_SELL_CARD':
          return o.sell.cards.some((r) => r.slot === intent.slot);
        case 'SHOP_SELL_ITEM':
          return o.sell.items.some((r) => r.item === intent.item && intent.qty <= r.count);
        default:
          return true;
      }
    }
    case 'LOTTERY': {
      const o = (a as DecisionForYou<'LOTTERY'>).options;
      return intent.type !== 'LOTTERY_BUY' || (o.sold[intent.number] === null && o.cash >= o.price);
    }
    case 'SUBSCRIBE_SHARES': {
      const o = (a as DecisionForYou<'SUBSCRIBE_SHARES'>).options;
      return intent.type !== 'SUBSCRIBE' || (intent.shares >= 1 && intent.shares <= o.max);
    }
    case 'CONSTRUCTION_PICK': {
      const o = (a as DecisionForYou<'CONSTRUCTION_PICK'>).options;
      if (intent.type === 'SKIP') return o.canSkip;
      return intent.type !== 'PICK_LOT' || o.lots.some((l) => l.lot === intent.lot);
    }
    case 'RESEARCH': {
      const o = (a as DecisionForYou<'RESEARCH'>).options;
      return intent.type !== 'RESEARCH' || o.projects.some((p) => p.project === intent.project);
    }
    case 'BUILD_FACILITY':
    case 'FACILITY_TYPE': {
      const o = (a as DecisionForYou<'BUILD_FACILITY'>).options;
      const t = intent.type === 'BUILD_FACILITY' || intent.type === 'CHOOSE_FACILITY_TYPE' ? intent.facility : null;
      return t === null || o.types.some((x) => x.type === t);
    }
    default:
      return true;
  }
}

export function isLegalIntent(d: DecisionForYou, intent: PlayerIntent): boolean {
  if (!PlayerIntentSchema.safeParse(intent).success) return false;
  if (!isIntentAllowed(d.kind, intent.type)) return false;
  return fitsOptions(d, intent);
}

export const OriginalAiPolicy: AiPolicy = Object.freeze({
  id: 'original-v1' as const,
  decide(view: GameView, d: DecisionForYou, ctx: AiContext): PlayerIntent {
    const h = ORIGINAL_HANDLERS[d.kind] as unknown as AiHandler<DecisionKind>;
    const intent = h(view, d, ctx);
    return isLegalIntent(d, intent) ? intent : d.defaultIntent;
  },
});
