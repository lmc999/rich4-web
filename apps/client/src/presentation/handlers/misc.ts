// 背包变化、百货公司进店、小游戏（M8 前端接手前的最简演出）与系统事件。
// M6/M7 的卡片、道具、神明、状态、新闻命运等演出见 cards / items / gods / status / events / endgame。
import type { GameEvent, GameEventOf } from '@rich4/shared/engine';
import { CARD_GAIN_FOCUS_MS, CARD_SHOW_MS, CARD_SHOW_TAIL_MS, cardGainShows } from '@rich4/shared/view';
import { type CardCastPopupSpec, classicPopupHostActive, opensClassic } from '../../ui/popups/popupStore';
import { formatEvent } from '../logFormat';
import { CARD_SHOW_SFX } from '../soundMap';
import type { EventHandler, PresentationContext } from '../types';
import { currentPacing } from './budget';
import { brief, silent, syncFromPost } from './common';
import { playerRef, showPopup } from './popups';
import { stageOf } from './stage';

/**
 * 得卡亮卡的弹窗（卡片格 / 聖誕節；card 为 null 时是私密手牌下的别人：只有消息框）；其余来源、得卡人不在场时 null
 */
export function cardGainSpec(ctx: PresentationContext, e: GameEventOf<'CARD_GAINED'>): CardCastPopupSpec | null {
  if (!cardGainShows(e.source)) return null;
  const player = playerRef(ctx, e.seat);
  if (!player) return null;
  return {
    kind: 'cardCast',
    player,
    card: e.card,
    cardName: e.card === null ? '' : ctx.names.card(e.card),
    desc: '',
    title: ctx.t('events:popup.cardGained', { who: player.name }),
    targetText: null,
    variant: 'gain',
    gainFrom: e.source === 'holiday' ? 'holiday' : 'square',
  };
}

// card
/**
 * 得卡。原版只在卡片格（FLIC Data#495 之后 0x41abfa 亮卡）与聖誕節送卡（镜头移到这位玩家 → 0x450e29 亮卡）亮大卡，
 * 停 1.5 秒（shared/view/pacing 的 CARD_SHOW_MS.gainMs），亮完按卡价说事件槽台词（soundMap 标 timed）：
 * - 原版皮肤（亮卡就绪，popupStore.opensClassic）：FLIC / 镜头 → 亮卡（Effect#62）→ 台词；不弹 toast、不飘 🃏（框里已写明）；
 *   私密手牌下别人看到的是「XX 得到一張卡片！」的消息框（没有卡图，也不说按卡价分档的台词），时长相同；
 * - 其余（程序化皮肤、其他得卡途径、素材未就绪）：toast（看得到卡号的人）+ 程序化皮肤的 🃏 飘字，卡片格的 FLIC 与等待并行。
 */
export const CARD_GAINED: EventHandler<'CARD_GAINED'> = async (e, ctx) => {
  const spec = cardGainSpec(ctx, e);
  if (spec && opensClassic(spec)) {
    if (e.source === 'square') await stageOf(ctx).eventFlic?.(e, ctx.signal);
    else await ctx.board.focus({ seat: e.seat }, CARD_GAIN_FOCUS_MS, ctx.signal);
    if (ctx.signal.aborted) return;
    ctx.audio.cue?.(CARD_SHOW_SFX);
    await showPopup(ctx, spec, CARD_SHOW_MS[currentPacing()].gainMs, 0);
    // 原版亮卡返回后按卡价说事件槽台词（0x41ac13 / 0x450e3c fcn.0044db5f）；私密下别人没有卡号，不说
    if (!ctx.signal.aborted && e.card !== null) ctx.audio.voices?.(e);
    await ctx.wait(CARD_SHOW_TAIL_MS);
    return;
  }
  const line = formatEvent(e, ctx.names);
  if (line && (e.seat === ctx.me || e.card !== null)) ctx.ui.toast(line);
  // 原版皮肤没有头顶飘字（🃏 画出来是扑克牌，像一张没贴图的卡）
  if (!classicPopupHostActive()) ctx.board.floatText({ seat: e.seat }, '🃏', 'info');
  // 聖誕節的音效在 soundMap 里标 timed（亮卡时才放）：不亮卡时这里补放
  if (e.source === 'holiday') ctx.audio.cue?.(CARD_SHOW_SFX);
  // 原版皮肤：卡片格得卡的 FLIC（问号卡片翻出）与等待并行
  await Promise.all([ctx.wait(400), stageOf(ctx).eventFlic?.(e, ctx.signal)]);
  if (!ctx.signal.aborted && e.card !== null && cardGainShows(e.source)) ctx.audio.voices?.(e);
};
export const CARD_LOST = brief<'CARD_LOST'>(300);
export const SHOP_OPENED = brief<'SHOP_OPENED'>(300, false);

// item：私密手牌模式（联机）下别人的道具种类为 null，与 CARD_GAINED 一样不弹提示（日志照记「获得 道具 ×N」）
function itemChange<T extends 'ITEM_GAINED' | 'ITEM_LOST'>(ms: number): EventHandler<T> {
  return async (e, ctx) => {
    const line = formatEvent(e as GameEvent, ctx.names);
    if (line && (e.seat === ctx.me || e.item !== null)) ctx.ui.toast(line);
    syncFromPost(ctx, e.post);
    await ctx.wait(ms);
  };
}
export const ITEM_GAINED = itemChange<'ITEM_GAINED'>(400);
export const ITEM_LOST = itemChange<'ITEM_LOST'>(300);

// minigame（M8 的小游戏容器接手演出）
export const MINIGAME_STARTED = brief<'MINIGAME_STARTED'>(500);
export const MINIGAME_ENDED = brief<'MINIGAME_ENDED'>(900);

// system（不演出）
export const CONTROLLER_CHANGED = silent<'CONTROLLER_CHANGED'>();
export const AI_TRAITS_CHANGED = silent<'AI_TRAITS_CHANGED'>();
export const DEBUG_APPLIED = silent<'DEBUG_APPLIED'>();
export const SYNC = silent<'SYNC'>();
