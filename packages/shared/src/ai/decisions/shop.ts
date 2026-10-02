/**
 * SHOP（百货公司；design/minigames-ai.md §9.7；@0x42ed8d..0x42f307 为 v3.11 地址，v2.06 为 0x42e181..0x42e6ea）。
 * 电脑座位面对整副牌堆（options.fullDeck）。道具每种每次进店最多买 1 件（引擎同样只接受 qty 1、不能重复买）。
 * 原版一次进店把整套流程做完；引擎每笔交易后重发 SHOP，所以这里每次按 options（含本次进店的交易记录 visit.trades）
 * 推算下一步，保证与一次做完的结果一致：
 *   S1 逐槽卖掉 f7 − 个性 == 2 的卡；S2 f7 − 个性 == 2 的道具整种卖光；
 *   S3 进店点券 < 100 时：卖掉最便宜的一张卡（只卖一次）、每种道具多于 1 件的卖到剩 1 件、卖掉与当前座驾同类的车；
 *   点券为 0 → 离店；
 *   C  卡预算 = P >> 1（P = 开始买时的点券）：牌堆中价格 ≤ 剩余预算且 f7 − 个性 ≠ 2 的卡按价格降序逐种各买一张，满 15 张停；
 *   V  道具预算 = P − (P >> 1)：机车（当前不是机车、手里没有机车、80 < 剩余预算、库存有）→ 买；汽车同理，门槛 150；
 *   T  按 [遥控骰子, 路障, 飞弹, 机器娃娃, 定时炸弹, 地雷] 各买一件（持有 < 9、f7 − 个性 ≠ 2、价格 ≤ 剩余预算、库存 > 0）。
 * 例：步行、满手 15 张、点券 460 → V 预算 230：先买机车（余 150），汽车要求 150 < 150 不成立；点券 461 → 余 151，买得到汽车。
 */
import { cardDef } from '../../data/tables/cards';
import { ITEM } from '../../data/tables/ids';
import { itemDef } from '../../data/tables/items';
import type { ItemId, PlayerIntent, ShopOptions } from '../../engine/types/index';
import type { DecisionForYou } from '../../view/types';
import { SHOP_LOW_POINTS, SHOP_TOOL_ORDER } from '../constants';
import type { AiContext } from '../types';
import type { AiView } from '../view';

const NEVER = 2;

function itemOwn(v: AiView, o: ShopOptions, item: ItemId): number {
  const row = o.items.find((r) => r.item === item);
  return row ? row.own : (v.me.items?.[item] ?? 0);
}

/** 卖出阶段（S1–S3）的下一笔；没有返回 null */
function sellStep(v: AiView, o: ShopOptions, p: number): PlayerIntent | null {
  // S1
  for (const c of o.sell.cards) if (cardDef(c.card).f7 - p === NEVER) return { type: 'SHOP_SELL_CARD', slot: c.slot };
  // S2
  for (const it of o.sell.items) {
    if (itemDef(it.item).f7 - p === NEVER) return { type: 'SHOP_SELL_ITEM', item: it.item, qty: it.count };
  }
  // S3：进店点券 < 100，且还没开始买
  const trades = o.visit.trades;
  if (o.visit.entryPoints >= SHOP_LOW_POINTS || trades.some((t) => t.op === 'buyCard' || t.op === 'buyItem')) {
    return null;
  }
  const soldCheapest = trades.some((t) => t.op === 'sellCard' && t.card !== null && cardDef(t.card).f7 - p !== NEVER);
  if (!soldCheapest && o.sell.cards.length > 0) {
    let best = o.sell.cards[0]!;
    for (const c of o.sell.cards) if (cardDef(c.card).price < cardDef(best.card).price) best = c;
    return { type: 'SHOP_SELL_CARD', slot: best.slot };
  }
  for (const it of o.sell.items) if (it.count > 1) return { type: 'SHOP_SELL_ITEM', item: it.item, qty: it.count - 1 };
  const vehicleItem = v.me.vehicle === 'moto' ? ITEM.MOTORCYCLE : v.me.vehicle === 'car' ? ITEM.CAR : null;
  if (vehicleItem !== null) {
    const it = o.sell.items.find((x) => x.item === vehicleItem);
    if (it) return { type: 'SHOP_SELL_ITEM', item: it.item, qty: it.count };
  }
  return null;
}

/** 买入阶段（C、V、T）的下一笔；没有返回 null */
function buyStep(v: AiView, o: ShopOptions, p: number): PlayerIntent | null {
  const trades = o.visit.trades;
  let spentCards = 0;
  let spentItems = 0;
  const boughtCards = new Set<number>();
  const boughtItems = new Set<number>();
  for (const t of trades) {
    if (t.op === 'buyCard' && t.card !== null) {
      spentCards += t.points;
      boughtCards.add(t.card);
    } else if (t.op === 'buyItem' && t.item !== null) {
      spentItems += t.points;
      boughtItems.add(t.item);
    }
  }
  const start = o.points + spentCards + spentItems;
  // C：卡
  const cardLeft = (start >> 1) - spentCards;
  if (o.handCount < o.handMax) {
    const rows = o.shelf
      .filter((r) => r.buyable && !boughtCards.has(r.card) && cardDef(r.card).f7 - p !== NEVER && r.price <= cardLeft)
      .sort((a, b) => (b.price !== a.price ? b.price - a.price : a.card - b.card || a.idx - b.idx));
    const first = rows[0];
    if (first) return { type: 'SHOP_BUY_CARD', shelfIdx: first.idx };
  }
  // V：交通工具
  const itemLeft = start - (start >> 1) - spentItems;
  const can = (item: ItemId) => (o.items.find((r) => r.item === item)?.maxQty ?? 0) > 0;
  const me = v.me;
  if (me.vehicle !== 'moto' && itemOwn(v, o, ITEM.MOTORCYCLE) === 0 && itemDef(ITEM.MOTORCYCLE).price < itemLeft) {
    if (can(ITEM.MOTORCYCLE)) return { type: 'SHOP_BUY_ITEM', item: ITEM.MOTORCYCLE, qty: 1 };
  }
  if ((me.vehicle === 'walk' || me.vehicle === 'moto') && itemOwn(v, o, ITEM.CAR) === 0) {
    if (itemDef(ITEM.CAR).price < itemLeft && can(ITEM.CAR)) return { type: 'SHOP_BUY_ITEM', item: ITEM.CAR, qty: 1 };
  }
  // T：其余道具
  for (const id of SHOP_TOOL_ORDER) {
    const item = id as ItemId;
    if (boughtItems.has(item) || itemDef(item).f7 - p === NEVER) continue;
    const row = o.items.find((r) => r.item === item);
    if (!row || row.maxQty <= 0 || row.own >= 9 || row.price > itemLeft) continue;
    return { type: 'SHOP_BUY_ITEM', item, qty: 1 };
  }
  return null;
}

export function shop(v: AiView, d: DecisionForYou<'SHOP'>, ctx: AiContext): PlayerIntent {
  const o = d.options;
  if (o.visit.remaining <= 0) return { type: 'LEAVE' };
  const p = ctx.traits.personality;
  const sell = sellStep(v, o, p);
  if (sell) return sell;
  if (o.points <= 0) return { type: 'LEAVE' };
  return buyStep(v, o, p) ?? { type: 'LEAVE' };
}
