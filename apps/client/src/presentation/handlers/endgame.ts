// 拍卖、公布栏、投降与终局演出（design/client.md §4.5）：
// - 拍卖：与 AuctionDialog 协作——出价者看对话框，所有人（含观战）顶部看公开竞价横幅，出价在出价者头顶飘字；
// - 投降：白旗气泡 + 横幅；
// - 终局：烟花 + GameOverScreen（排名 + 资产构成），动画播完后由 HUD 的终局面板接手（再来一局 / 离开）。
import type { GameResult, LotId, SeatIndex, TileId } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { type AuctionBidder, type GameOverRow, usePopupStore } from '../../ui/popups/popupStore';
import { formatEvent } from '../logFormat';
import type { EventHandler, PresentationContext } from '../types';
import { brief, showAllDeltas, syncFromPost } from './common';
import { playerRef, showPopup } from './popups';
import { stageOf } from './stage';

// ───────────────────────── 拍卖 ─────────────────────────

function bidders(ctx: PresentationContext, seats: readonly SeatIndex[]): AuctionBidder[] {
  const out: AuctionBidder[] = [];
  for (const s of seats) {
    const ref = playerRef(ctx, s);
    if (ref) out.push({ ...ref, state: 'active' });
  }
  return out;
}

function frontTile(ctx: PresentationContext, lot: LotId): TileId | null {
  try {
    return ctx.map?.lot(lot).frontTiles[0] ?? null;
  } catch {
    return null;
  }
}

function setBidder(seat: SeatIndex, state: AuctionBidder['state']): void {
  const a = usePopupStore.getState().auction;
  if (!a) return;
  usePopupStore.getState().patchAuction({ bidders: a.bidders.map((b) => (b.seat === seat ? { ...b, state } : b)) });
}

export const AUCTION_STARTED: EventHandler<'AUCTION_STARTED'> = async (e, ctx) => {
  usePopupStore.getState().setAuction({
    lot: e.lot,
    lotName: ctx.names.lot(e.lot),
    sellerName: e.seller === null ? null : ctx.names.seat(e.seller),
    start: e.start,
    price: e.start,
    leader: null,
    bidders: bidders(ctx, e.bidders),
    result: null,
    tick: 0,
  });
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  await ctx.board.focus({ lot: e.lot }, 400, ctx.signal);
  const front = frontTile(ctx, e.lot);
  if (front !== null) ctx.board.pulseTile(front);
  await ctx.wait(800);
};

export const AUCTION_BID: EventHandler<'AUCTION_BID'> = async (e, ctx) => {
  const a = usePopupStore.getState().auction;
  if (a) {
    usePopupStore.getState().patchAuction({
      price: e.price,
      leader: playerRef(ctx, e.seat),
      tick: a.tick + 1,
      // 有人成功加价后，此前「这轮不加价」的人恢复为可出价（引擎 flow/auction：PASS 只保持到下一次加价）；退出的不变
      bidders: a.bidders.map((b) => (b.seat === e.seat || b.state === 'passed' ? { ...b, state: 'active' } : b)),
    });
  }
  ctx.board.floatText({ seat: e.seat }, ctx.names.money(e.price), 'points');
  await ctx.wait(300);
};

export const AUCTION_PASS: EventHandler<'AUCTION_PASS'> = async (e) => {
  setBidder(e.seat, 'passed');
};

export const AUCTION_QUIT: EventHandler<'AUCTION_QUIT'> = async (e, ctx) => {
  setBidder(e.seat, 'quit');
  ctx.board.floatText({ seat: e.seat }, ctx.t('events:popup.bidderQuit'), 'info');
  await ctx.wait(150);
};

export const AUCTION_ENDED: EventHandler<'AUCTION_ENDED'> = async (e, ctx) => {
  const lot = ctx.names.lot(e.lot);
  const result =
    e.winner === null
      ? ctx.t('events:popup.auctionUnsold', { lot })
      : ctx.t('events:popup.auctionSold', { who: ctx.names.seat(e.winner), amount: ctx.names.money(e.price), lot });
  usePopupStore.getState().patchAuction({ result, leader: playerRef(ctx, e.winner) });
  ctx.ui.toast(result, e.winner === null ? 'info' : 'success');
  try {
    if (e.winner !== null) {
      ctx.board.setActorPose(e.winner, 'cheer');
      await ctx.board.plantFlag(e.lot, e.winner, ctx.signal);
    }
    syncFromPost(ctx, e.post);
    showAllDeltas(ctx, e);
    await ctx.wait(800);
  } finally {
    if (e.winner !== null) ctx.board.setActorPose(e.winner, 'idle');
    usePopupStore.getState().setAuction(null);
  }
};

// ───────────────────────── 公布栏 ─────────────────────────

export const LISTING_ADDED = brief<'LISTING_ADDED'>(350);
export const LISTING_REMOVED: EventHandler<'LISTING_REMOVED'> = async (e, ctx) => {
  syncFromPost(ctx, e.post);
};
export const LISTING_SOLD: EventHandler<'LISTING_SOLD'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'success');
  showAllDeltas(ctx, e);
  syncFromPost(ctx, e.post);
  await ctx.wait(500);
};

// ───────────────────────── 投降与终局 ─────────────────────────

export const SURRENDERED: EventHandler<'SURRENDERED'> = async (e, ctx) => {
  stageOf(ctx).bubble({ seat: e.seat }, ctx.t('events:bubble.surrender'), 1500);
  ctx.board.setActorPose(e.seat, 'sad');
  await ctx.ui.banner(
    { kind: 'bankrupt', title: ctx.t('events:show.surrendered', { who: ctx.names.seat(e.seat) }), seat: e.seat },
    1500,
    ctx.signal,
  );
  syncFromPost(ctx, e.post);
  await ctx.wait(200);
};

/**
 * 终局排名的资产构成（纯函数，HUD 的终局面板也可以直接用）：现金、存款、股票市值、地产（总资产 − 其余各项）、贷款。
 * nameOf：座位 → 显示名。
 */
export function buildGameOverRows(
  result: GameResult,
  view: GameView,
  nameOf: (seat: SeatIndex) => string,
): GameOverRow[] {
  const rows: GameOverRow[] = [];
  result.ranking.forEach((r, i) => {
    const p = view.players.find((x) => x.seat === r.seat);
    if (!p) return;
    let stocks = 0;
    for (let k = 0; k < view.stocks.length; k++) {
      const shares = p.holdings[k]?.shares ?? 0;
      if (shares > 0) stocks += Math.trunc((shares * view.stocks[k]!.priceCents) / 100);
    }
    const estate = Math.max(0, r.netWorth - (p.cash + p.deposit - p.loan + stocks));
    rows.push({
      seat: r.seat,
      character: p.character,
      name: nameOf(r.seat),
      rank: i + 1,
      netWorth: r.netWorth,
      alive: r.alive,
      parts: { cash: p.cash, deposit: p.deposit, stocks, estate, loan: p.loan },
    });
  });
  return rows;
}

export function gameOverRows(ctx: PresentationContext, result: GameResult, view: GameView): GameOverRow[] {
  return buildGameOverRows(result, view, (s) => ctx.names.seat(s));
}

export const GAME_OVER_POPUP_MS = 2800;

export const GAME_OVER: EventHandler<'GAME_OVER'> = async (e, ctx) => {
  const w = e.result.winner;
  const winner = playerRef(ctx, w);
  stageOf(ctx).fireworks();
  if (w !== null) ctx.board.setActorPose(w, 'cheer');
  await showPopup(
    ctx,
    {
      kind: 'gameOver',
      title: ctx.t('events:show.gameOver'),
      subtitle:
        w === null
          ? ctx.t(`hud:over.reason.${e.result.reason}`)
          : ctx.t('events:show.winner', { who: ctx.names.seat(w) }),
      winner,
      rows: gameOverRows(ctx, e.result, ctx.view()),
    },
    GAME_OVER_POPUP_MS,
    1500,
  );
};
