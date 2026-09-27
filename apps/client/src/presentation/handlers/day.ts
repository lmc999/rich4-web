// 日期推进、股市、破产与乞丐演出（design/client.md §4.5）；拍卖、公布栏、投降与终局见 endgame.ts
import { formatEvent } from '../logFormat';
import type { EventHandler } from '../types';
import { brief, syncFromPost } from './common';
import { stageOf } from './stage';

export const DAY_ADVANCED: EventHandler<'DAY_ADVANCED'> = async (_e, ctx) => {
  // 日历牌在 TopBar 随显示态翻页；这里只留一点节奏
  await ctx.wait(350);
};

export const PRICE_INDEX = brief<'PRICE_INDEX'>(800);

export const HOLIDAY: EventHandler<'HOLIDAY'> = async (e, ctx) => {
  await Promise.all([
    ctx.ui.banner(
      {
        kind: 'holiday',
        title: ctx.t('events:show.holiday', { name: ctx.names.holiday(e.key) }),
      },
      1500,
      ctx.signal,
    ),
    // 原版皮肤：烟火（元旦、双十）/ 圣诞 FLIC 与横幅并行
    stageOf(ctx).eventFlic?.(e, ctx.signal),
  ]);
};

export const OBJECTS_RESPAWNED: EventHandler<'OBJECTS_RESPAWNED'> = async () => {};
export const DAY_END: EventHandler<'DAY_END'> = async () => {};

// 股市：跑马灯读显示态刷新，这里只提示关键变化
export const CHAIRMAN_CHANGED: EventHandler<'CHAIRMAN_CHANGED'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'success');
  await ctx.wait(700);
};
export const STOCK_FLAG = brief<'STOCK_FLAG'>(600);
export const SUSPENDED = brief<'SUSPENDED'>(600);
export const RESUMED = brief<'RESUMED'>(400);
export const MARKET_TICK: EventHandler<'MARKET_TICK'> = async () => {};
export const MARKET_CLOSED: EventHandler<'MARKET_CLOSED'> = async () => {};

// 终局
export const BANKRUPT: EventHandler<'BANKRUPT'> = async (e, ctx) => {
  ctx.board.setActorPose(e.seat, 'sad');
  ctx.board.shake(8, 400);
  await Promise.all([
    ctx.ui.banner(
      { kind: 'bankrupt', title: ctx.t('events:show.bankrupt', { who: ctx.names.seat(e.seat) }), seat: e.seat },
      1800,
      ctx.signal,
    ),
    // 原版皮肤：房屋倒塌 FLIC 与横幅并行
    stageOf(ctx).eventFlic?.(e, ctx.signal),
  ]);
};

export const LIQUIDATION: EventHandler<'LIQUIDATION'> = async (e, ctx) => {
  syncFromPost(ctx, e.post);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  await ctx.wait(900);
};

export const BECAME_BEGGAR = brief<'BECAME_BEGGAR'>(800);
