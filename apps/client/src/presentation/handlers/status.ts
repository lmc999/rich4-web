// 状态类演出（design/client.md §3.6、§4.5）：坐牢 / 住院（警车、救护车沿路开来接走，之后人在监狱 / 医院里、棋子不画）、
// 出狱 / 出院 / 退房（从建筑里走一步到格上）、保释、命运加持、冬眠 / 乌龟 / 梦游等状态、同盟结成与破裂、银行拒绝往来。
import type { BlessingCategory, BlessingResult } from '@rich4/shared/engine';
import { DICE_TIMING, WALK_OUT_TAIL_MS } from '@rich4/shared/view';
import { formatEvent } from '../logFormat';
import type { EventHandler, PresentationContext } from '../types';
import { currentPacing } from './budget';
import { brief, showAllDeltas, syncFromPost } from './common';
import { stageOf, syncStageTo } from './stage';

export const CONFINED: EventHandler<'CONFINED'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  if (e.actor.t !== 'seat') {
    const at = stage.villainAnchor(e.actor.kind);
    if (at) stage.bubble(at, ctx.t(`events:confine.${e.where}`, { defaultValue: '' }) || '…', 900);
    await ctx.wait(900);
    syncFromPost(ctx, e.post);
    return;
  }
  const seat = e.actor.seat;
  ctx.board.setActorPose(seat, 'hurt');
  if (e.where === 'jail' || e.where === 'hospital') {
    // 已经关在里面（加刑）：原版只加天数、镜头移到人所在的景观，不再派警车 / 救护车（exe v2.06 0x43c307 / 0x43d994）
    const already = (ctx.view().players.find((p) => p.seat === seat)?.st[e.where] ?? 0) !== 0;
    await ctx.board.focus({ seat }, 250, ctx.signal);
    stage.bubble({ seat }, ctx.t(`events:confine.${e.where}`), 900);
    if (already) await ctx.wait(700);
    else await stage.escort(seat, e.where, ctx.signal);
    // 警车开走后立刻同步：人在监狱 / 医院里、棋子不画（escort 收尾会恢复本体透明度，不同步的话角色会在路面上闪现到事件结束）
    syncStageTo(ctx, e.post);
  } else {
    stage.bubble({ seat }, ctx.t(`events:confine.${e.where}`, { n: e.days }), 900);
    await ctx.wait(700);
  }
  syncFromPost(ctx, e.post);
  ctx.board.setActorPose(seat, 'idle');
  await ctx.wait(100);
};

/**
 * 获释。坐牢 / 住院 / 住旅馆：人还在监狱 / 医院 / 旅馆里（看不见），从建筑走一步到所在的格（关押格 / 旅馆门前的格），
 * 前半程看不见、过半出现——出现的那一刻才把关押状态换成获释后的显示态（syncStageTo），之后停在格上；
 * 走回棋盘（RETURNED）不再有演出。消失（出国、航空）：回到格上、开门闪光并跳一下（原版的飞机 / UFO 动画没有接）。
 * @source exe v2.06 fcn.0040d184（获释：朝向 = 景观 → 节点，不改节点）、fcn.0040bb40 bit4 分支（走一步，过半清计数才画出来）、
 *         fcn.0040cfab（消失获释：直接放回节点）；时序见 shared/view/pacing 的 WALK_OUT
 */
export const RELEASED: EventHandler<'RELEASED'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'success');
  if (e.actor.t !== 'seat') {
    await ctx.wait(500);
    syncFromPost(ctx, e.post);
    return;
  }
  const seat = e.actor.seat;
  syncFromPost(ctx, e.post);
  if (e.from !== 'away') {
    // 气泡在人所在的建筑上（镜头在 TURN_STARTED 已对准这里）
    stage.bubble({ seat }, ctx.t('events:bubble.released'), 800);
    await stage.walkOut(
      seat,
      e.from,
      { tickMs: DICE_TIMING[currentPacing()].throwTickMs, onShow: () => syncStageTo(ctx, e.post) },
      ctx.signal,
    );
    syncStageTo(ctx, e.post);
    ctx.board.setActorPose(seat, 'idle');
    await ctx.wait(WALK_OUT_TAIL_MS);
    return;
  }
  // 消失：先解除不在场的外观（显示本体），再开门闪光、跳一下
  syncStageTo(ctx, e.post);
  stage.bubble({ seat }, ctx.t('events:bubble.released'), 800);
  await Promise.all([stage.release(seat, ctx.signal), ctx.board.hop(seat, ctx.signal)]);
  ctx.board.setActorPose(seat, 'cheer');
  await ctx.wait(300);
  ctx.board.setActorPose(seat, 'idle');
};

export const BAIL: EventHandler<'BAIL'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'success');
  showAllDeltas(ctx, e);
  if (e.by !== e.seat) void stage.beam({ seat: e.by }, { seat: e.seat }, 0xffd84d, ctx.signal);
  await stage.release(e.seat, ctx.signal);
  syncFromPost(ctx, e.post);
  await ctx.wait(300);
};

const BLESS_COLOR: Readonly<Record<BlessingResult, number>> = { high: 0xffd84d, none: 0xffffff, low: 0x8e78c0 };

export function blessingText(ctx: PresentationContext, c: BlessingCategory, r: BlessingResult): string {
  return r === 'none' ? ctx.t('events:blessing.none') : ctx.t(`events:blessing.${c}_${r}`);
}

export const BLESSING: EventHandler<'BLESSING'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const text = blessingText(ctx, e.category, e.result);
  stage.burst({ seat: e.seat }, BLESS_COLOR[e.result], e.result === 'none' ? 4 : 18);
  stage.bubble({ seat: e.seat }, text, 1000);
  ctx.board.setActorPose(e.seat, e.result === 'high' ? 'cheer' : e.result === 'low' ? 'sad' : 'idle');
  await ctx.wait(900);
  ctx.board.setActorPose(e.seat, 'idle');
  syncFromPost(ctx, e.post);
};

export const STATUS_SET: EventHandler<'STATUS_SET'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  const at = e.actor.t === 'seat' ? { seat: e.actor.seat } : stage.villainAnchor(e.actor.kind);
  if (at) {
    stage.burst(at, e.status === 'hibernate' ? 0x9fdcff : e.status === 'tortoise' ? 0x3f9a4a : 0x9b6bff, 10);
    stage.bubble(at, ctx.t(`events:status.${e.status}`), 600);
  }
  syncFromPost(ctx, e.post);
  await ctx.wait(450);
};

export const ALLIANCE_FORMED: EventHandler<'ALLIANCE_FORMED'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'success');
  await stage.beam({ seat: e.a }, { seat: e.b }, 0x5cc85a, ctx.signal);
  stage.bubble({ seat: e.a }, ctx.t('events:alliance.formed'), 700);
  stage.bubble({ seat: e.b }, ctx.t('events:alliance.formed'), 700);
  ctx.board.setActorPose(e.a, 'cheer');
  ctx.board.setActorPose(e.b, 'cheer');
  await ctx.wait(600);
  ctx.board.setActorPose(e.a, 'idle');
  ctx.board.setActorPose(e.b, 'idle');
  syncFromPost(ctx, e.post);
};

export const ALLIANCE_BROKEN: EventHandler<'ALLIANCE_BROKEN'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  stage.bubble({ seat: e.a }, ctx.t('events:alliance.broken'), 700);
  ctx.board.shake(3, 200);
  await ctx.wait(700);
  syncFromPost(ctx, e.post);
};

export const ALLIANCE_EXPIRED = brief<'ALLIANCE_EXPIRED'>(400);
export const BANK_REJECTED = brief<'BANK_REJECTED'>(600);
