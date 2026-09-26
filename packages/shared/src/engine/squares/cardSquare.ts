/**
 * 落点码 13：卡片格，按牌堆剩余张数加权抽 1 张（design/engine.md §8）。M1 只抽不用。
 * 满手（15 张）时先自动弃最便宜的一张（handFull='choose' 的 DISCARD_CARD 决策属于 M6 ⚑）。
 */
import { drawFromDeck, makeRoomForCard } from '../rules/inventory';
import type { SquareHandler } from './index';

export const cardSquare: SquareHandler = (ctx, sq) => {
  const card = drawFromDeck(ctx.s);
  if (card === null) return;
  const discarded = makeRoomForCard(ctx.s, sq.seat);
  if (discarded !== null) ctx.emit('CARD_LOST', { seat: sq.seat, card: discarded, cause: 'discard' });
  ctx.player(sq.seat).cards.push(card);
  ctx.emit('CARD_GAINED', { seat: sq.seat, card, source: 'square' });
};
