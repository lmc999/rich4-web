/**
 * 落点码 13：卡片格，按牌堆剩余张数加权抽 1 张（design/engine.md §8）。
 * 满手（15 张）时按 rules.handFull：autoCheapest 先自动弃最便宜的一张；choose 先入手再弹 DISCARD_CARD（effects/common）。
 */
import { gainCard } from '../effects/common';
import { drawFromDeck } from '../rules/inventory';
import type { SquareHandler } from './index';

export const cardSquare: SquareHandler = (ctx, sq) => {
  const card = drawFromDeck(ctx.s);
  if (card === null) return;
  gainCard(ctx, sq.seat, card, 'square');
};
