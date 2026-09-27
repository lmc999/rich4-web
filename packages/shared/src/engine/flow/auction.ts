/**
 * AUCTION 帧：公开竞价、多人并发（design/engine.md §9.5；docs/research/g_arbitration.md §2.j；r_property.md §9.2–§9.4）。
 *
 * 起拍价 start = trunc(地价 × (1 + 等级 × 0.5)) × PI（= divTrunc(地价 × (2 + 等级), 2) × PI）。
 * 竞拍者（开拍时定下）：在场、不是卖方（拍卖卡的使用者 / 魔法屋的目标本人不能出价）、未受困
 *   （住宿、消失、坐牢、住院、冬眠、梦游都不能出价）、现金 > 起拍价（现金 ≤ 底价不能出价）。原地主可以出价。
 * start   AUCTION_STARTED{lot, seller, source, start, bidders}
 * ask     可出价者 = 状态 active、不是领先者、现金 ≥ 下一口价（领先者为空时是起拍价，否则现价 + 100）；
 *         为空 → settle；否则给其中手上没有本帧待答决策的人各发一个 AUCTION_BID（每人各自一个 id、各自计时）→ wait
 * resume  BID{inc}：inc = 0 只在还没人出价时合法；新价 = (领先者 ? 现价 : 起拍价) + inc，且 ≤ 出价者现金；
 *           领先者 = 出价者；所有 passed 恢复为 active（PASS 只保持到下一次有人成功加价）；清掉本帧其余待答决策
 *           （同时在途的请求随后收到 STALE_DECISION）→ AUCTION_BID → ask
 *         PASS：该人 passed，只移除他自己的待答 → AUCTION_PASS；QUIT：该人 quit（永久退出）→ AUCTION_QUIT
 *         本帧已没有待答 → ask（没人可出价即 settle）
 * settle  有领先者：领先者用现金付款（卖方为玩家时进卖方存款，否则进公库），地产归他、等级保留、地契按开局期限重算、
 *         研究所进行中的研发作废（新业主不继承）；没有领先者（流拍）：unsold='ownerless' 时该地变为无主、建筑保留
 *         → AUCTION_ENDED{lot, winner, price}
 * 服务器为每个并发决策独立计时（design/net.md §5.4）；超时默认 PASS。
 */
import { CMB } from '../../data/tables/combat';
import { divTrunc, mul32 } from '../../util/int32';
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { lotState } from '../decisions/targets';
import { EngineInvariantError, EngineRuleError } from '../errors';
import { addTenure } from '../rules/calendar';
import { mainBlockOf } from '../rules/counters';
import { releaseLot } from '../rules/landMutation';
import type { AuctionBidOptions, BidIncrement } from '../types/decision';
import type { AuctionSource, FrameOf } from '../types/frames';
import type { LotId, LotLevel, SeatIndex } from '../types/ids';
import type { GameState, PlayerState } from '../types/state';

type AuctionFrame = FrameOf<'AUCTION'>;

/** 出价档（从小到大）；0 只在还没人出价时可用 */
export const BID_INCREMENTS: readonly BidIncrement[] = Object.freeze([0, 100, 500, 1000, 5000, 10000] as const);

/** 受困：住宿、消失、坐牢、住院、冬眠、梦游（不能出价；g_arbitration §2.j） */
export function isTrapped(p: Pick<PlayerState, 'st'>): boolean {
  return mainBlockOf(p.st) !== null || p.st.hibernate !== 0 || p.st.sleepwalk !== 0;
}

/** 起拍价 = trunc(地价 × (1 + 等级 × 0.5)) × PI；企业或不存在的地块返回 null */
export function auctionStartPrice(s: GameState, ctxMap: Ctx['map'], lot: LotId): number | null {
  const mode = s.config.rules.intOverflow;
  let landPrice: number;
  let level: number;
  if (lot.startsWith('L')) {
    const l = s.lands[ctxMap.landIdx(lot)];
    if (!l) return null;
    landPrice = l.landPrice;
    level = l.level;
  } else if (lot.startsWith('F')) {
    const f = s.facilities[ctxMap.facilityIdx(lot)];
    if (!f) return null;
    landPrice = f.landPrice;
    level = f.level;
  } else return null;
  return mul32(divTrunc(mul32(landPrice, 2 + level, mode), 2, mode), s.econ.priceIndex, mode);
}

/**
 * 压 AUCTION 帧（地块必须是住宅或设施）。seller：成交款收款人（null 进公库）；unsold：流拍时的处理。
 * 竞拍者名单在 start 阶段按当时的状态定下。
 */
export function pushAuction(
  ctx: Ctx,
  lot: LotId,
  seller: SeatIndex | null,
  source: AuctionSource,
  unsold: 'ownerless' | 'keep' = 'ownerless',
): void {
  const start = auctionStartPrice(ctx.s, ctx.map, lot);
  if (start === null) throw new EngineInvariantError('AUCTION_LOT', `cannot auction ${lot}`);
  ctx.push({
    k: 'AUCTION',
    lot,
    seller,
    source,
    start,
    price: start,
    leader: null,
    bidders: [],
    unsold,
    stage: 'start',
  });
}

function playerOf(s: GameState, seat: SeatIndex): PlayerState | null {
  return s.players.find((p) => p.seat === seat) ?? null;
}

/** 下一口的最低价：还没人出价时是起拍价，否则现价 + 100 */
function minNext(f: AuctionFrame): number {
  return f.leader === null ? f.start : f.price + CMB.AUCTION_MIN_INC;
}

/** 当前可出价的座位（状态 active、不是领先者、在场、现金 ≥ 下一口价） */
function eligible(s: GameState, f: AuctionFrame): SeatIndex[] {
  const need = minNext(f);
  const out: SeatIndex[] = [];
  for (const b of f.bidders) {
    if (b.st !== 'active' || b.seat === f.leader) continue;
    const p = playerOf(s, b.seat);
    if (p?.alive && p.cash >= need) out.push(b.seat);
  }
  return out;
}

export function buildAuctionBid(s: GameState, f: AuctionFrame, seat: SeatIndex): AuctionBidOptions {
  const p = playerOf(s, seat)!;
  const base = f.leader === null ? f.start : f.price;
  const increments = BID_INCREMENTS.filter((inc) => (inc === 0 ? f.leader === null : true) && base + inc <= p.cash);
  // 除自己与领先者外，现在还能出价的人数（与 eligible 同一判据：出不起下一口价的人以后也不会再被问）
  const others = eligible(s, f).filter((x) => x !== seat).length;
  const st = lotStateLevel(s, f.lot);
  return {
    lot: f.lot,
    level: st,
    seller: f.seller,
    start: f.start,
    price: f.price,
    leader: f.leader,
    increments,
    cash: p.cash,
    others,
    source: f.source,
  };
}

function lotStateLevel(s: GameState, lot: LotId): LotLevel {
  const l = lot.startsWith('L') ? s.lands.find((x) => x.id === lot) : s.facilities.find((x) => x.id === lot);
  return (l?.level ?? 0) as LotLevel;
}

function pendingOfFrame(s: GameState, f: AuctionFrame): number {
  let n = 0;
  for (const d of s.pending) if (d.frameId === f.fid) n++;
  return n;
}

function settle(ctx: Ctx, f: AuctionFrame): void {
  const s = ctx.s;
  const st = lotState(s, ctx.map, f.lot);
  const target = f.lot.startsWith('L') ? s.lands[ctx.map.landIdx(f.lot)] : s.facilities[ctx.map.facilityIdx(f.lot)];
  if (!st || !target) throw new EngineInvariantError('AUCTION_LOT', f.lot);
  const winner = f.leader;
  if (winner !== null && playerOf(s, winner)?.alive) {
    const to = f.seller !== null && playerOf(s, f.seller)?.alive ? ({ t: 'seat', seat: f.seller } as const) : null;
    ctx.pay({ t: 'seat', seat: winner }, to ?? { t: 'pool' }, f.price, {
      reason: 'auction',
      credit: 'deposit',
      cause: { k: 'system', ref: 'auction', by: f.seller },
    });
    const prev = target.owner;
    let cancelled: 1 | 2 | 3 | 4 | 5 | null = null;
    if ('research' in target && target.research !== null && prev !== winner) {
      cancelled = target.research.project;
      target.research = null;
    }
    target.owner = winner;
    target.tenure = addTenure(s.clock.date, s.config.tenure);
    ctx.emit('AUCTION_ENDED', { lot: f.lot, winner, price: f.price });
    if (cancelled !== null && prev !== null) {
      ctx.emit('RESEARCH_CANCELLED', { seat: prev, lot: f.lot as `F${number}`, project: cancelled });
    }
    return;
  }
  // 流拍：拍卖卡等来源按 unsold 处理（地主清空、建筑保留）
  const prev = target.owner;
  let cancelled: 1 | 2 | 3 | 4 | 5 | null = null;
  if (f.unsold === 'ownerless' && prev !== null) {
    const r = releaseLot(target);
    cancelled = r?.project ?? null;
  }
  ctx.emit('AUCTION_ENDED', { lot: f.lot, winner: null, price: f.start });
  if (cancelled !== null && prev !== null) {
    ctx.emit('RESEARCH_CANCELLED', { seat: prev, lot: f.lot as `F${number}`, project: cancelled });
  }
}

export const AUCTION: FrameHandler<AuctionFrame> = {
  step(ctx, f) {
    const s = ctx.s;
    switch (f.stage) {
      case 'start': {
        f.stage = 'ask';
        f.bidders = s.players
          .filter((p) => p.alive && p.seat !== f.seller && !isTrapped(p) && p.cash > f.start)
          .map((p) => ({ seat: p.seat, st: 'active' as const }));
        ctx.emit('AUCTION_STARTED', {
          lot: f.lot,
          seller: f.seller,
          source: f.source,
          start: f.start,
          bidders: f.bidders.map((b) => b.seat),
        });
        return;
      }
      case 'ask': {
        const seats = eligible(s, f);
        if (seats.length === 0) {
          f.stage = 'settle';
          return;
        }
        f.stage = 'wait';
        for (const seat of seats) {
          if (s.pending.some((d) => d.seat === seat)) continue;
          const options = buildAuctionBid(s, f, seat);
          ctx.ask(f, seat, 'AUCTION_BID', options, { type: 'PASS' }, { lot: f.lot, amount: f.price });
        }
        return;
      }
      case 'wait':
        // 待答决策都被回答（或清掉）之后才会走到这里
        f.stage = 'ask';
        return;
      case 'settle':
        f.stage = 'done';
        settle(ctx, f);
        return;
      case 'done':
        ctx.pop(f);
        return;
    }
  },
  resume(ctx, f, a, d) {
    if (f.stage !== 'wait' || d.kind !== 'AUCTION_BID') throw new EngineInvariantError('AUCTION_RESUME', f.stage);
    const s = ctx.s;
    const seat = a.seat;
    const bidder = f.bidders.find((b) => b.seat === seat);
    if (!bidder) throw new EngineInvariantError('AUCTION_BIDDER', `seat ${seat}`);
    switch (a.type) {
      case 'BID': {
        const p = playerOf(s, seat)!;
        if (a.inc === 0 && f.leader !== null) throw new EngineRuleError('OUT_OF_RANGE', 'inc 0 after the first bid');
        if (f.leader === seat) throw new EngineRuleError('NOT_ALLOWED', 'already leading');
        const price = (f.leader === null ? f.start : f.price) + a.inc;
        if (price > p.cash) throw new EngineRuleError('CANNOT_AFFORD', `bid ${price} > cash ${p.cash}`);
        f.price = price;
        f.leader = seat;
        bidder.st = 'active';
        for (const b of f.bidders) if (b.st === 'passed') b.st = 'active';
        // 其余待答（同一帧）一律作废：在途的请求会收到 STALE_DECISION，随后按新价格重新询问
        s.pending = s.pending.filter((x) => x.frameId !== f.fid);
        f.stage = 'ask';
        ctx.emit('AUCTION_BID', { seat, price });
        return;
      }
      case 'PASS':
        bidder.st = 'passed';
        ctx.emit('AUCTION_PASS', { seat });
        break;
      case 'QUIT':
        bidder.st = 'quit';
        ctx.emit('AUCTION_QUIT', { seat });
        break;
      default:
        throw new EngineInvariantError('AUCTION_INTENT', a.type);
    }
    if (pendingOfFrame(s, f) === 0) f.stage = 'ask';
  },
};
