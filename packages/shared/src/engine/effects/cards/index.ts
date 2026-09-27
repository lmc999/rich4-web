/**
 * 30 张卡片的效果注册表（design/engine.md §10.1–§10.3）：CARD_EFFECTS 用 satisfies 对 CardId 穷举。
 * CARD_CHAINS：需要跨决策的多步效果，由 CARD 帧（flow/card.ts）按 card 分派（梦游链、查税链）。
 */
import type { CardId } from '../../../data/tables/ids';
import type { Ctx } from '../../core/ctx';
import type { FrameOf } from '../../types/frames';
import type { PlayerAction } from '../../types/intent';
import type { CardEffect } from '../types';
import { alliance, hibernate, stay, tortoise, turnAround } from './control';
import { dispelGod, summonGod } from './god';
import { frame, sleepwalk, sleepwalkChain } from './harm';
import {
  angel,
  auction,
  buyLand,
  demolish,
  devil,
  monster,
  raisePrice,
  rebuild,
  seal,
  swapHouse,
  swapLand,
} from './land';
import { equalPoverty, equalWealth, rob, taxAudit, taxChain } from './money';
import { passiveCard } from './passive';
import { blackCard, redCard } from './stock';

export const CARD_EFFECTS = Object.freeze({
  1: equalWealth,
  2: equalPoverty,
  3: buyLand,
  4: swapLand,
  5: swapHouse,
  6: turnAround,
  7: rebuild,
  8: auction,
  9: angel,
  10: devil,
  11: monster,
  12: demolish,
  13: rob,
  14: stay,
  15: hibernate,
  16: sleepwalk,
  17: frame,
  18: passiveCard,
  19: passiveCard,
  20: passiveCard,
  21: passiveCard,
  22: dispelGod,
  23: summonGod,
  24: redCard,
  25: blackCard,
  26: taxAudit,
  27: raisePrice,
  28: seal,
  29: alliance,
  30: tortoise,
} satisfies { readonly [C in CardId]: CardEffect });

export function cardEffect(card: CardId): CardEffect {
  return CARD_EFFECTS[card];
}

export interface CardChain {
  step(ctx: Ctx, f: FrameOf<'CARD'>): void;
  resume(ctx: Ctx, f: FrameOf<'CARD'>, a: PlayerAction, kind: string, options: unknown): void;
}

export const CARD_CHAINS: Readonly<Partial<Record<CardId, CardChain>>> = Object.freeze({
  16: sleepwalkChain,
  26: taxChain,
});
