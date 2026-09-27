// 卡片演出（design/client.md §4.5 cardUsed）：施放姿势 + 卡片放大翻面（CardCastPopup 1.2 秒）+ 光束连到目标；
// 被动卡（免罪、嫁祸、复仇、免费）生效提示；卡片没有效果。
import { CARD_KEYS, type CardId, type SeatIndex, type UseTarget } from '@rich4/shared/engine';
import { CARD_CATEGORY, type CardCategory } from '../../ui/components/cardVisuals';
import type { CardCastPopupSpec } from '../../ui/popups/popupStore';
import type { Anchor, EventHandler, PresentationContext } from '../types';
import { showAllDeltas, syncFromPost } from './common';
import { playerRef, showPopup } from './popups';
import { stageOf } from './stage';

/** CardCastPopup 的展示时长（1x） */
export const CARD_POPUP_MS = 1200;
/** 光束在弹窗出现后多久射出 */
export const CARD_BEAM_DELAY_MS = 360;

/** 光束颜色（按卡片类别，与卡框配色一致） */
export const CATEGORY_BEAM: Readonly<Record<CardCategory, number>> = {
  attack: 0xf2545b,
  defense: 0x3d8bfd,
  economy: 0xffd84d,
  move: 0x5cc85a,
  god: 0x9b6bff,
  property: 0xff9f43,
};

export function cardBeamColor(card: CardId): number {
  return CATEGORY_BEAM[CARD_CATEGORY[card]];
}

/** 目标在棋盘上的位置（光束终点）；没有具体位置的目标（股票、骰子、全体）为 null */
export function targetAnchor(ctx: PresentationContext, user: SeatIndex, t: UseTarget): Anchor | null {
  switch (t.t) {
    case 'seat':
    case 'rob':
      return { seat: t.seat };
    case 'actor':
      return t.actor.t === 'seat' ? { seat: t.actor.seat } : stageOf(ctx).villainAnchor(t.actor.kind);
    case 'lot':
      return { lot: t.lot };
    case 'lotPair':
      return { lot: t.to };
    case 'underfoot':
      return { seat: user };
    case 'object': {
      const o = ctx.view().objects.find((x) => x.id === t.object);
      return o ? { tile: o.node } : null;
    }
    case 'node':
      return { tile: t.node };
    case 'teleport':
      return t.dest.k === 'road' ? { tile: t.dest.node } : { lot: t.dest.lot };
    case 'none':
    case 'stock':
    case 'dice':
      return null;
  }
}

/** 目标的文字说明（弹窗「目标：…」） */
export function targetText(ctx: PresentationContext, t: UseTarget): string | null {
  const n = ctx.names;
  switch (t.t) {
    case 'none':
      return null;
    case 'seat':
    case 'rob':
      return n.seat(t.seat);
    case 'actor':
      return n.actor(t.actor);
    case 'lot':
      return n.lot(t.lot);
    case 'underfoot':
      return ctx.t('events:popup.underfoot');
    case 'lotPair':
      return `${n.lot(t.from)} ⇄ ${n.lot(t.to)}`;
    case 'object': {
      const o = ctx.view().objects.find((x) => x.id === t.object);
      return o ? ctx.t(`items:object.${o.kind}`) : null;
    }
    case 'stock':
      return n.stock(t.stock);
    case 'node':
      return n.tile(t.node);
    case 'dice':
      return ctx.t('events:popup.diceValue', { n: t.value });
    case 'teleport':
      return t.dest.k === 'road' ? n.tile(t.dest.node) : n.lot(t.dest.lot);
  }
}

function castSpec(
  ctx: PresentationContext,
  seat: SeatIndex,
  card: CardId,
  variant: CardCastPopupSpec['variant'],
  title: string,
  target: string | null,
  desc?: string,
): CardCastPopupSpec | null {
  const player = playerRef(ctx, seat);
  if (!player) return null;
  return {
    kind: 'cardCast',
    player,
    card,
    cardName: ctx.names.card(card),
    desc: desc ?? ctx.t(`cards:${CARD_KEYS[card]}.desc`, { defaultValue: '' }),
    title,
    targetText: target,
    variant,
  };
}

export const CARD_USED: EventHandler<'CARD_USED'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const who = ctx.names.seat(e.seat);
  const tgt = targetText(ctx, e.target);
  const spec = castSpec(ctx, e.seat, e.card, 'cast', ctx.t('events:popup.cardUsed', { who }), tgt);
  ctx.board.setActorPose(e.seat, 'cast');
  const popup = spec ? showPopup(ctx, spec, CARD_POPUP_MS, 700) : ctx.wait(CARD_POPUP_MS);
  const to = targetAnchor(ctx, e.seat, e.target);
  const fx = (async () => {
    await ctx.wait(CARD_BEAM_DELAY_MS);
    stage.burst({ seat: e.seat }, cardBeamColor(e.card), 10);
    if (to) await stage.beam({ seat: e.seat }, to, cardBeamColor(e.card), ctx.signal);
  })();
  await Promise.all([popup, fx]);
  ctx.board.setActorPose(e.seat, 'idle');
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(100);
};

export const CARD_NO_EFFECT: EventHandler<'CARD_NO_EFFECT'> = async (e, ctx) => {
  const spec = castSpec(ctx, e.seat, e.card, 'fizzle', ctx.t('events:popup.cardFizzle'), null);
  ctx.board.floatText({ seat: e.seat }, ctx.t('events:bubble.fizzle'), 'info');
  if (spec) await showPopup(ctx, spec, 650, 400);
  else await ctx.wait(650);
};

export const PASSIVE: EventHandler<'PASSIVE'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = ctx.t(`events:passive.${e.card}`, { defaultValue: ctx.t('events:passive.generic') });
  const desc = ctx.t(`events:passiveCtx.${e.context}`, { defaultValue: '' });
  const spec = castSpec(ctx, e.seat, e.card, 'passive', ctx.t('events:popup.cardPassive'), null, desc || undefined);
  stage.burst({ seat: e.seat }, cardBeamColor(e.card), 16);
  stage.bubble({ seat: e.seat }, line, 1000);
  ctx.board.setActorPose(e.seat, 'cheer');
  if (spec) await showPopup(ctx, spec, 950, 600);
  else await ctx.wait(950);
  ctx.board.setActorPose(e.seat, 'idle');
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(100);
};
