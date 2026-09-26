// 卡片、道具、神明、状态、新闻命运等后续里程碑（M6/M7）的规则事件：先给最简演出（toast / 日志 + 棋盘同步），
// 预算内收尾；真正的特效在对应里程碑替换。
import { formatEvent } from '../logFormat';
import type { EventHandler } from '../types';
import { brief, silent, syncFromPost } from './common';

// card
export const CARD_GAINED: EventHandler<'CARD_GAINED'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line && (e.seat === ctx.me || e.card !== null)) ctx.ui.toast(line);
  ctx.board.floatText({ seat: e.seat }, '🃏', 'info');
  await ctx.wait(400);
};
export const CARD_LOST = brief<'CARD_LOST'>(300);
export const CARD_USED = brief<'CARD_USED'>(900);
export const CARD_NO_EFFECT = brief<'CARD_NO_EFFECT'>(500);
export const PASSIVE = brief<'PASSIVE'>(800);
export const SHOP_OPENED = brief<'SHOP_OPENED'>(300, false);

// item
export const ITEM_GAINED = brief<'ITEM_GAINED'>(400);
export const ITEM_LOST = brief<'ITEM_LOST'>(300);
export const ITEM_USED = brief<'ITEM_USED'>(800);
export const VEHICLE = brief<'VEHICLE'>(600);
export const VEHICLE_DESTROYED = brief<'VEHICLE_DESTROYED'>(700);
export const OBJECT_PLACED = brief<'OBJECT_PLACED'>(400, false);
export const OBJECT_REMOVED = brief<'OBJECT_REMOVED'>(300, false);
export const DOLL_WALK = brief<'DOLL_WALK'>(600);
export const BOMB_ATTACHED = brief<'BOMB_ATTACHED'>(600);
export const BOMB_TRANSFERRED = brief<'BOMB_TRANSFERRED'>(600);
export const BOMB_EXPLODED: EventHandler<'BOMB_EXPLODED'> = async (e, ctx) => {
  ctx.board.shake(10, 500);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  syncFromPost(ctx, e.post);
  await ctx.wait(1000);
};
export const STRIKE: EventHandler<'STRIKE'> = async (e, ctx) => {
  await ctx.board.focus({ tile: e.center }, 400, ctx.signal);
  ctx.board.shake(12, 600);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  syncFromPost(ctx, e.post);
  await ctx.wait(1000);
};
export const TELEPORTED = brief<'TELEPORTED'>(900);
export const TIME_REWOUND: EventHandler<'TIME_REWOUND'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  ctx.ui.toast(line ?? ctx.t('events:show.timeRewound'), 'warn');
  await ctx.wait(700);
};

// god
export const GOD_ATTACHED = brief<'GOD_ATTACHED'>(900);
export const GOD_POWER = brief<'GOD_POWER'>(1200);
export const GOD_LEFT = brief<'GOD_LEFT'>(500);
export const GOD_SPAWNED = brief<'GOD_SPAWNED'>(300, false);
export const GOD_MANIFEST = brief<'GOD_MANIFEST'>(1000);
export const DOG_BITE = brief<'DOG_BITE'>(900);
export const DOG_KNOCKED = brief<'DOG_KNOCKED'>(500);
export const DEATH_GOD_SUMMONED = brief<'DEATH_GOD_SUMMONED'>(1000);

// status
export const CONFINED: EventHandler<'CONFINED'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  if (e.actor.t === 'seat') ctx.board.setActorPose(e.actor.seat, 'hurt');
  await ctx.wait(600);
  syncFromPost(ctx, e.post);
  if (e.actor.t === 'seat') ctx.board.setActorPose(e.actor.seat, 'idle');
  await ctx.wait(300);
};
export const BLESSING = brief<'BLESSING'>(700);
export const STATUS_SET = brief<'STATUS_SET'>(400);
export const ALLIANCE_FORMED = brief<'ALLIANCE_FORMED'>(700);
export const ALLIANCE_BROKEN = brief<'ALLIANCE_BROKEN'>(600);
export const ALLIANCE_EXPIRED = brief<'ALLIANCE_EXPIRED'>(400);
export const BANK_REJECTED = brief<'BANK_REJECTED'>(600);

// event
export const NEWS = brief<'NEWS'>(1800);
export const FATE = brief<'FATE'>(1400);
export const MAGIC_CONDITION = brief<'MAGIC_CONDITION'>(1000);
export const MAGIC_CAST = brief<'MAGIC_CAST'>(1000);
export const MINIGAME_STARTED = brief<'MINIGAME_STARTED'>(500);
export const MINIGAME_ENDED = brief<'MINIGAME_ENDED'>(900);
export const BAIL = brief<'BAIL'>(600);
export const VILLAIN_HIRED = brief<'VILLAIN_HIRED'>(600);
export const VILLAIN_ACTION = brief<'VILLAIN_ACTION'>(900);
export const VILLAIN_HOME = brief<'VILLAIN_HOME'>(300, false);
export const BEGGAR_ALMS = brief<'BEGGAR_ALMS'>(700);

// system（不演出）
export const CONTROLLER_CHANGED = silent<'CONTROLLER_CHANGED'>();
export const AI_TRAITS_CHANGED = silent<'AI_TRAITS_CHANGED'>();
export const DEBUG_APPLIED = silent<'DEBUG_APPLIED'>();
export const SYNC = silent<'SYNC'>();
