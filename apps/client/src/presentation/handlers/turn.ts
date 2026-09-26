// 回合与移动类事件演出（design/client.md §4.5）：回合横幅 + 镜头飞向玩家、跳伞、骰子、逐格行走（镜头跟随）
import type { EventHandler } from '../types';
import { brief, syncFromPost } from './common';

export const GAME_STARTED: EventHandler<'GAME_STARTED'> = async (e, ctx) => {
  await ctx.ui.banner(
    { kind: 'start', title: ctx.t('events:show.gameStart'), subtitle: ctx.names.date(e.date) },
    1100,
    ctx.signal,
  );
};

export const TURN_STARTED: EventHandler<'TURN_STARTED'> = async (e, ctx) => {
  if (e.actor.t !== 'seat') {
    await ctx.wait(200);
    return;
  }
  const seat = e.actor.seat;
  ctx.board.follow(seat);
  const who = ctx.names.seat(seat);
  const title = ctx.me === seat ? ctx.t('events:show.turnYou') : ctx.t('events:show.turn', { who });
  // 横幅显示 1.4 秒，不阻塞后续事件
  void ctx.ui.banner(
    { kind: 'turn', title, subtitle: ctx.t('events:show.turnSub', { turnNo: e.turnNo }), seat },
    1400,
    ctx.signal,
  );
  await Promise.all([ctx.board.focus({ seat }, 420, ctx.signal), ctx.board.hop(seat, ctx.signal)]);
};

export const PARACHUTE: EventHandler<'PARACHUTE'> = async (e, ctx) => {
  ctx.board.placeActor(e.seat, e.node);
  await ctx.board.focus({ tile: e.node }, 400, ctx.signal);
  await ctx.board.hop(e.seat, ctx.signal);
  await ctx.wait(200);
};

export const TURN_BLOCKED: EventHandler<'TURN_BLOCKED'> = async (e, ctx) => {
  ctx.board.setActorPose(e.seat, e.reason === 'hibernate' ? 'sleep' : 'sad');
  ctx.ui.toast(
    ctx.t('events:show.blocked', {
      who: ctx.names.seat(e.seat),
      reason: ctx.t(`events:blocked.${e.reason}`, { defaultValue: '' }),
      n: e.remaining,
    }),
  );
  await ctx.board.focus({ seat: e.seat }, 400, ctx.signal);
  await ctx.wait(500);
  ctx.board.setActorPose(e.seat, 'idle');
};

export const RELEASED = brief<'RELEASED'>(700);

export const RETURNED: EventHandler<'RETURNED'> = async (e, ctx) => {
  ctx.board.placeActor(e.seat, e.node);
  ctx.board.setActorPose(e.seat, 'idle');
  await ctx.board.hop(e.seat, ctx.signal);
  await ctx.wait(300);
};

export const TURN_ENDED: EventHandler<'TURN_ENDED'> = async () => {};

export const DICE_ROLLED: EventHandler<'DICE_ROLLED'> = async (e, ctx) => {
  await ctx.ui.dice(e.seat, e.dice, ctx.signal);
};

export const MOVE_SEGMENT: EventHandler<'MOVE_SEGMENT'> = async (e, ctx) => {
  if (e.actor.t !== 'seat') {
    // 恶人棋子在 M7 渲染
    await ctx.wait(Math.min(600, e.path.length * 60));
    return;
  }
  const seat = e.actor.seat;
  const p = ctx.view().players.find((x) => x.seat === seat);
  if (!p) return;
  ctx.board.follow(seat);
  const start = p.placed && p.node > 0 ? [p.node] : [];
  await ctx.board.walk(seat, [...start, ...e.path], ctx.signal);
};

export const ROADBLOCK_HIT = brief<'ROADBLOCK_HIT'>(600);

export const REVERSED = brief<'REVERSED'>(400);

export const LANDED: EventHandler<'LANDED'> = async (e, ctx) => {
  ctx.board.pulseTile(e.node);
  syncFromPost(ctx, e.post);
  await ctx.wait(120);
};
