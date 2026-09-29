// 回合与移动类事件演出（design/client.md §4.5）：回合横幅 + 镜头飞向玩家、跳伞、骰子、逐格行走（镜头跟随）、
// 四大恶人的棋子行走、撞上路障、回到棋盘。出狱 / 出院（RELEASED）见 status.ts。
import { DICE_TIMING } from '@rich4/shared/view';
import { DICE_KNOCK } from '../soundMap';
import type { EventHandler } from '../types';
import { currentPacing } from './budget';
import { brief, syncFromPost } from './common';
import { stageOf } from './stage';

export const GAME_STARTED: EventHandler<'GAME_STARTED'> = async (e, ctx) => {
  await ctx.ui.banner(
    { kind: 'start', title: ctx.t('events:show.gameStart'), subtitle: ctx.names.date(e.date) },
    1100,
    ctx.signal,
  );
};

export const TURN_STARTED: EventHandler<'TURN_STARTED'> = async (e, ctx) => {
  if (e.actor.t !== 'seat') {
    // 四大恶人的回合：镜头飞到恶人身上，头顶冒出「××出动」（之后 MOVE_SEGMENT 走路、VILLAIN_ACTION 作案）
    const kind = e.actor.kind;
    const v = ctx.view().villains.find((x) => x.kind === kind);
    if (v?.onBoard && v.node > 0) {
      stageOf(ctx).bubble({ tile: v.node }, ctx.t('events:show.villain', { villain: ctx.names.villain(kind) }), 700);
      await ctx.board.focus({ tile: v.node }, 420, ctx.signal);
    } else {
      await ctx.wait(200);
    }
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

export const RETURNED: EventHandler<'RETURNED'> = async (e, ctx) => {
  ctx.board.placeActor(e.seat, e.node);
  ctx.board.setActorPose(e.seat, 'idle');
  stageOf(ctx).burst({ seat: e.seat }, 0xfff3b0, 10);
  await ctx.board.hop(e.seat, ctx.signal);
  await ctx.wait(300);
};

export const TURN_ENDED: EventHandler<'TURN_ENDED'> = async () => {};

/**
 * 掷骰（原版时序，shared/view/pacing 的 DICE_TIMING）：等待掷骰时人物静止；收到结果后人物把持骰动作播一遍（原版皮肤），
 * 然后骰子 FLC 只播一遍，第 30 帧与播完时各「咚」一声（Effect#10），画上点数面、停留后起步（下一个 MOVE_SEGMENT）。
 * 停留 / 乌龟不掷骰（dice 为空，原版 fcn.0040d7e5 直接起步）：没有动作、骰子与声音
 */
export const DICE_ROLLED: EventHandler<'DICE_ROLLED'> = async (e, ctx) => {
  if (e.dice.length === 0) return;
  const t = DICE_TIMING[currentPacing()];
  const slot = (await ctx.board.throwDice?.(e.seat, t.throwTickMs, ctx.signal)) ?? null;
  // 动作播完时人物在画面上的位置：原版皮肤的骰子 FLC 按它摆在人物头顶一带（镜头不在人物身上、缩放不同时也跟着人物）；
  // 骰子显示期间镜头仍可能移动（拖动后恢复跟随），覆盖层再用 locate 逐帧读取
  const board = ctx.board;
  const at = board.actorScreen?.(e.seat) ?? null;
  const locate = board.actorScreen ? () => board.actorScreen?.(e.seat) ?? null : undefined;
  await ctx.ui.dice(e.seat, e.dice, ctx.signal, {
    frameMs: t.flicFrameMs,
    holdMs: t.holdMs,
    slot,
    at,
    ...(locate ? { locate } : {}),
    onKnock: () => ctx.audio.cue?.(DICE_KNOCK),
  });
};

export const MOVE_SEGMENT: EventHandler<'MOVE_SEGMENT'> = async (e, ctx) => {
  if (e.actor.t !== 'seat') {
    // 四大恶人：从当前节点出发沿路走（棋子由路面层管理）
    const kind = e.actor.kind;
    const v = ctx.view().villains.find((x) => x.kind === kind);
    const start = v?.onBoard && v.node > 0 ? [v.node] : [];
    await stageOf(ctx).walkVillain(kind, [...start, ...e.path], ctx.signal);
    return;
  }
  const seat = e.actor.seat;
  const p = ctx.view().players.find((x) => x.seat === seat);
  if (!p) return;
  ctx.board.follow(seat);
  const start = p.placed && p.node > 0 ? [p.node] : [];
  await ctx.board.walk(seat, [...start, ...e.path], ctx.signal);
};

export const ROADBLOCK_HIT: EventHandler<'ROADBLOCK_HIT'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const at = e.actor.t === 'seat' ? { seat: e.actor.seat } : stage.villainAnchor(e.actor.kind);
  if (at) stage.bubble(at, ctx.t('events:bubble.roadblock'), 700);
  if (e.actor.t === 'seat') ctx.board.setActorPose(e.actor.seat, 'hurt');
  ctx.board.pulseTile(e.node);
  ctx.board.shake(3, 180);
  await ctx.wait(550);
  if (e.actor.t === 'seat') ctx.board.setActorPose(e.actor.seat, 'idle');
};

export const REVERSED = brief<'REVERSED'>(400);

export const LANDED: EventHandler<'LANDED'> = async (e, ctx) => {
  ctx.board.pulseTile(e.node);
  syncFromPost(ctx, e.post);
  await ctx.wait(120);
};
