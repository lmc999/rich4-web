/**
 * 客户端预览与 AI 共用的纯函数选择器（architecture §5.2「其他导出」；design/engine.md §13）。
 * 都显式接收 MapIndex，入参 w 可以是 GameState、PublicWorld 或客户端的 GameView（RuleWorld 结构类型）。
 * 与引擎结算用的是同一套 rules/*，所以预览数字与实际结算一致。
 */
import type { MapIndex } from '../../data/maps/mapIndex';
import type { LotId, World } from '../../data/maps/types';
import type { NewsId } from '../../data/tables/ids';
import { newsDef, newsParam } from '../../data/tables/news';
import { mul32, sub32 } from '../../util/int32';
import { engineMap } from '../core/mapCache';
import { daysBetween } from '../rules/calendar';
import { facilityBuyPrice, facilityUpgradeCost, landBuyPrice, landUpgradeCost } from '../rules/purchase';
import { limitDownPrice, limitUpPrice, tickSize } from '../rules/stock';
import { quoteLandToll } from '../rules/toll';
import { netWorth as netWorthRule } from '../rules/wealth';
import { findPlayer, modeOf, playerOf, type RuleWorld } from '../rules/world';
import type { TollExemptReason, TollQuote } from '../types/frames';
import type { DateNum, SeatIndex } from '../types/ids';

export type { RulePlayer, RuleWorld } from '../rules/world';

/** 总资产（不乘 PI，int32 语义） */
export function netWorth(w: RuleWorld, map: MapIndex, seat: SeatIndex): number {
  return netWorthRule(w, engineMap(map), seat);
}

export type TollPreview =
  | { kind: 'none' }
  | { kind: 'exempt'; reason: TollExemptReason }
  | { kind: 'toll'; amount: number; quote: TollQuote };

/** payer 停在住宅 lot 上要付的过路费（设施与企业收费含转盘，不在这里预览；返回 none） */
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

/** 无主地产的标价（住宅：(地价 + 房价 × 等级) × PI；设施：地价 × PI）；企业不能买，返回 null */
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

/** 股价档位（分）：按价格判断 <5 元 0.01、<15 元 0.05、<50 元 0.1、<150 元 0.5、其余 1 元 */
export function stockTickSize(priceCents: number): number {
  return tickSize(priceCents);
}

/** 以前日收盘价计的涨停价 / 跌停价（分）；当日价达到即为涨停 / 跌停（涨停不能买、跌停不能卖） */
export function stockLimitPrices(prevCents: number): { up: number; down: number } {
  return { up: limitUpPrice(prevCents), down: limitDownPrice(prevCents) };
}

/** 从今天到 date 的天数（date − 今天；date 为 0 时返回 null） */
export function daysUntil(w: Pick<RuleWorld, 'clock'>, date: DateNum): number | null {
  return date === 0 ? null : daysBetween(w.clock.date, date);
}

/**
 * 新闻板逐人行的金额（原版新闻处理函数参数 0 分支按座位逐人 sprintf 的 %d，公布时的世界）：
 * 11 所得税 trunc(现金 × 5%)（不乘 PI）、12 地价税 trunc(Σ(地价 + 等级 × 房价) × 5%) × PI（含设施，设施按 rateWindow[0]）、
 * 13 证交税 trunc(Σ持股市值 × 5%) × PI、23 储金红利 trunc(存款 × 10%)（有贷款的人为 0）；其余新闻为 null。
 * 与 effects/news 的 TAX_BASES、bonusInterest 同一公式（没有加持时的金额；客户端 realEngineM7 测试逐条对引擎实际收付）。
 * @source exe v2.06 0x44881d–0x44888a（所得税行）、0x448a24–0x448a96（地价税行）、0x448be6–0x448c5c（证交税行）、
 *   0x44997e–0x4499fc（储金红利行）；逐人行的格式串 0x4635ea（税）/ 0x46377f（红利）
 */
export function newsRowAmount(w: RuleWorld, map: MapIndex, id: NewsId, seat: SeatIndex): number | null {
  const def = newsDef(id);
  const p = findPlayer(w.players, seat);
  if (!p) return null;
  const mode = modeOf(w);
  const pi = (n: number): number => mul32(n, w.econ.priceIndex, mode);
  switch (def.effect) {
    case 'incomeTax':
      return Math.trunc(p.cash * newsParam(id, 'rate'));
    case 'landTax': {
      const em = engineMap(map);
      let sum = 0;
      w.lands.forEach((l, i) => {
        if (l.owner === seat) sum += l.landPrice + l.level * em.lands[i]!.housePrice;
      });
      w.facilities.forEach((f, i) => {
        if (f.owner === seat) sum += f.landPrice + f.level * em.facilities[i]!.rateWindow[0];
      });
      return pi(Math.trunc(sum * newsParam(id, 'rate')));
    }
    case 'stockTax': {
      let value = 0;
      w.stocks.forEach((st, i) => {
        value += ((p.holdings[i]?.shares ?? 0) * st.priceCents) / 100;
      });
      return pi(Math.trunc(value * newsParam(id, 'rate')));
    }
    case 'bonusInterest':
      return p.loan === 0 && p.deposit > 0 ? Math.trunc(p.deposit * newsParam(id, 'rate')) : 0;
    default:
      return null;
  }
}

/** 贷款额度 = 总资产 − 现有贷款（M4 的柜台还要判挤兑、拒绝往来） */
export function loanLimit(w: RuleWorld, map: MapIndex, seat: SeatIndex): number {
  const p = playerOf(w.players, seat);
  const v = sub32(netWorth(w, map, seat), p.loan, modeOf(w));
  return v > 0 ? v : 0;
}
