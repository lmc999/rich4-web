/**
 * 客户端预览与 AI 共用的纯函数选择器（architecture §5.2「其他导出」；design/engine.md §13）。
 * 都显式接收 MapIndex，入参 w 可以是 GameState、PublicWorld 或客户端的 GameView（RuleWorld 结构类型）。
 * 与引擎结算用的是同一套 rules/*，所以预览数字与实际结算一致。
 */
import type { MapIndex } from '../../data/maps/mapIndex';
import type { LotId, World } from '../../data/maps/types';
import { sub32 } from '../../util/int32';
import { engineMap } from '../core/mapCache';
import { facilityBuyPrice, facilityUpgradeCost, landBuyPrice, landUpgradeCost } from '../rules/purchase';
import { quoteLandToll } from '../rules/toll';
import { netWorth as netWorthRule } from '../rules/wealth';
import { modeOf, playerOf, type RuleWorld } from '../rules/world';
import type { TollExemptReason, TollQuote } from '../types/frames';
import type { SeatIndex } from '../types/ids';

export type { RulePlayer, RuleWorld } from '../rules/world';

/** 总资产（不乘 PI，int32 语义） */
export function netWorth(w: RuleWorld, map: MapIndex, seat: SeatIndex): number {
  return netWorthRule(w, engineMap(map), seat);
}

export type TollPreview =
  | { kind: 'none' }
  | { kind: 'exempt'; reason: TollExemptReason }
  | { kind: 'toll'; amount: number; quote: TollQuote };

/** payer 停在 lot 上要付的过路费（M1 只算住宅；设施与企业收费属于 M4，返回 none） */
export function tollPreview(w: RuleWorld, map: MapIndex, lot: LotId, payer: SeatIndex): TollPreview {
  const em = engineMap(map);
  const i = em.landIdx(lot);
  if (i < 0) return { kind: 'none' };
  const r = quoteLandToll(w, em, i, payer);
  return r.kind === 'toll' ? { kind: 'toll', amount: r.q.amount, quote: r.q } : r;
}

/** 过路费金额（免收或无需付费时为 0） */
export function calcToll(w: RuleWorld, map: MapIndex, lot: LotId, payer: SeatIndex): number {
  const r = tollPreview(w, map, lot, payer);
  return r.kind === 'toll' ? r.amount : 0;
}

/** 无主地产的标价（住宅：(地价 + 房价 × 等级) × PI；设施：(地价 + rate0 × 等级) × PI）；企业不能买，返回 null */
export function buyPrice(w: RuleWorld, map: MapIndex, lot: LotId): number | null {
  const em = engineMap(map);
  const li = em.landIdx(lot);
  if (li >= 0) return landBuyPrice(w, em, li);
  const fi = em.facilityIdx(lot);
  if (fi >= 0) return facilityBuyPrice(w, em, fi);
  return null;
}

/** 加盖一层的费用（住宅：房价 × PI；设施：rate0 × PI）；企业返回 null */
export function upgradeCost(w: RuleWorld, map: MapIndex, lot: LotId): number | null {
  const em = engineMap(map);
  const li = em.landIdx(lot);
  if (li >= 0) return landUpgradeCost(w, em, li);
  const fi = em.facilityIdx(lot);
  if (fi >= 0) return facilityUpgradeCost(w, em, fi);
  return null;
}

/** 与 lot 同名（同街）的住宅；lot 不是住宅时返回 [] */
export function streetLots(map: MapIndex, lot: LotId): LotId[] {
  const em = engineMap(map);
  const i = em.landIdx(lot);
  return i < 0 ? [] : em.streetOf(i).map((j) => em.lands[j]!.id);
}

/** 世界坐标方窗内的地块（与引擎目标候选同一个判定 geom/viewWindow） */
export function lotsInWindow(map: MapIndex, center: World, half: number): LotId[] {
  return map.lotsInWindow(center, half);
}

/** 今日股市是否开市（星期日、休市节日、全面停市都不开） */
export function marketOpen(w: Pick<RuleWorld, 'clock' | 'econ'>): boolean {
  return w.clock.marketOpen && w.econ.marketClosedDays === 0;
}

/** 贷款额度 = 总资产 − 现有贷款（M4 的柜台还要判挤兑、拒绝往来） */
export function loanLimit(w: RuleWorld, map: MapIndex, seat: SeatIndex): number {
  const p = playerOf(w.players, seat);
  const v = sub32(netWorth(w, map, seat), p.loan, modeOf(w));
  return v > 0 ? v : 0;
}
