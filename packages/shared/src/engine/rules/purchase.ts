/**
 * 买地、加盖的价格与可行性（design/engine.md §8 kind 0；docs/research/r_property.md §3.2；g_arbitration.md §2.c）。
 *
 * - 买无主住宅：(地价 + 房价 × 当前等级) × PI（无主地可能带着旧房子）。
 * - 自有地加盖一层：房价 × PI，每级相同；已满 5 级或是连锁店不能盖。
 * - 只能用现金：价格 > 现金时不能买；恰好相等可以买；买地盖房不会导致破产。
 * - 不能投资：梦游中（不问、不提示）；小衰神、大衰神、死神附身（一律投资失败）；土地公附身时不能买无主地
 *   （reason 'earthGod'：不问、不提示，落点 tail 阶段由显灵直接强占；r_deities §7.11、§9）。
 * - 福神（小、大）附身：PROGRAM = 照付全价，成功后额外送 1 级；MANUAL = 大福神买地免费、小福神半价，不送级。
 */
import { ECON } from '../../data/tables/economy';
import { FACILITY_CAPS } from '../../data/tables/facilities';
import { type FacilityType, GOD, type GodKind } from '../../data/tables/ids';
import { add32, divTrunc, mul32 } from '../../util/int32';
import type { EngineMap } from '../core/mapCache';
import type { LotLevel, SeatIndex } from '../types/ids';
import { modeOf, playerOf, type RulePlayer, type RuleWorld } from './world';

export const MAX_LEVEL = ECON.MAX_LEVEL as LotLevel;

export type InvestDenial = 'sleepwalk' | 'investBlocked' | 'earthGod' | 'notEnoughCash' | 'maxLevel' | 'chain';

export type InvestCheck =
  | { ok: true; price: number }
  | { ok: false; reason: InvestDenial; price: number; god: GodKind | null };

/** 禁止一切一般投资的神：小衰神、大衰神、死神 */
export function investBlockingGod(p: RulePlayer): GodKind | null {
  const k = p.god?.kind;
  return k === GOD.SMALL_MISFORTUNE || k === GOD.BIG_MISFORTUNE || k === GOD.DEATH ? k : null;
}

/**
 * 买无主地的禁令：衰神、死神 → 'investBlocked'（提示投资失败）；土地公 → 'earthGod'（屏蔽买地选项但不提示，
 * 落点直接强占）。没有禁令返回 null。
 */
function buyDenial(p: RulePlayer): { reason: 'investBlocked' | 'earthGod'; god: GodKind } | null {
  const god = investBlockingGod(p);
  if (god !== null) return { reason: 'investBlocked', god };
  return p.god?.kind === GOD.EARTH_GOD ? { reason: 'earthGod', god: GOD.EARTH_GOD } : null;
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

/**
 * 无主设施的标价：设施地价(+0x22) × PI，与等级无关（exe 0x41a86b-0x41a89d 不读等级；g_map §4.2、r_property §6.1）。
 * 住宅不同：无主住宅连旧房子一起买，价含 等级 × 房价（landBuyPrice）。
 */
export function facilityBuyPrice(w: RuleWorld, _em: EngineMap, facIdx: number): number {
  return mul32(w.facilities[facIdx]!.landPrice, w.econ.priceIndex, modeOf(w));
}

/** 设施加盖一层：rate0 × PI */
export function facilityUpgradeCost(w: RuleWorld, em: EngineMap, facIdx: number): number {
  return mul32(em.facilities[facIdx]!.rateWindow[0], w.econ.priceIndex, modeOf(w));
}

export function canBuyLand(w: RuleWorld, em: EngineMap, seat: SeatIndex, landIdx: number): InvestCheck {
  const p = playerOf(w.players, seat);
  const price = fortunePrice(w, p, landBuyPrice(w, em, landIdx));
  if (p.st.sleepwalk !== 0) return { ok: false, reason: 'sleepwalk', price, god: null };
  const deny = buyDenial(p);
  if (deny !== null) return { ok: false, reason: deny.reason, price, god: deny.god };
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

// ───────────────────────── 设施（大块地，docs/research/g_map.md §4.2、r_property.md §6.1） ─────────────────────────

/** 设施等级上限：公园 1、旅馆 5、购物中心 5、加油站 1、研究所 5 */
export function facilityCap(type: FacilityType): number {
  return FACILITY_CAPS[type];
}

/** 买无主设施：地价 × PI（不含等级；MANUAL 下福神修正同买地）；只用现金 */
export function canBuyFacility(w: RuleWorld, em: EngineMap, seat: SeatIndex, facIdx: number): InvestCheck {
  const p = playerOf(w.players, seat);
  const price = fortunePrice(w, p, facilityBuyPrice(w, em, facIdx));
  if (p.st.sleepwalk !== 0) return { ok: false, reason: 'sleepwalk', price, god: null };
  const deny = buyDenial(p);
  if (deny !== null) return { ok: false, reason: deny.reason, price, god: deny.god };
  if (price > p.cash) return { ok: false, reason: 'notEnoughCash', price, god: null };
  return { ok: true, price };
}

/** 首建（0 → 1 级，选类型）：再付一次 地价 × PI */
export function facilityBuildCost(w: RuleWorld, facIdx: number): number {
  return mul32(w.facilities[facIdx]!.landPrice, w.econ.priceIndex, modeOf(w));
}

export function canBuildFacility(w: RuleWorld, seat: SeatIndex, facIdx: number): InvestCheck {
  const p = playerOf(w.players, seat);
  const f = w.facilities[facIdx]!;
  const price = facilityBuildCost(w, facIdx);
  if (f.level !== 0) return { ok: false, reason: 'maxLevel', price, god: null };
  if (p.st.sleepwalk !== 0) return { ok: false, reason: 'sleepwalk', price, god: null };
  const god = investBlockingGod(p);
  if (god !== null) return { ok: false, reason: 'investBlocked', price, god };
  if (price > p.cash) return { ok: false, reason: 'notEnoughCash', price, god: null };
  return { ok: true, price };
}

/** 设施加盖一层：rate0 × PI；0 级（需首建）或已到该类型上限时不能盖 */
export function canUpgradeFacility(w: RuleWorld, em: EngineMap, seat: SeatIndex, facIdx: number): InvestCheck {
  const p = playerOf(w.players, seat);
  const f = w.facilities[facIdx]!;
  const price = facilityUpgradeCost(w, em, facIdx);
  if (f.level === 0 || f.level >= facilityCap(f.type)) return { ok: false, reason: 'maxLevel', price, god: null };
  if (p.st.sleepwalk !== 0) return { ok: false, reason: 'sleepwalk', price, god: null };
  const god = investBlockingGod(p);
  if (god !== null) return { ok: false, reason: 'investBlocked', price, god };
  if (price > p.cash) return { ok: false, reason: 'notEnoughCash', price, god: null };
  return { ok: true, price };
}

/** 设施升 n 级后的等级（按类型封顶） */
export function facilityLevelAfter(from: LotLevel, n: number, type: FacilityType): LotLevel {
  const cap = facilityCap(type);
  const to = from + n;
  return (to > cap ? Math.max(cap, from) : to) as LotLevel;
}
