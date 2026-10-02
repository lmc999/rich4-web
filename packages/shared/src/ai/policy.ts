/**
 * OriginalAiPolicy：原版电脑 AI（design/minigames-ai.md §8–§9；architecture §5.11）。
 * M4 覆盖经济决策：TURN_MENU（股票买卖与骰子颗数）、BUY_*、UPGRADE_*、BUILD_FACILITY / FACILITY_TYPE、RESEARCH、
 * BANK_ATM、BANK_COUNTER、SHOP、LOTTERY、SUBSCRIBE_SHARES、CONSTRUCTION_PICK、DISCARD_CARD；
 * M6 覆盖 TURN_MENU 的用卡 / 用道具（ai/preRoll.ts）、USE_FREE_CARD、SCAPEGOAT、BAIL（保释玩家分支）；
 * M7 覆盖其余全部：公布栏（TURN_MENU ③④）、AUCTION_BID（心理价位）、MAGIC_CAST、BAIL 的雇恶人、BIRTHDAY_PICK、
 * DEATH_GOD_TARGET（AI 永不投降，托管代答）、MINIGAME（放弃）。23 种决策都走原版判据，不再委托 BasicAiPolicy
 * （BasicAiPolicy 保留给测试与 RICH4_AI_POLICY=basic 对照）。
 * 返回前按 options 做一次合法性自检（PlayerIntentSchema、ALLOWED_INTENTS、数量上限），不合法就退回 defaultIntent，防止活锁。
 */
import { isIntentAllowed, targetMatches } from '../engine/index';
import { type DecisionKind, type PlayerIntent, PlayerIntentSchema, type SeatIndex } from '../engine/types/index';
import type { DecisionForYou, GameView } from '../view/types';
import { auctionBid } from './decisions/auction';
import { atm, bankCounter } from './decisions/bank';
import { birthdayPick, deathGodTarget } from './decisions/events';
import { magicCast } from './decisions/magic';
import { discard, lottery, subscribe } from './decisions/misc';
import { bail, freeCard, scapegoat } from './decisions/passive';
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
  BAIL: (view, d, ctx) => bail(viewOf(view, d.seat, ctx), d, ctx),
  MINIGAME: () => ({ type: 'MINIGAME_DECLINE' }),
  MAGIC_CAST: (_view, d, ctx) => magicCast(d, ctx),
  CONSTRUCTION_PICK: (view, d, ctx) => construction(viewOf(view, d.seat, ctx), d),
  SUBSCRIBE_SHARES: (view, d, ctx) => subscribe(viewOf(view, d.seat, ctx), d),
  USE_FREE_CARD: (view, d, ctx) => freeCard(viewOf(view, d.seat, ctx), d, ctx),
  SCAPEGOAT: (view, d, ctx) => scapegoat(viewOf(view, d.seat, ctx), d, ctx),
  AUCTION_BID: (view, d, ctx) => auctionBid(viewOf(view, d.seat, ctx), d, ctx),
  BIRTHDAY_PICK: (_view, d, ctx) => birthdayPick(d, ctx),
  DISCARD_CARD: (view, d, ctx) => discard(viewOf(view, d.seat, ctx), d),
  DEATH_GOD_TARGET: (view, d, ctx) => deathGodTarget(viewOf(view, d.seat, ctx), d),
} satisfies AiHandlers);

/** 按 options 检查数量、候选与上限（结构与 ALLOWED_INTENTS 另查） */
export function fitsOptions(d: DecisionForYou, intent: PlayerIntent): boolean {
  const a = d as DecisionForYou & { options: Record<string, unknown> };
  switch (d.kind) {
    case 'TURN_MENU': {
      const o = (a as DecisionForYou<'TURN_MENU'>).options;
      if (intent.type === 'ROLL') return intent.dice === undefined || o.dice.allowed.includes(intent.dice);
      if (intent.type === 'USE_CARD') {
        const row = o.cards.find((r) => r.slot === intent.slot);
        return (
          o.menuActions.used < o.menuActions.limit &&
          row !== undefined &&
          row.card === intent.card &&
          row.usable &&
          targetMatches(row.targets, intent.target)
        );
      }
      if (intent.type === 'USE_ITEM') {
        const row = o.items.find((r) => r.item === intent.item);
        return (
          o.menuActions.used < o.menuActions.limit &&
          row !== undefined &&
          row.usable &&
          targetMatches(row.targets, intent.target)
        );
      }
      // 收起交通工具只给真人用（电脑从不提交）；兜底时照样按 options 核对
      if (intent.type === 'STOW_VEHICLE')
        return o.menuActions.used < o.menuActions.limit && o.vehicle?.canStow === true;
      if (intent.type === 'STOCK_BUY' || intent.type === 'STOCK_SELL') {
        if (o.menuActions.used >= o.menuActions.limit) return false;
        const row = o.stock.rows.find((r) => r.idx === intent.stock);
        const max = intent.type === 'STOCK_BUY' ? row?.maxBuy : row?.maxSell;
        return max !== undefined && intent.shares >= 1 && intent.shares <= max;
      }
      if (intent.type === 'BOARD_LIST' || intent.type === 'BOARD_DELIST' || intent.type === 'BOARD_BUY') {
        if (o.menuActions.used >= o.menuActions.limit) return false;
        if (intent.type === 'BOARD_LIST') return o.board.canList && o.board.mine < 7 && intent.price >= 1;
        const l = o.board.listings.find((x) => x.id === intent.listingId);
        return intent.type === 'BOARD_DELIST' ? l?.mine === true : l !== undefined && !l.mine && l.affordable;
      }
      if (intent.type === 'SURRENDER') return o.canSurrender;
      return true;
    }
    case 'AUCTION_BID': {
      const o = (a as DecisionForYou<'AUCTION_BID'>).options;
      return intent.type !== 'BID' || o.increments.includes(intent.inc);
    }
    case 'MAGIC_CAST': {
      const o = (a as DecisionForYou<'MAGIC_CAST'>).options;
      return intent.type !== 'MAGIC_CAST' || o.effects.includes(intent.effect);
    }
    case 'BIRTHDAY_PICK': {
      const o = (a as DecisionForYou<'BIRTHDAY_PICK'>).options;
      if (intent.type !== 'PICK_CARDS') return true;
      const victims = o.victims.filter((v) => v.cards.length > 0);
      if (intent.picks.length !== victims.length) return false;
      return victims.every((v) =>
        intent.picks.some((p) => p.from === v.seat && v.cards.some((c) => c.slot === p.slot)),
      );
    }
    case 'DEATH_GOD_TARGET': {
      const o = (a as DecisionForYou<'DEATH_GOD_TARGET'>).options;
      return intent.type !== 'DEATH_GOD_TARGET' || o.candidates.includes(intent.target);
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
    case 'BAIL': {
      const o = (a as DecisionForYou<'BAIL'>).options;
      if (intent.type === 'BAIL') return o.points >= o.costs.bail && o.inmates.some((i) => i.seat === intent.target);
      if (intent.type === 'HIRE') {
        return o.points >= o.costs.hire && o.villains.some((x) => x.kind === intent.villain && x.available);
      }
      return true;
    }
    case 'SCAPEGOAT': {
      const o = (a as DecisionForYou<'SCAPEGOAT'>).options;
      return intent.type !== 'SCAPEGOAT' || o.candidates.includes(intent.target);
    }
    case 'DISCARD_CARD': {
      const o = (a as DecisionForYou<'DISCARD_CARD'>).options;
      return intent.type !== 'DISCARD' || o.hand.some((h) => h.slot === intent.slot);
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
