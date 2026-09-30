// 卡片演出（design/client.md §4.5 cardUsed）：施放姿势 + 亮卡（CardCastPopup；原版皮肤是卡片插画 + 消息框）+ 光束连到目标；
// 被动卡（免罪、嫁祸、复仇、免费）生效时同样亮卡；卡片没有效果。
// 亮卡时长按房间的演出节奏取 shared/view/pacing 的 CARD_SHOW_MS：original 节奏是原版亮卡函数 fcn.00440bac 的 1.5 秒
// （0x440ce4），compact 节奏 1.2 秒（出卡）/ 0.95 秒（被动卡）；服务器按同一张表算截止时间。
// 出卡、被动卡的弹窗对本人、其他玩家、观战者与电脑出卡都一样（都由 CARD_USED / PASSIVE 事件驱动）。
// 原版亮卡（fcn.00440bac：画消息框、写字、贴卡图、播 Effect#62，然后静止 1.5 秒）期间棋盘上没有别的演出：弹窗用原版
// 画面时（popupStore.opensClassic）不叠网页版的气泡、粒子、光束与飘字；卡片台词在亮卡结束之后才说（soundMap 标
// timed，这里经 ctx.audio.voices 放出），与原版「亮卡返回 → 扣卡 → fcn.0044d870 说台词」同序。
import {
  CARD,
  CARD_KEYS,
  type CardId,
  type GameEventOf,
  type PassiveContext,
  type SeatIndex,
  type UseTarget,
} from '@rich4/shared/engine';
import { CARD_SHOW_MS, CARD_SHOW_TAIL_MS } from '@rich4/shared/view';
import { CARD_CATEGORY, type CardCategory } from '../../ui/components/cardVisuals';
import { type CardCastPopupSpec, opensClassic } from '../../ui/popups/popupStore';
import type { Anchor, EventHandler, PresentationContext } from '../types';
import { currentPacing } from './budget';
import { showAllDeltas, syncFromPost } from './common';
import { playerRef, showPopup } from './popups';
import { stageOf } from './stage';

/** 出卡弹窗的展示时长（1x，compact 节奏；当前房间节奏下的取值见 cardShowMs） */
export const CARD_POPUP_MS = CARD_SHOW_MS.compact.castMs;

/** 当前演出节奏下亮卡的展示时长（1x） */
export function cardShowMs(kind: 'cast' | 'passive'): number {
  const t = CARD_SHOW_MS[currentPacing()];
  return kind === 'cast' ? t.castMs : t.passiveMs;
}
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

/** 亮卡结束：说出本事件的卡片台词（soundMap 里标 timed；演出已中止时不说） */
function speakAfterShow(e: GameEventOf<'CARD_USED'> | GameEventOf<'PASSIVE'>, ctx: PresentationContext): void {
  if (!ctx.signal.aborted) ctx.audio.voices?.(e);
}

export const CARD_USED: EventHandler<'CARD_USED'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const who = ctx.names.seat(e.seat);
  const tgt = targetText(ctx, e.target);
  const spec = castSpec(ctx, e.seat, e.card, 'cast', ctx.t('events:popup.cardUsed', { who }), tgt);
  // 原版亮卡：棋盘静止，不放粒子与光束
  const classic = spec !== null && opensClassic(spec);
  ctx.board.setActorPose(e.seat, 'cast');
  const ms = cardShowMs('cast');
  const popup = (spec ? showPopup(ctx, spec, ms, 700) : ctx.wait(ms)).then(() => speakAfterShow(e, ctx));
  const to = targetAnchor(ctx, e.seat, e.target);
  const fx = classic
    ? Promise.resolve()
    : (async () => {
        await ctx.wait(CARD_BEAM_DELAY_MS);
        stage.burst({ seat: e.seat }, cardBeamColor(e.card), 10);
        if (to) await stage.beam({ seat: e.seat }, to, cardBeamColor(e.card), ctx.signal);
      })();
  await Promise.all([popup, fx]);
  ctx.board.setActorPose(e.seat, 'idle');
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(CARD_SHOW_TAIL_MS);
};

export const CARD_NO_EFFECT: EventHandler<'CARD_NO_EFFECT'> = async (e, ctx) => {
  const spec = castSpec(ctx, e.seat, e.card, 'fizzle', ctx.t('events:popup.cardFizzle'), null);
  // 原版画面（卡图置灰 + 消息框）已写明没有效果，棋盘上不再飘字
  if (!(spec && opensClassic(spec))) ctx.board.floatText({ seat: e.seat }, ctx.t('events:bubble.fizzle'), 'info');
  if (spec) await showPopup(ctx, spec, 650, 400);
  else await ctx.wait(650);
};

/**
 * 被动卡生效的说明：免费 / 免罪是「免去」（passiveCtx），嫁祸是「转嫁」，复仇是「出卡者也中招」
 * （engine/effects/cards/harm.ts 的 revenge 段：陷害 → 出卡者也坐牢，梦游 → 出卡者也梦游）
 */
export function passiveDesc(ctx: PresentationContext, card: CardId, context: PassiveContext): string {
  if (card === CARD.SCAPEGOAT) return ctx.t(`events:passiveScapegoat.${context}`, { defaultValue: '' });
  if (card === CARD.REVENGE) {
    return ctx.t(`events:passiveRevenge.${context}`, { defaultValue: ctx.t('events:passiveRevenge.generic') });
  }
  return ctx.t(`events:passiveCtx.${context}`, { defaultValue: '' });
}

export const PASSIVE: EventHandler<'PASSIVE'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = ctx.t(`events:passive.${e.card}`, { defaultValue: ctx.t('events:passive.generic') });
  const desc = passiveDesc(ctx, e.card, e.context);
  const spec = castSpec(ctx, e.seat, e.card, 'passive', ctx.t('events:popup.cardPassive'), null, desc || undefined);
  // 原版亮卡：框里已写「XX卡生效！」，持卡人头顶不再冒气泡与粒子（气泡原来夹在消息框与卡图之间）
  if (!(spec && opensClassic(spec))) {
    stage.burst({ seat: e.seat }, cardBeamColor(e.card), 16);
    stage.bubble({ seat: e.seat }, line, 1000);
  }
  ctx.board.setActorPose(e.seat, 'cheer');
  const ms = cardShowMs('passive');
  if (spec) await showPopup(ctx, spec, ms, 600);
  else await ctx.wait(ms);
  speakAfterShow(e, ctx);
  ctx.board.setActorPose(e.seat, 'idle');
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(CARD_SHOW_TAIL_MS);
};
