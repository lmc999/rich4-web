/**
 * 买地、加盖的价格与可行性（design/engine.md §8 kind 0；docs/research/r_property.md §3.2；g_arbitration.md §2.c）。
 *
 * - 买无主住宅：(地价 + 房价 × 当前等级) × PI（无主地可能带着旧房子）。
 * - 自有地加盖一层：房价 × PI，每级相同；已满 5 级或是连锁店不能盖。
 * - 只能用现金：价格 > 现金时不能买；恰好相等可以买；买地盖房不会导致破产。
 * - 不能投资：梦游中（不问、不提示）；小衰神、大衰神、死神附身（一律投资失败）；土地公附身时不能买无主地。
 * - 福神（小、大）附身：PROGRAM = 照付全价，成功后额外送 1 级；MANUAL = 大福神买地免费、小福神半价，不送级。
 */
import { ECON } from '../../data/tables/economy';
import { GOD, type GodKind } from '../../data/tables/ids';
import { add32, divTrunc, mul32 } from '../../util/int32';
import type { EngineMap } from '../core/mapCache';
import type { LotLevel, SeatIndex } from '../types/ids';
import { modeOf, playerOf, type RulePlayer, type RuleWorld } from './world';

export const MAX_LEVEL = ECON.MAX_LEVEL as LotLevel;

export type InvestDenial = 'sleepwalk' | 'investBlocked' | 'notEnoughCash' | 'maxLevel' | 'chain';

export type InvestCheck =
  | { ok: true; price: number }
  | { ok: false; reason: InvestDenial; price: number; god: GodKind | null };

/** 禁止一切一般投资的神：小衰神、大衰神、死神 */
export function investBlockingGod(p: RulePlayer): GodKind | null {
  const k = p.god?.kind;
  return k === GOD.SMALL_MISFORTUNE || k === GOD.BIG_MISFORTUNE || k === GOD.DEATH ? k : null;
}

/** 买地额外禁止：土地公附身（落点直接强占，M6） */
export function buyBlockingGod(p: RulePlayer): GodKind | null {
  return investBlockingGod(p) ?? (p.god?.kind === GOD.EARTH_GOD ? GOD.EARTH_GOD : null);
}

/** PROGRAM 下福神附身时投资成功后额外送的级数 */
export function fortuneBonus(w: RuleWorld, p: RulePlayer): 0 | 1 {
  if (w.config.rules.fortuneGodLand !== 'program') return 0;
  const k = p.god?.kind;
  return k === GOD.SMALL_FORTUNE || k === GOD.BIG_FORTUNE ? 1 : 0;
}

/** MANUAL 下福神对买地价的修正：大福神免费，小福神半价 */
export function fortunePrice(w: RuleWorld, p: RulePlayer, price: number): number {
  if (w.config.rules.fortuneGodLand !== 'manual') return price;
  if (p.god?.kind === GOD.BIG_FORTUNE) return 0;
  if (p.god?.kind === GOD.SMALL_FORTUNE) return divTrunc(price, 2, modeOf(w));
  return price;
}

/** 无主住宅的标价（不含福神修正） */
export function landBuyPrice(w: RuleWorld, em: EngineMap, landIdx: number): number {
  const mode = modeOf(w);
  const l = w.lands[landIdx]!;
  const def = em.lands[landIdx]!;
  return mul32(add32(l.landPrice, mul32(def.housePrice, l.level, mode), mode), w.econ.priceIndex, mode);
}

/** 加盖一层的费用 */
export function landUpgradeCost(w: RuleWorld, em: EngineMap, landIdx: number): number {
  return mul32(em.lands[landIdx]!.housePrice, w.econ.priceIndex, modeOf(w));
}

/** 无主设施的标价：(地价 + 等级 × rate0) × PI */
export function facilityBuyPrice(w: RuleWorld, em: EngineMap, facIdx: number): number {
  const mode = modeOf(w);
  const f = w.facilities[facIdx]!;
  const def = em.facilities[facIdx]!;
  return mul32(add32(f.landPrice, mul32(def.rateWindow[0], f.level, mode), mode), w.econ.priceIndex, mode);
}

/** 设施加盖一层：rate0 × PI */
export function facilityUpgradeCost(w: RuleWorld, em: EngineMap, facIdx: number): number {
  return mul32(em.facilities[facIdx]!.rateWindow[0], w.econ.priceIndex, modeOf(w));
}

export function canBuyLand(w: RuleWorld, em: EngineMap, seat: SeatIndex, landIdx: number): InvestCheck {
  const p = playerOf(w.players, seat);
  const price = fortunePrice(w, p, landBuyPrice(w, em, landIdx));
  if (p.st.sleepwalk !== 0) return { ok: false, reason: 'sleepwalk', price, god: null };
  const god = buyBlockingGod(p);
  if (god !== null) return { ok: false, reason: 'investBlocked', price, god };
  if (price > p.cash) return { ok: false, reason: 'notEnoughCash', price, god: null };
  return { ok: true, price };
}

export function canUpgradeLand(w: RuleWorld, em: EngineMap, seat: SeatIndex, landIdx: number): InvestCheck {
  const p = playerOf(w.players, seat);
  const l = w.lands[landIdx]!;
  const price = landUpgradeCost(w, em, landIdx);
  if (l.chain) return { ok: false, reason: 'chain', price, god: null };
  if (l.level >= MAX_LEVEL) return { ok: false, reason: 'maxLevel', price, god: null };
  if (p.st.sleepwalk !== 0) return { ok: false, reason: 'sleepwalk', price, god: null };
  const god = investBlockingGod(p);
  if (god !== null) return { ok: false, reason: 'investBlocked', price, god };
  if (price > p.cash) return { ok: false, reason: 'notEnoughCash', price, god: null };
  return { ok: true, price };
}

/** 加盖后的等级（含福神加成，封顶 5） */
export function upgradedLevel(from: LotLevel, bonus: 0 | 1): LotLevel {
  const to = from + 1 + bonus;
  return (to > MAX_LEVEL ? MAX_LEVEL : to) as LotLevel;
}
