/**
 * AUCTION_BID：拍卖心理价位（design/minigames-ai.md §9.7；docs/research/r_property.md §9.2；exe 0x439f0d / 0x43b124 / 0x43b183）。
 *
 * 第一次看到这场拍卖时用 turnRng('auction:<地块>:<起拍价>') 算出心理价位，同一回合内保持不变：
 *   factor   = r / 32767 × 0.3 + 0.5
 *   scarcity = 6 − 4 × 无主地比例（住宅 + 设施）
 *   v1 = ((等级 >> 1) + 1 + 我在同名路段的块数) × 起拍价 × PI × scarcity × factor（PI 乘了两次，原版如此）
 *   v2 = 地价 × PI × (3 + r' / 65536)
 *   L  = min(v1, v2, 现金)
 * 出价：现金 < 现价 → QUIT；否则从 10000 / 5000 / 1000 / 500 / 100（还没人出价时另有 0 = 按起拍价）里取最大、
 * 且 现价 + 档 ≤ L 的一档；只剩自己可以出价（others = 0）时压成最小档；一档都不行 → PASS。
 */
import type { BidIncrement, PlayerIntent } from '../../engine/types/index';
import type { DecisionForYou } from '../../view/types';
import type { AiContext } from '../types';
import type { AiView } from '../view';

/** 心理价位（元） */
export function auctionLimit(v: AiView, d: DecisionForYou<'AUCTION_BID'>, ctx: AiContext): number {
  const o = d.options;
  const rng = ctx.turnRng(`auction:${o.lot}:${o.start}`);
  const r1 = rng.next15();
  const r2 = rng.next15();
  const factor = (r1 / 32767) * 0.3 + 0.5;
  const lots = v.allLots();
  const ownerless = lots.filter((l) => l.owner === null).length;
  const scarcity = 6 - (4 * ownerless) / Math.max(1, lots.length);
  const lot = v.lot(o.lot);
  const street =
    lot?.street === null || lot === null
      ? 0
      : v.streetLots(lot.street).filter((l) => l.id !== o.lot && l.owner === v.seat).length;
  const pi = v.pi;
  const v1 = ((o.level >> 1) + 1 + street) * o.start * pi * scarcity * factor;
  const landPrice = lot?.landPrice ?? 0;
  const v2 = landPrice * pi * (3 + r2 / 65536);
  return Math.trunc(Math.min(v1, v2, o.cash));
}

export function auctionBid(v: AiView, d: DecisionForYou<'AUCTION_BID'>, ctx: AiContext): PlayerIntent {
  const o = d.options;
  const base = o.leader === null ? o.start : o.price;
  if (o.cash < base) return { type: 'QUIT' };
  const limit = auctionLimit(v, d, ctx);
  const ok = o.increments
    .filter((inc) => (inc !== 0 || o.leader === null) && base + inc <= limit)
    .sort((a, b) => a - b);
  if (ok.length === 0) return { type: 'PASS' };
  const inc: BidIncrement = (o.others ?? 1) === 0 ? ok[0]! : ok[ok.length - 1]!;
  return { type: 'BID', inc };
}
