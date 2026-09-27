/**
 * 公布栏（design/minigames-ai.md §8.1 ③、§9.4 boardList / boardBuy；exe 0x42886e / 0x428a37 / 0x428ae8）：
 * - 挂牌：turnRng('board') % 15 == 0 才挂。手牌 > 12 张时从「成对的卡」表（k 张同名卡进表 k·(k−1) 次）随机挑一张，
 *   标价 = 卡价 × 100 × PI；否则从 数量 ≥ 3、或（数量 > 0 且 f7 − 个性 == 2）的道具里随机挑一件，标价 = 道具价 × 100 × PI。
 *   自己的挂牌已满时先撤下最早的一格（本回合不再挂）。不做重新定价（「1/3 重新定价」未解，DEV-11）。
 * - 购买：turnRng('boardBuy') % 4 == 0 才买；遍历别人的挂牌：股票 round(标价 / 股数) < 现价 → 买；
 *   地产 3 × 估值 > 标价 且 现金 > 2 × 标价 → 买（估值 = (地价 + 等级 × 房价) × PI）。每回合最多成交 1 件（turnLog 保证）。
 */
import { cardDef } from '../../data/tables/cards';
import { CMB } from '../../data/tables/combat';
import { itemDef } from '../../data/tables/items';
import type { CardId, ItemId, PlayerIntent, TurnMenuOptions } from '../../engine/types/index';
import { gateDelta } from '../gate';
import type { AiContext } from '../types';
import type { AiView } from '../view';

const BOARD_LIST_GATE = 15;
const BOARD_BUY_GATE = 4;
const HAND_PAIR_MIN = 12;
const ITEM_SURPLUS = 3;
const PRICE_X = 100;

export function boardList(v: AiView, o: TurnMenuOptions, ctx: AiContext): PlayerIntent | null {
  const rng = ctx.turnRng('board');
  if (rng.mod(BOARD_LIST_GATE) !== 0) return null;
  const board = o.board;
  if (board.mine >= CMB.BOARD_SLOTS) {
    const oldest = board.listings.filter((l) => l.mine).sort((a, b) => a.id - b.id)[0];
    return oldest ? { type: 'BOARD_DELIST', listingId: oldest.id } : null;
  }
  if (!board.canList) return null;
  const me = v.me;
  const cards = me.cards ?? [];
  /** 自己已挂出的数量（卡张数、道具件数） */
  const listed = (pred: (a: TurnMenuOptions['board']['listings'][number]['asset']) => number) =>
    board.listings.reduce((n, l) => (l.mine ? n + pred(l.asset) : n), 0);
  if (cards.length > HAND_PAIR_MIN) {
    const table: CardId[] = [];
    const counts = new Map<CardId, number>();
    for (const c of cards) counts.set(c, (counts.get(c) ?? 0) + 1);
    for (const [c, k] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
      const free = k - listed((a) => (a.t === 'card' && a.card === c ? 1 : 0));
      if (k >= 2 && free > 0) for (let i = 0; i < k * (k - 1); i++) table.push(c);
    }
    if (table.length === 0) return null;
    const card = table[rng.mod(table.length)]!;
    return { type: 'BOARD_LIST', asset: { t: 'card', card }, price: cardDef(card).price * PRICE_X * v.pi };
  }
  const items: ItemId[] = [];
  me.items.forEach((n, i) => {
    if (i === 0 || n <= 0) return;
    const item = i as ItemId;
    const free = n - listed((a) => (a.t === 'item' && a.item === item ? a.qty : 0));
    if (free <= 0) return;
    if (n >= ITEM_SURPLUS || gateDelta(itemDef(item).f7, ctx.traits.personality) === 2) items.push(item);
  });
  if (items.length === 0) return null;
  const item = items[rng.mod(items.length)]!;
  return { type: 'BOARD_LIST', asset: { t: 'item', item, qty: 1 }, price: itemDef(item).price * PRICE_X * v.pi };
}

export function boardBuy(v: AiView, o: TurnMenuOptions, ctx: AiContext): PlayerIntent | null {
  if (ctx.turnRng('boardBuy').mod(BOARD_BUY_GATE) !== 0) return null;
  const me = v.me;
  for (const l of o.board.listings) {
    if (l.mine || !l.affordable) continue;
    const a = l.asset;
    if (a.t === 'stock') {
      const st = v.view.stocks[a.stock];
      if (!st || a.shares <= 0) continue;
      // round(标价 / 股数)（元）< 现价
      const unit = Math.floor((2 * l.price + a.shares) / (2 * a.shares));
      if (unit * 100 < st.priceCents) return { type: 'BOARD_BUY', listingId: l.id };
    } else if (a.t === 'lot') {
      const lot = v.lot(a.lot);
      if (!lot) continue;
      const value = (lot.landPrice + lot.level * lot.housePrice) * v.pi;
      if (3 * value > l.price && me.cash > 2 * l.price) return { type: 'BOARD_BUY', listingId: l.id };
    }
  }
  return null;
}
