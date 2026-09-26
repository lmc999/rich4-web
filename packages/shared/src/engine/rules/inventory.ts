/**
 * 手牌与道具（design/engine.md §2 rules/inventory.ts；docs/research/g_arbitration.md §1、§2.g）。
 * - 手牌上限 15。已满时（handFull='autoCheapest'）先自动弃掉手中最便宜的一张（同价取槽位靠前的），新卡一定入手。
 *   handFull='choose'（MANUAL，弹 DISCARD_CARD）属于 M6，M1 先按 autoCheapest 处理 ⚑。
 * - 牌堆守恒：使用、被动消耗、卖出、弃牌、没收的卡都回到牌堆（pools.cards）。
 * - 道具：每种最多 9 个；1..8 从全局库存（pools.items）扣，9..13 不受库存限制。
 * 纯状态变换：不发事件，由调用方先改再 emit。
 */
import { cardDef } from '../../data/tables/cards';
import { ECON } from '../../data/tables/economy';
import { type CardId, type ItemId, isPoolItem } from '../../data/tables/ids';
import { divTrunc } from '../../util/int32';
import { drawCardId } from '../core/random';
import type { SeatIndex } from '../types/ids';
import type { GameState } from '../types/state';
import { playerAt } from './payment';

export const HAND_MAX = ECON.HAND_MAX;
export const ITEM_MAX = ECON.ITEM_MAX;

/** 手中最便宜的一张的槽位（同价取靠前）；空手返回 -1 */
export function cheapestCardSlot(cards: readonly CardId[]): number {
  let best = -1;
  let bestPrice = Number.POSITIVE_INFINITY;
  for (let i = 0; i < cards.length; i++) {
    const price = cardDef(cards[i]!).price;
    if (price < bestPrice) {
      best = i;
      bestPrice = price;
    }
  }
  return best;
}

export function returnCardToDeck(s: GameState, card: CardId): void {
  s.pools.cards[card] = (s.pools.cards[card] ?? 0) + 1;
}

/** 从牌堆按剩余张数加权抽一张并扣减；牌堆空返回 null */
export function drawFromDeck(s: GameState): CardId | null {
  const c = drawCardId(s, 'deck');
  if (c === null) return null;
  s.pools.cards[c] = s.pools.cards[c]! - 1;
  return c;
}

/** 从牌堆取出指定的卡（调试 give 用）；牌堆里没有返回 false */
export function takeFromDeck(s: GameState, card: CardId): boolean {
  if ((s.pools.cards[card] ?? 0) <= 0) return false;
  s.pools.cards[card] = s.pools.cards[card]! - 1;
  return true;
}

export interface ReceiveCardResult {
  /** 因满手被自动弃掉的卡（已回牌堆）；没有则 null */
  discarded: CardId | null;
}

/** 满手时弃掉最便宜的一张（回牌堆），返回被弃的卡；未满返回 null */
export function makeRoomForCard(s: GameState, seat: SeatIndex): CardId | null {
  const p = playerAt(s, seat);
  if (p.cards.length < HAND_MAX) return null;
  const slot = cheapestCardSlot(p.cards);
  const discarded = p.cards[slot]!;
  p.cards.splice(slot, 1);
  returnCardToDeck(s, discarded);
  return discarded;
}

/** 卡进手牌（卡已离开牌堆）；满手时先弃最便宜的一张 */
export function receiveCard(s: GameState, seat: SeatIndex, card: CardId): ReceiveCardResult {
  const discarded = makeRoomForCard(s, seat);
  playerAt(s, seat).cards.push(card);
  return { discarded };
}

/** 道具进背包：不超过 9 个；1..8 须从库存扣。返回实际得到的数量 */
export function receiveItem(s: GameState, seat: SeatIndex, item: ItemId, qty: number): number {
  const p = playerAt(s, seat);
  let n = Math.min(qty, ITEM_MAX - (p.items[item] ?? 0));
  if (isPoolItem(item)) n = Math.min(n, s.pools.items[item] ?? 0);
  if (n <= 0) return 0;
  p.items[item] = (p.items[item] ?? 0) + n;
  if (isPoolItem(item)) s.pools.items[item] = s.pools.items[item]! - n;
  return n;
}

/** 道具离开背包：1..8 回库存，9..13 直接消失。返回实际移除的数量 */
export function removeItem(s: GameState, seat: SeatIndex, item: ItemId, qty: number): number {
  const p = playerAt(s, seat);
  const n = Math.min(qty, p.items[item] ?? 0);
  if (n <= 0) return 0;
  p.items[item] = p.items[item]! - n;
  if (isPoolItem(item)) s.pools.items[item] = (s.pools.items[item] ?? 0) + n;
  return n;
}

/** 卖回价 = trunc(标价 × 数量 × 9 / 10) */
export function sellValue(price: number, qty: number): number {
  return divTrunc(price * qty * ECON.SELL_RATE_NUM, ECON.SELL_RATE_DEN);
}
