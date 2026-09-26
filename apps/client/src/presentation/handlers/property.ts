// 金钱与地产类事件演出（design/client.md §4.5）：买地插旗、升级弹跳、过路费金币飞行与飘字、现金/存款/点券变化
import type { GameEvent, SeatIndex } from '@rich4/shared/engine';
import { formatEvent } from '../logFormat';
import type { EventHandler, PresentationContext } from '../types';
import { brief, cashDelta, lotLook, showAllDeltas, showDelta, syncFromPost } from './common';

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
  await ctx.wait(500);
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

export const LOT_MUTATED: EventHandler<'LOT_MUTATED'> = async (e, ctx) => {
  ctx.board.shake(6, 350);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  await ctx.wait(400);
  syncFromPost(ctx, e.post);
  await ctx.wait(300);
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
