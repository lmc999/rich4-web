// 背包变化、百货公司进店、小游戏（M8 前端接手前的最简演出）与系统事件。
// M6/M7 的卡片、道具、神明、状态、新闻命运等演出见 cards / items / gods / status / events / endgame。
import { formatEvent } from '../logFormat';
import type { EventHandler } from '../types';
import { brief, silent } from './common';

// card
export const CARD_GAINED: EventHandler<'CARD_GAINED'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line && (e.seat === ctx.me || e.card !== null)) ctx.ui.toast(line);
  ctx.board.floatText({ seat: e.seat }, '🃏', 'info');
  await ctx.wait(400);
};
export const CARD_LOST = brief<'CARD_LOST'>(300);
export const SHOP_OPENED = brief<'SHOP_OPENED'>(300, false);

// item
export const ITEM_GAINED = brief<'ITEM_GAINED'>(400);
export const ITEM_LOST = brief<'ITEM_LOST'>(300);

// minigame（M8 的小游戏容器接手演出）
export const MINIGAME_STARTED = brief<'MINIGAME_STARTED'>(500);
export const MINIGAME_ENDED = brief<'MINIGAME_ENDED'>(900);

// system（不演出）
export const CONTROLLER_CHANGED = silent<'CONTROLLER_CHANGED'>();
export const AI_TRAITS_CHANGED = silent<'AI_TRAITS_CHANGED'>();
export const DEBUG_APPLIED = silent<'DEBUG_APPLIED'>();
export const SYNC = silent<'SYNC'>();
