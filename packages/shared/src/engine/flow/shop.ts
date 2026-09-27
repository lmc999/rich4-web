/**
 * SHOP 帧：百货公司（design/engine.md §8 kind 15；docs/research/r_cards.md §3–§4）。
 *
 * gift  该百货公司（落点格 ref.lot）的董事长进店：rand15()%2 → 0 得一张随机卡（牌堆加权）/ 1 得一个随机道具（库存加权）
 * open  真人座位：进店时抽货架 rand15()%10+6 张（按牌堆剩余张数加权、不放回）；电脑座位面对整副牌堆。
 *       模式在进店时定下（f.fullDeck），离店前不随 controller 改变。
 *       每笔交易后重新发 SHOP（新 id），LEAVE 离店；每次进店最多 SHOP_TRADE_LIMIT 笔。
 *       买卡：点券 ≥ 标价、手牌未满 15 张、牌堆里还有；买道具：只卖 1..8，库存够、持有不超过 9；
 *       卖卡、卖道具：得 trunc(标价 × 数量 × 0.9) 点券，卡回牌堆、道具 1..8 回库存。点券按 uint16。
 */
import { cardDef } from '../../data/tables/cards';
import { ECON } from '../../data/tables/economy';
import { type CardId, type ItemId, isPoolItem } from '../../data/tables/ids';
import { itemDef } from '../../data/tables/items';
import { addU16, subU16 } from '../../util/int32';
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { weightedIndex } from '../core/random';
import { buildShop, fullDeckShelf, shopHasChoice } from '../decisions/economy';
import { gainCard } from '../effects/common';
import { EngineRuleError } from '../errors';
import {
  drawFromDeck,
  HAND_MAX,
  ITEM_MAX,
  receiveItem,
  removeItem,
  returnCardToDeck,
  sellValue,
  takeFromDeck,
} from '../rules/inventory';
import { SHOP_TRADE_LIMIT, type ShopTradeRecord } from '../types/decision';
import type { FrameOf } from '../types/frames';
import type { PlayerAction } from '../types/intent';

type ShopFrame = FrameOf<'SHOP'>;

/** 按道具库存加权抽 1..8 中的一种（库存全空返回 null） */
export function drawPoolItem(ctx: Ctx, purpose: 'gift' | 'chairmanGift'): ItemId | null {
  const weights = ctx.s.pools.items.map((n, i) => (i >= 1 && i <= 8 ? Math.max(0, n) : 0));
  if (weights.every((w) => w <= 0)) return null;
  return weightedIndex(ctx.s, purpose, weights) as ItemId;
}

function chairmanGift(ctx: Ctx, f: ShopFrame): void {
  if (f.company === null) return;
  const ci = ctx.map.companyIdx(f.company);
  const c = ctx.s.companies[ci];
  if (!c || ctx.s.stocks[c.stock]?.chairman !== f.seat) return;
  const kind = ctx.pick('chairmanGift', 2);
  if (kind === 0) {
    const card = drawFromDeck(ctx.s);
    if (card === null) return;
    gainCard(ctx, f.seat, card, 'chairmanGift', () => ctx.emit('CHAIRMAN_GIFT', { seat: f.seat, card, item: null }));
    return;
  }
  const item = drawPoolItem(ctx, 'chairmanGift');
  if (item === null || receiveItem(ctx.s, f.seat, item, 1) === 0) return;
  ctx.emit('CHAIRMAN_GIFT', { seat: f.seat, card: null, item });
}

/** 真人座位的货架：rand15()%10+6 张，按牌堆剩余张数加权、不放回 */
function drawShelf(ctx: Ctx): CardId[] {
  const n = ECON.SHOP_SHELF_BASE + ctx.pick('shelf', ECON.SHOP_SHELF_RANGE);
  const left = ctx.s.pools.cards.slice();
  left[0] = 0;
  const out: CardId[] = [];
  for (let i = 0; i < n; i++) {
    if (left.every((x) => x <= 0)) break;
    const c = weightedIndex(ctx.s, 'shelf', left) as CardId;
    left[c] = left[c]! - 1;
    out.push(c);
  }
  return out;
}

/**
 * 本次进店是否面对整副牌堆：进店时按 controller 定下并记在帧上（f.fullDeck），之后读帧而不是 controller——
 * 中途 SYS_SET_CONTROLLER（踢人转电脑、读档后真人认领）不改 pending，已发出的货架下标必须按原模式解释。
 * 旧存档里进店中途的帧没有该字段时回退到当前 controller。
 */
function isFullDeck(ctx: Ctx, f: ShopFrame): boolean {
  return f.fullDeck ?? ctx.player(f.seat).controller === 'ai';
}

function trade(ctx: Ctx, f: ShopFrame, a: PlayerAction): void {
  const s = ctx.s;
  const p = ctx.player(f.seat);
  const mode = s.config.rules.intOverflow;
  if (f.trades.length >= SHOP_TRADE_LIMIT) throw new EngineRuleError('MENU_LIMIT', 'shop trade limit reached');
  let rec: ShopTradeRecord;
  switch (a.type) {
    case 'SHOP_BUY_CARD': {
      const fullDeck = isFullDeck(ctx, f);
      const shelf = fullDeck ? fullDeckShelf(s) : f.shelf;
      const card = shelf[a.shelfIdx];
      if (card === undefined) throw new EngineRuleError('INVALID_TARGET', `shelf ${a.shelfIdx}`);
      const price = cardDef(card).price;
      if (p.cards.length >= HAND_MAX) throw new EngineRuleError('NOT_ALLOWED', 'hand is full');
      if (p.points < price) throw new EngineRuleError('CANNOT_AFFORD', `points ${p.points} < ${price}`);
      if (!takeFromDeck(s, card)) throw new EngineRuleError('NOT_ALLOWED', `card ${card} is sold out`);
      p.points = subU16(p.points, price, mode);
      p.cards.push(card);
      if (!fullDeck) f.shelf.splice(a.shelfIdx, 1);
      rec = { op: 'buyCard', card, item: null, qty: 1, points: price };
      break;
    }
    case 'SHOP_BUY_ITEM': {
      const it = a.item;
      if (!isPoolItem(it)) throw new EngineRuleError('INVALID_TARGET', `item ${it} is not sold`);
      const cost = itemDef(it).price * a.qty;
      if ((s.pools.items[it] ?? 0) < a.qty) throw new EngineRuleError('NOT_ALLOWED', `item ${it} is sold out`);
      if ((p.items[it] ?? 0) + a.qty > ITEM_MAX) throw new EngineRuleError('OUT_OF_RANGE', `more than ${ITEM_MAX}`);
      if (p.points < cost) throw new EngineRuleError('CANNOT_AFFORD', `points ${p.points} < ${cost}`);
      receiveItem(s, f.seat, it, a.qty);
      p.points = subU16(p.points, cost, mode);
      rec = { op: 'buyItem', card: null, item: it, qty: a.qty, points: cost };
      break;
    }
    case 'SHOP_SELL_CARD': {
      const card = p.cards[a.slot];
      if (card === undefined) throw new EngineRuleError('INVALID_TARGET', `slot ${a.slot}`);
      const value = sellValue(cardDef(card).price, 1);
      p.cards.splice(a.slot, 1);
      returnCardToDeck(s, card);
      p.points = addU16(p.points, value, mode);
      rec = { op: 'sellCard', card, item: null, qty: 1, points: value };
      break;
    }
    case 'SHOP_SELL_ITEM': {
      const it = a.item;
      if ((p.items[it] ?? 0) < a.qty) throw new EngineRuleError('OUT_OF_RANGE', `own ${p.items[it] ?? 0} < ${a.qty}`);
      const value = sellValue(itemDef(it).price, a.qty);
      removeItem(s, f.seat, it, a.qty);
      p.points = addU16(p.points, value, mode);
      rec = { op: 'sellItem', card: null, item: it, qty: a.qty, points: value };
      break;
    }
    default:
      throw new EngineRuleError('INTENT_NOT_ALLOWED', a.type);
  }
  f.trades.push(rec);
  ctx.emit('SHOP_TRADE', { seat: f.seat, ...rec });
}

export const SHOP: FrameHandler<ShopFrame> = {
  step(ctx, f) {
    switch (f.stage) {
      case 'gift':
        f.stage = 'open';
        chairmanGift(ctx, f);
        f.fullDeck = ctx.player(f.seat).controller === 'ai';
        if (!f.fullDeck) f.shelf = drawShelf(ctx);
        f.entryPoints = ctx.player(f.seat).points;
        return;
      case 'open': {
        const fullDeck = isFullDeck(ctx, f);
        const o = buildShop(ctx.s, f.seat, f.shelf, fullDeck, { entryPoints: f.entryPoints, trades: f.trades });
        if (!shopHasChoice(o)) {
          f.stage = 'done';
          return;
        }
        if (f.trades.length === 0) {
          ctx.emit('SHOP_OPENED', { seat: f.seat, shelf: o.shelf.map((r) => r.card), fullDeck });
        }
        ctx.ask(f, f.seat, 'SHOP', o, { type: 'LEAVE' });
        return;
      }
      case 'done':
        ctx.pop(f);
        return;
    }
  },
  resume(ctx, f, a) {
    if (a.type === 'LEAVE') {
      f.stage = 'done';
      return;
    }
    trade(ctx, f, a);
  },
};
