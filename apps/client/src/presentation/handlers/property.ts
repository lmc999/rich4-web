// 金钱与地产类事件演出（design/client.md §4.5）：买地插旗、升级弹跳、过路费金币飞行与飘字、现金/存款/点券变化
import type { GameEvent, SeatIndex } from '@rich4/shared/engine';
import { formatEvent } from '../logFormat';
import type { EventHandler, PresentationContext } from '../types';
import { brief, cashDelta, lotLook, showAllDeltas, showDelta, syncFromPost } from './common';
import { stageOf } from './stage';

export const MONEY: EventHandler<'MONEY'> = async (e, ctx) => {
  showAllDeltas(ctx, e);
  await ctx.wait(e.paid > 0 ? 450 : 100);
};

const moneyBrief =
  (ms: number): EventHandler<'LOAN' | 'REPAY' | 'ATM' | 'FINANCE' | 'INSURANCE_PAYOUT' | 'RESERVE_SHORTFALL'> =>
  async (e, ctx) => {
    const line = formatEvent(e as GameEvent, ctx.names);
    if (line) ctx.ui.toast(line);
    showAllDeltas(ctx, e);
    await ctx.wait(ms);
  };

export const LOAN = moneyBrief(700);
export const REPAY = moneyBrief(500);
export const ATM = moneyBrief(450);
export const FINANCE = moneyBrief(700);
export const RESERVE_SHORTFALL = moneyBrief(700);
export const INSURANCE_PAYOUT = moneyBrief(800);

export const POINTS_GAINED: EventHandler<'POINTS_GAINED'> = async (e, ctx) => {
  showDelta(ctx, e.seat, cashDelta(ctx, e, e.seat, 'points') || e.amount, 'points');
  // 原版皮肤：点券格的旋转点券 FLIC 与等待并行
  await Promise.all([ctx.wait(500), stageOf(ctx).eventFlic?.(e, ctx.signal)]);
};

export const LAND_BOUGHT: EventHandler<'LAND_BOUGHT'> = async (e, ctx) => {
  await ctx.board.focus({ lot: e.lot }, 250, ctx.signal);
  const look = lotLook(ctx.view(), e.lot);
  ctx.board.setLot(e.lot, { ...(look ?? { level: 0 }), owner: e.seat });
  await ctx.board.plantFlag(e.lot, e.seat, ctx.signal);
  showDelta(ctx, e.seat, cashDelta(ctx, e, e.seat) || -e.price);
  syncFromPost(ctx, e.post);
  await ctx.wait(150);
};

export const LOT_LEVEL: EventHandler<'LOT_LEVEL'> = async (e, ctx) => {
  syncFromPost(ctx, e.post);
  const look = lotLook(ctx.view(), e.lot);
  if (look) ctx.board.setLot(e.lot, { ...look, level: e.to });
  if (e.to > e.from) {
    await ctx.board.popBuilding(e.lot, ctx.signal);
    ctx.board.floatText({ lot: e.lot }, ctx.t('events:show.level', { n: e.to }), 'info');
  } else {
    ctx.board.shake(4, 250);
  }
  showAllDeltas(ctx, e);
  await ctx.wait(200);
};

export const FACILITY_BUILT: EventHandler<'FACILITY_BUILT'> = async (e, ctx) => {
  syncFromPost(ctx, e.post);
  await ctx.board.popBuilding(e.lot, ctx.signal);
  showAllDeltas(ctx, e);
  await ctx.wait(250);
};

/**
 * 命运拆屋 / 征收时镜头移到地块的时长：原版第 0、1 条命运的处理函数先 fcn.0041cc56(x,y,2) 把镜头移到被拆 / 被征收的
 * 地块（0x44a940 / 0x44aad8）再执行（见 events.ts 的 FATE_AFTER_BOARD）；镜头函数的耗时未测，与聖誕節送卡同按 300 ms 估
 */
export const FATE_LOT_FOCUS_MS = 300;

/**
 * 地产被拆 / 被收回：震屏 → 0.4 秒后地块变样 → 再停 0.3 秒（与原版拆屋的 fcn.004501ac 逐帧震动 + 停 400 ms → 重画 →
 * 停 300 ms 0x44a9b6 同一节奏）。命运引起的（违建被拆、土地被征收；引擎先发 FATE 再改地产）先把镜头移到地块，等待期间
 * 镜头一直停在地块上（对同一点再 focus：镜头动画期间跟随不抢镜头），看着它变样，之后才由跟随拉回行动者
 */
export const LOT_MUTATED: EventHandler<'LOT_MUTATED'> = async (e, ctx) => {
  const atLot = e.cause.k === 'fate';
  const hold = (ms: number): Promise<unknown> =>
    atLot ? Promise.all([ctx.wait(ms), ctx.board.focus({ lot: e.lot }, ms, ctx.signal)]) : ctx.wait(ms);
  if (atLot) await ctx.board.focus({ lot: e.lot }, FATE_LOT_FOCUS_MS, ctx.signal);
  ctx.board.shake(6, 350);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  await hold(400);
  syncFromPost(ctx, e.post);
  await hold(300);
};

/** 金币从付款人飞向收款人，两边飘字 */
async function payFlight(
  ctx: PresentationContext,
  e: { post?: import('@rich4/shared/engine').PostPatch },
  payer: SeatIndex,
  payee: SeatIndex | null,
): Promise<void> {
  if (payee !== null) await ctx.board.coinFlight({ seat: payer }, { seat: payee }, ctx.signal);
  showAllDeltas(ctx, e);
}

export const TOLL_PAID: EventHandler<'TOLL_PAID'> = async (e, ctx) => {
  // 付款人就是刚走完的当前玩家，镜头已经跟着他
  await payFlight(ctx, e, e.payer, e.owner);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  await ctx.wait(200);
};

export const TOLL_EXEMPT = brief<'TOLL_EXEMPT'>(600);

export const FEE_PAID: EventHandler<'FEE_PAID'> = async (e, ctx) => {
  const owner = lotLook(ctx.view(), e.lot)?.owner ?? null;
  await payFlight(ctx, e, e.payer, owner);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  await ctx.wait(e.wheel === null ? 200 : 1200);
};

export const INVEST_BLOCKED = brief<'INVEST_BLOCKED'>(600);

export const CANNOT_AFFORD: EventHandler<'CANNOT_AFFORD'> = async (e, ctx) => {
  ctx.board.floatText({ seat: e.seat }, ctx.t('events:show.cannotAfford'), 'loss');
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  await ctx.wait(500);
};

export const MARK_SET = brief<'MARK_SET'>(700);
export const MARK_EXPIRED = brief<'MARK_EXPIRED'>(300);
export const TENURE_EXPIRED = brief<'TENURE_EXPIRED'>(600);
export const RESEARCH_STARTED = brief<'RESEARCH_STARTED'>(500);
export const RESEARCH_CANCELLED = brief<'RESEARCH_CANCELLED'>(400);
