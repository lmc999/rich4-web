/**
 * 公布栏的菜单操作（TURN_MENU 的非终结 intent；规则见 rules/noticeBoard.ts）：
 *   BOARD_LIST{asset, price}  → LISTING_ADDED（回合日志 boardList）
 *   BOARD_DELIST{listingId}   → LISTING_REMOVED{delisted}（日志 boardList）
 *   BOARD_BUY{listingId}      → 买家现金付给卖家现金，资产过户 → LISTING_SOLD（日志 boardBuy）；卡片过户另发 CARD_LOST /
 *                               CARD_GAINED{board}，股票过户后重排董事长
 * 回合开始时撤下失效的挂牌（pruneListings → LISTING_REMOVED{invalid}）。
 */
import type { Ctx } from '../core/ctx';
import { nextListingId } from '../core/ids';
import { gainCard } from '../effects/common';
import { EngineRuleError } from '../errors';
import { addTenure } from '../rules/calendar';
import { canBuyListing, checkListing, listingValid } from '../rules/noticeBoard';
import { updateChairman } from '../rules/stock';
import type { SeatIndex } from '../types/ids';
import type { Listing, ListingAsset } from '../types/state';

export function listOnBoard(ctx: Ctx, seat: SeatIndex, asset: ListingAsset, price: number): void {
  const why = checkListing(ctx.s, ctx.map, seat, asset, price);
  if (why !== null) throw new EngineRuleError('NOT_ALLOWED', `cannot list: ${why}`);
  const listing: Listing = { id: nextListingId(ctx.s), seller: seat, price, asset: { ...asset } as ListingAsset };
  ctx.player(seat).turn.log.push('boardList');
  ctx.s.noticeBoard.push(listing);
  ctx.emit('LISTING_ADDED', { listing: { ...listing, asset: { ...listing.asset } as ListingAsset } });
}

export function delistFromBoard(ctx: Ctx, seat: SeatIndex, listingId: number): void {
  const l = ctx.s.noticeBoard.find((x) => x.id === listingId);
  if (!l || l.seller !== seat) throw new EngineRuleError('INVALID_TARGET', `listing ${listingId} is not yours`);
  ctx.player(seat).turn.log.push('boardList');
  ctx.s.noticeBoard = ctx.s.noticeBoard.filter((x) => x.id !== listingId);
  ctx.emit('LISTING_REMOVED', { listingId, reason: 'delisted' });
}

export function buyFromBoard(ctx: Ctx, buyer: SeatIndex, listingId: number): void {
  const s = ctx.s;
  const l = s.noticeBoard.find((x) => x.id === listingId);
  if (!l) throw new EngineRuleError('INVALID_TARGET', `no listing ${listingId}`);
  if (l.seller === buyer) throw new EngineRuleError('NOT_ALLOWED', 'cannot buy your own listing');
  if (!canBuyListing(s, ctx.map, buyer, l)) {
    throw new EngineRuleError(listingValid(s, ctx.map, l) ? 'CANNOT_AFFORD' : 'INVALID_TARGET', 'cannot buy');
  }
  const seller = l.seller;
  const b = ctx.player(buyer);
  const q = ctx.player(seller);
  b.turn.log.push('boardBuy');
  s.noticeBoard = s.noticeBoard.filter((x) => x.id !== listingId);
  ctx.pay({ t: 'seat', seat: buyer }, { t: 'seat', seat: seller }, l.price, {
    reason: 'board',
    cause: { k: 'system', ref: 'board', by: buyer },
  });
  const sold = () => ctx.emit('LISTING_SOLD', { listingId, seller, buyer, price: l.price });
  const a = l.asset;
  switch (a.t) {
    case 'stock': {
      const hs = q.holdings[a.stock]!;
      const left = hs.shares - a.shares;
      q.holdings[a.stock] = { shares: left, costCents: left === 0 ? 0 : Math.trunc((hs.costCents * left) / hs.shares) };
      const hb = b.holdings[a.stock]!;
      b.holdings[a.stock] = { shares: hb.shares + a.shares, costCents: hb.costCents + l.price * 100 };
      sold();
      const ch = updateChairman(s, a.stock);
      if (ch) ctx.emit('CHAIRMAN_CHANGED', ch);
      return;
    }
    case 'lot': {
      const t = a.lot.startsWith('L') ? s.lands[ctx.map.landIdx(a.lot)]! : s.facilities[ctx.map.facilityIdx(a.lot)]!;
      let cancelled: 1 | 2 | 3 | 4 | 5 | null = null;
      if ('research' in t && t.research !== null) {
        cancelled = t.research.project;
        t.research = null;
      }
      t.owner = buyer;
      t.tenure = addTenure(s.clock.date, s.config.tenure);
      sold();
      if (cancelled !== null) {
        ctx.emit('RESEARCH_CANCELLED', { seat: seller, lot: a.lot as `F${number}`, project: cancelled });
      }
      return;
    }
    case 'item':
      q.items[a.item] = (q.items[a.item] ?? 0) - a.qty;
      b.items[a.item] = (b.items[a.item] ?? 0) + a.qty;
      sold();
      return;
    case 'card': {
      const slot = q.cards.indexOf(a.card);
      q.cards.splice(slot, 1);
      ctx.emit('CARD_LOST', { seat: seller, card: a.card, cause: 'board' });
      gainCard(ctx, buyer, a.card, 'board', () => {
        ctx.emit('CARD_GAINED', { seat: buyer, card: a.card, source: 'board' });
        sold();
      });
      return;
    }
  }
}

/** 撤下失效的挂牌（回合开始时调用）→ LISTING_REMOVED{invalid} */
export function pruneListings(ctx: Ctx): void {
  const s = ctx.s;
  const bad = s.noticeBoard.filter((l) => !listingValid(s, ctx.map, l)).map((l) => l.id);
  for (const id of bad) {
    s.noticeBoard = s.noticeBoard.filter((x) => x.id !== id);
    ctx.emit('LISTING_REMOVED', { listingId: id, reason: 'invalid' });
  }
}
