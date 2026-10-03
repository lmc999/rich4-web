// M4 经济事件的演出（design/client.md §4.5）：股票成交、分红、乐透开奖、月结、百货交易、企业收费、贷款到期提醒。
// 金额变化一律按事件 post 与提交前显示态之差飘字并闪动 HUD（showAllDeltas），不自己推算规则数值。
import type { SeatIndex } from '@rich4/shared/engine';
import { classicPopupHostActive } from '../../ui/popups/popupStore';
import { formatEvent } from '../logFormat';
import type { EventHandler, PresentationContext } from '../types';
import { showAllDeltas, syncFromPost } from './common';
import { playerRef, showPopup } from './popups';

/** LotteryDrawPopup 的展示时长（1x） */
export const LOTTERY_POPUP_MS = 2800;

/** 企业的董事长（显示态）；没有则 null */
function chairmanOf(ctx: PresentationContext, company: string): SeatIndex | null {
  const view = ctx.view();
  const co = view.companies.find((c) => c.id === company);
  if (!co) return null;
  return view.stocks[co.stock]?.chairman ?? null;
}

export const STOCK_TRADED: EventHandler<'STOCK_TRADED'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  // 自己的成交在股票面板里已经看得到结果，只给别人的成交弹提示
  if (line && e.seat !== ctx.me) ctx.ui.toast(line);
  showAllDeltas(ctx, e);
  await ctx.wait(300);
};

export const SUBSCRIBED: EventHandler<'SUBSCRIBED'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  showAllDeltas(ctx, e);
  await ctx.wait(500);
};

export const DIVIDENDS: EventHandler<'DIVIDENDS'> = async (e, ctx) => {
  const mine = ctx.me === null ? [] : e.rows.filter((r) => r.seat === ctx.me);
  const line = formatEvent(e, ctx.names);
  if (line && (mine.length > 0 || ctx.me === null)) {
    ctx.ui.toast(line, mine.some((r) => r.amount < 0) ? 'warn' : 'success');
  }
  showAllDeltas(ctx, e);
  await ctx.wait(900);
};

export const LOTTERY_TICKET: EventHandler<'LOTTERY_TICKET'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  showAllDeltas(ctx, e);
  await ctx.wait(400);
};

export const LOTTERY_DRAW: EventHandler<'LOTTERY_DRAW'> = async (e, ctx) => {
  const subtitle =
    e.number === null
      ? ctx.t('events:show.lotteryNone')
      : e.winner === null
        ? ctx.t('events:show.lotteryNoWinner', { n: e.number + 1 })
        : ctx.t('events:show.lotteryWinner', {
            n: e.number + 1,
            who: ctx.names.seat(e.winner),
            amount: ctx.names.money(e.prize),
          });
  // LotteryDrawPopup：摇奖球滚动后落到开出的号码（M7）；文案与原横幅相同
  const popup = showPopup(
    ctx,
    {
      kind: 'lottery',
      title: ctx.t('events:show.lottery'),
      number: e.number === null ? null : e.number + 1,
      winner: playerRef(ctx, e.winner),
      subtitle,
    },
    LOTTERY_POPUP_MS,
    1600,
  );
  if (e.winner !== null) ctx.board.setActorPose(e.winner, 'cheer');
  await popup;
  showAllDeltas(ctx, e);
  if (e.winner !== null) ctx.board.setActorPose(e.winner, 'idle');
  await ctx.wait(300);
};

export const MONTHLY_REPORT: EventHandler<'MONTHLY_REPORT'> = async (e, ctx) => {
  showAllDeltas(ctx, e);
  await ctx.ui.banner(
    {
      kind: 'info',
      title: ctx.t('events:show.monthly'),
      ...(e.champion === null
        ? {}
        : { subtitle: ctx.t('events:show.monthlyChampion', { who: ctx.names.seat(e.champion) }), seat: e.champion }),
    },
    1800,
    ctx.signal,
  );
};

export const SHOP_TRADE: EventHandler<'SHOP_TRADE'> = async (e, ctx) => {
  // 自己在商店对话框里看得到点券余额；棋盘上给所有人飘点券变化
  showAllDeltas(ctx, e);
  await ctx.wait(300);
};

export const COMPANY_FEE: EventHandler<'COMPANY_FEE'> = async (e, ctx) => {
  const chairman = chairmanOf(ctx, e.company);
  if (e.amount > 0 && chairman !== null && chairman !== e.seat) {
    await ctx.board.coinFlight({ seat: e.seat }, { seat: chairman }, ctx.signal);
  }
  showAllDeltas(ctx, e);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  syncFromPost(ctx, e.post);
  await ctx.wait(e.wheel === null ? 200 : 1200);
};

export const HOTEL_STAY: EventHandler<'HOTEL_STAY'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  ctx.board.setActorPose(e.seat, 'sleep');
  await ctx.wait(800);
  syncFromPost(ctx, e.post);
};

export const LOAN_REMINDER: EventHandler<'LOAN_REMINDER'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, e.seat === ctx.me ? 'warn' : 'info');
  await ctx.wait(e.seat === ctx.me ? 700 : 200);
};

export const LOAN_FORCED: EventHandler<'LOAN_FORCED'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  if (e.paid < e.amount) ctx.board.shake(6, 300);
  showAllDeltas(ctx, e);
  await ctx.wait(900);
};

export const RESEARCH_DONE: EventHandler<'RESEARCH_DONE'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, e.delivered ? 'success' : 'warn');
  if (e.delivered) ctx.board.floatText({ seat: e.seat }, '🔬', 'info');
  await ctx.wait(700);
};

/**
 * 百货董事长赠品（原版 fcn.0042dd0a：消息框「歡迎董事長光臨\n\n送您%s！」1.5 秒，不亮卡）：toast 写明送的是哪张卡 / 哪件
 * 道具（看得到的人：本人或公开手牌；私密下别人只看到「获得百货公司赠礼」）；原版皮肤没有头顶的 🎁 飘字
 */
export const CHAIRMAN_GIFT: EventHandler<'CHAIRMAN_GIFT'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line && (e.seat === ctx.me || e.card !== null || e.item !== null)) ctx.ui.toast(line, 'success');
  if (!classicPopupHostActive()) ctx.board.floatText({ seat: e.seat }, '🎁', 'info');
  await ctx.wait(700);
};
