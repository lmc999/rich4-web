/**
 * 地产类卡片（design/engine.md §10.2；docs/research/r_cards.md §1、§8、§10；g_arbitration.md §2.j）。企业一律不可选。
 *
 * 3  购地  脚下别人的住宅或设施：付 (地价 + 等级 × 房价) × PI 给原主（只用现金，不够则失败、卡保留），地契重算；
 *          敌意 地价 × PI × (等级 + 2) / 5；不受衰神、死神禁令影响
 * 4  换地  脚下地块 ↔ 范围内同类的另一地块：交换地主（连同地契期限 ⚑）；不产生敌意
 * 5  换屋  同上：交换等级与连锁店（设施为等级与类型），不检查等级上限
 * 7  改建  脚下 ≥1 级（不论谁的）：住宅在普通与连锁店之间切换（变连锁店时等级取 min(等级,1)）；
 *          设施改为指定类型（公园、加油站取 min(等级,1)），研究所改掉时研发作废
 * 8  拍卖  脚下任何地产 → AUCTION 帧（M7 实现并发拍卖；本期不可用）
 * 9  天使  范围内地产：住宅同名路段每块 +1 级（不论地主；满级跳过；连锁店只能 0→1）；设施 +1 级（0 级需附带类型）
 * 10 恶魔  范围内地产：住宅同名路段全部夷平（地主保留）；设施只夷平这一处；每块有主地：地主敌意 等级 × 30 × PI
 * 11 怪兽  范围内别人已有建筑的地产 → 夷平（地主、地契保留）；敌意 等级 × 30 × PI
 * 12 拆除  范围内别人已有建筑的地产 → 拆一级（连锁店变 0 级、设施到 0 级清成公园）；或路障、地雷、地面炸弹 → 移除回库存；
 *          拆建筑敌意 30 × PI
 * 27 涨价、28 查封  范围内地产：住宅同名路段 mark = {raise|seal, 5}，设施只标这一处；后写覆盖前写；
 *                  查封研究所时进行中的研发作废（exe 0x4456cf 清 +0x1e 倒数）
 */
import { CMB } from '../../../data/tables/combat';
import { ECON } from '../../../data/tables/economy';
import { FACILITY_CAPS } from '../../../data/tables/facilities';
import { FACILITY_TYPES, type FacilityType } from '../../../data/tables/ids';
import { add32, divTrunc, mul32 } from '../../../util/int32';
import type { Ctx } from '../../core/ctx';
import type { EngineMap } from '../../core/mapCache';
import {
  centerOf,
  inRange,
  isFacilityLot,
  isLandLot,
  lotState,
  propertyLotsInRange,
  underfootLot,
} from '../../decisions/targets';
import { EngineInvariantError } from '../../errors';
import { addTenure } from '../../rules/calendar';
import type { GameEventPayloads } from '../../types/events';
import type { LotId, LotLevel, SeatIndex } from '../../types/ids';
import type { FacilityState, GameState, LandState } from '../../types/state';
import { addHostility, mutateLot, raiseLot, removeObject, timesPI } from '../common';
import type { CardEffect } from '../types';
import { unusable, usable, usableIf } from '../types';

/** 拍卖卡要压的 AUCTION 帧属于 M7；实现前拍卖卡在菜单里不可用 */
export const AUCTION_CARD_ENABLED = false;

function land(s: GameState, em: EngineMap, lot: LotId): LandState | null {
  return isLandLot(lot) ? (s.lands[em.landIdx(lot)] ?? null) : null;
}

function fac(s: GameState, em: EngineMap, lot: LotId): FacilityState | null {
  return isFacilityLot(lot) ? (s.facilities[em.facilityIdx(lot)] ?? null) : null;
}

/** 同名路段（住宅）或设施自己 */
function streetOrSelf(em: EngineMap, lot: LotId): LotId[] {
  if (!isLandLot(lot)) return [lot];
  return em.streetOf(em.landIdx(lot)).map((i) => em.lands[i]!.id);
}

// ───────────────────────── 3 购地 ─────────────────────────

/** 购地价 = (地价 + 等级 × 房价) × PI（设施用设施地价与 rate0） */
export function cardBuyPrice(s: GameState, em: EngineMap, lot: LotId): number {
  const mode = s.config.rules.intOverflow;
  const l = land(s, em, lot);
  if (l) {
    const house = em.lands[em.landIdx(lot)]!.housePrice;
    return mul32(add32(l.landPrice, mul32(l.level, house, mode), mode), s.econ.priceIndex, mode);
  }
  const f = fac(s, em, lot)!;
  const rate0 = em.facilities[em.facilityIdx(lot)]!.rateWindow[0];
  return mul32(add32(f.landPrice, mul32(f.level, rate0, mode), mode), s.econ.priceIndex, mode);
}

export const buyLand: CardEffect = {
  menu(s, em, seat) {
    const lot = underfootLot(s, em, seat);
    const st = lot === null ? null : lotState(s, em, lot);
    if (lot === null || !st || st.owner === null || st.owner === seat) return unusable('noTarget');
    const targets = { t: 'underfoot', lot, types: null } as const;
    const p = s.players.find((x) => x.seat === seat)!;
    return cardBuyPrice(s, em, lot) > p.cash ? unusable('notEnoughCash', targets) : usable(targets);
  },
  check(s, em, seat) {
    const lot = underfootLot(s, em, seat)!;
    const p = s.players.find((x) => x.seat === seat)!;
    const price = cardBuyPrice(s, em, lot);
    return price > p.cash ? { rule: 'CANNOT_AFFORD', msg: `cash ${p.cash} < ${price}` } : null;
  },
  apply(ctx, seat) {
    const s = ctx.s;
    const lot = underfootLot(s, ctx.map, seat);
    if (lot === null) throw new EngineInvariantError('CARD_TARGET', 'no lot underfoot');
    const target = land(s, ctx.map, lot) ?? fac(s, ctx.map, lot)!;
    const owner = target.owner!;
    const price = cardBuyPrice(s, ctx.map, lot);
    const mode = s.config.rules.intOverflow;
    const hate = divTrunc(
      mul32(mul32(target.landPrice, s.econ.priceIndex, mode), target.level + 2, mode),
      CMB.HATE_BUY_LAND_DIV,
    );
    addHostility(ctx, owner, seat, hate);
    const from = { t: 'seat', seat } as const;
    const to = { t: 'seat', seat: owner } as const;
    const r = ctx.pay(from, to, price, { reason: 'cardBuyLand', cause: { k: 'card', ref: 3, by: seat } });
    ctx.emit('MONEY', { from, to, amount: price, paid: r.paid, reason: 'cardBuyLand', ref: lot });
    target.owner = seat;
    target.tenure = addTenure(s.clock.date, s.config.tenure);
    let lostResearch: number | null = null;
    if ('research' in target && target.research !== null) {
      lostResearch = target.research.project;
      target.research = null;
    }
    ctx.emit('LAND_BOUGHT', { seat, lot, price });
    if (lostResearch !== null) {
      ctx.emit('RESEARCH_CANCELLED', { seat: owner, lot: lot as `F${number}`, project: lostResearch as 1 });
    }
  },
};

// ───────────────────────── 4 换地 / 5 换屋 ─────────────────────────

function pairCandidates(s: GameState, em: EngineMap, seat: SeatIndex) {
  const from = underfootLot(s, em, seat);
  if (from === null) return null;
  const to = propertyLotsInRange(s, em, seat).filter((l) => l !== from && l[0] === from[0]);
  return { from, to };
}

function pairMenu(s: GameState, em: EngineMap, seat: SeatIndex) {
  const c = pairCandidates(s, em, seat);
  if (c === null) return unusable('noTarget');
  return usableIf({ t: 'lotPair', from: c.from, to: c.to }, c.to.length === 0);
}

function cancelResearchOf(ctx: Ctx, f: FacilityState): void {
  if (f.research === null) return;
  const r = f.research;
  f.research = null;
  if (f.owner !== null) ctx.emit('RESEARCH_CANCELLED', { seat: f.owner, lot: f.id, project: r.project });
}

export const swapLand: CardEffect = {
  menu: pairMenu,
  apply(ctx, _seat, t) {
    if (t.t !== 'lotPair') return;
    const s = ctx.s;
    const a = land(s, ctx.map, t.from) ?? fac(s, ctx.map, t.from)!;
    const b = land(s, ctx.map, t.to) ?? fac(s, ctx.map, t.to)!;
    // 研究所换了地主：进行中的研发作废（新地主不继承）；两块同属一个地主时不换主，研发保留（architecture §20.2）
    if (a.owner !== b.owner) {
      if ('research' in a) cancelResearchOf(ctx, a);
      if ('research' in b) cancelResearchOf(ctx, b as FacilityState);
    }
    const owner = a.owner;
    const tenure = a.tenure;
    const cause = { k: 'card', ref: 4, by: _seat } as const;
    a.owner = b.owner;
    a.tenure = b.tenure;
    ctx.emit('LOT_LEVEL', { lot: t.from, from: a.level, to: a.level, cause });
    b.owner = owner;
    b.tenure = tenure;
    ctx.emit('LOT_LEVEL', { lot: t.to, from: b.level, to: b.level, cause });
  },
};

export const swapHouse: CardEffect = {
  menu: pairMenu,
  apply(ctx, seat, t) {
    if (t.t !== 'lotPair') return;
    const s = ctx.s;
    const cause = { k: 'card', ref: 5, by: seat } as const;
    const la = land(s, ctx.map, t.from);
    const lb = land(s, ctx.map, t.to);
    if (la && lb) {
      const [lv, ch] = [la.level, la.chain];
      la.level = lb.level;
      la.chain = lb.chain;
      lb.level = lv;
      lb.chain = ch;
      ctx.emit('LOT_LEVEL', { lot: t.from, from: lb.level, to: la.level, cause });
      ctx.emit('LOT_LEVEL', { lot: t.to, from: la.level, to: lb.level, cause });
      return;
    }
    const fa = fac(s, ctx.map, t.from)!;
    const fb = fac(s, ctx.map, t.to)!;
    const [lv, ty] = [fa.level, fa.type];
    fa.level = fb.level;
    fa.type = fb.type;
    fb.level = lv;
    fb.type = ty;
    // 研发只在交换后不再是研究所、或等级低于项目等级时作废（与 mutateFacility 的判定一致）；先改状态，
    // LOT_LEVEL 之后补发 RESEARCH_CANCELLED（同 mutateLot + announceResearch 的顺序）
    const lost = [labLost(fa), labLost(fb)];
    ctx.emit('LOT_LEVEL', { lot: t.from, from: fb.level, to: fa.level, cause });
    ctx.emit('LOT_LEVEL', { lot: t.to, from: fa.level, to: fb.level, cause });
    for (const l of lost) if (l !== null) ctx.emit('RESEARCH_CANCELLED', l);
  },
};

/** 研究所改了类型或等级低于项目：清掉 research，返回待发的 RESEARCH_CANCELLED 载荷；研发仍有效返回 null */
function labLost(f: FacilityState): GameEventPayloads['RESEARCH_CANCELLED'] | null {
  const r = f.research;
  if (r === null || (f.type === 'lab' && f.level >= r.project)) return null;
  f.research = null;
  return f.owner !== null ? { seat: f.owner, lot: f.id, project: r.project } : null;
}

// ───────────────────────── 7 改建 ─────────────────────────

export const rebuild: CardEffect = {
  menu(s, em, seat) {
    const lot = underfootLot(s, em, seat);
    const st = lot === null ? null : lotState(s, em, lot);
    if (lot === null || !st || st.level < 1) return unusable('noTarget');
    if (st.kind === 'land') return usable({ t: 'underfoot', lot, types: null });
    const f = fac(s, em, lot)!;
    return usable({ t: 'underfoot', lot, types: FACILITY_TYPES.filter((x) => x !== f.type) });
  },
  apply(ctx, seat, t) {
    if (t.t !== 'underfoot') return;
    const s = ctx.s;
    const lot = underfootLot(s, ctx.map, seat)!;
    const cause = { k: 'card', ref: 7, by: seat } as const;
    const l = land(s, ctx.map, lot);
    if (l) {
      const from = l.level;
      l.chain = !l.chain;
      if (l.chain && l.level > 1) l.level = 1;
      ctx.emit('LOT_LEVEL', { lot, from, to: l.level, cause });
      return;
    }
    const f = fac(s, ctx.map, lot)!;
    const type = t.facility as FacilityType;
    if (f.type === 'lab' && type !== 'lab') cancelResearchOf(ctx, f);
    f.type = type;
    const cap = FACILITY_CAPS[type];
    if (f.level > cap) f.level = cap as LotLevel;
    ctx.emit('FACILITY_BUILT', { lot: f.id, facility: type, seat: f.owner });
  },
};

// ───────────────────────── 8 拍卖 ─────────────────────────

export const auction: CardEffect = {
  menu(s, em, seat) {
    if (!AUCTION_CARD_ENABLED) return unusable('noTarget');
    const lot = underfootLot(s, em, seat);
    return lot === null ? unusable('noTarget') : usable({ t: 'underfoot', lot, types: null });
  },
  apply() {
    // TODO(M7)：压 AUCTION{lot, seller: 出卡者, source:'card', unsold:'ownerless'}（成交款进出卡者存款，流拍变无主）
    throw new EngineInvariantError('NOT_IMPLEMENTED', 'auction card needs the AUCTION frame (M7)');
  },
};

// ───────────────────────── 9 天使 ─────────────────────────

function isFull(s: GameState, em: EngineMap, lot: LotId): boolean {
  const l = land(s, em, lot);
  if (l) return l.level >= (l.chain ? 1 : ECON.MAX_LEVEL);
  const f = fac(s, em, lot)!;
  return f.level > 0 && f.level >= FACILITY_CAPS[f.type];
}

export const angel: CardEffect = {
  menu(s, em, seat) {
    const lots = propertyLotsInRange(s, em, seat);
    const needType = lots.filter((l) => fac(s, em, l)?.level === 0);
    return usableIf({ t: 'lot', lots, needType }, lots.length === 0);
  },
  apply(ctx, seat, t) {
    if (t.t !== 'lot') return;
    const cause = { k: 'card', ref: 9, by: seat } as const;
    if (isFacilityLot(t.lot)) {
      raiseLot(ctx, t.lot, cause, t.facility);
      return;
    }
    for (const lot of streetOrSelf(ctx.map, t.lot)) if (!isFull(ctx.s, ctx.map, lot)) raiseLot(ctx, lot, cause);
  },
};

// ───────────────────────── 10 恶魔 / 11 怪兽 / 12 拆除 ─────────────────────────

/** 夷平（地主保留）：敌意 等级 × 30 × PI 先记上，随 LOT_MUTATED 一起公布 */
function flatten(ctx: Ctx, seat: SeatIndex, lots: readonly LotId[], card: 10 | 11): void {
  for (const lot of lots) {
    const st = lotState(ctx.s, ctx.map, lot);
    if (!st) continue;
    if (st.owner !== null && st.level > 0)
      addHostility(ctx, st.owner, seat, timesPI(ctx, st.level * CMB.HATE_LEVEL_PI));
    mutateLot(ctx, lot, 2, { k: 'card', ref: card, by: seat });
  }
}

export const devil: CardEffect = {
  menu(s, em, seat) {
    const lots = propertyLotsInRange(s, em, seat);
    return usableIf({ t: 'lot', lots, needType: [] }, lots.length === 0);
  },
  apply(ctx, seat, t) {
    if (t.t !== 'lot') return;
    flatten(ctx, seat, streetOrSelf(ctx.map, t.lot), 10);
  },
};

/** 范围内别人已有建筑的地产 */
function othersBuilt(s: GameState, em: EngineMap, seat: SeatIndex): LotId[] {
  return propertyLotsInRange(s, em, seat).filter((l) => {
    const st = lotState(s, em, l);
    return st !== null && st.owner !== null && st.owner !== seat && st.level > 0;
  });
}

export const monster: CardEffect = {
  menu(s, em, seat) {
    const lots = othersBuilt(s, em, seat);
    return usableIf({ t: 'lot', lots, needType: [] }, lots.length === 0);
  },
  apply(ctx, seat, t) {
    if (t.t !== 'lot') return;
    flatten(ctx, seat, [t.lot], 11);
  },
};

export const demolish: CardEffect = {
  menu(s, em, seat) {
    const lots = othersBuilt(s, em, seat);
    const c = centerOf(s, em, seat);
    const objects = s.objects
      .filter((o) => o.kind !== 'gift' && o.kind !== 'chest' && inRange(s, c, em.index.tile(o.node).world))
      .map((o) => o.id);
    return usableIf({ t: 'lotOrObject', lots, objects }, lots.length === 0 && objects.length === 0);
  },
  apply(ctx, seat, t) {
    if (t.t === 'object') {
      const obj = ctx.s.objects.find((o) => o.id === t.object);
      if (obj) removeObject(ctx, obj, { k: 'card', ref: 12, by: seat });
      return;
    }
    if (t.t !== 'lot') return;
    const st = lotState(ctx.s, ctx.map, t.lot);
    if (st?.owner != null) addHostility(ctx, st.owner, seat, timesPI(ctx, CMB.HATE_DEMOLISH_PI));
    mutateLot(ctx, t.lot, 0, { k: 'card', ref: 12, by: seat });
  },
};

// ───────────────────────── 27 涨价 / 28 查封 ─────────────────────────

function markCard(kind: 'raise' | 'seal'): CardEffect {
  return {
    menu(s, em, seat) {
      const lots = propertyLotsInRange(s, em, seat);
      return usableIf({ t: 'lot', lots, needType: [] }, lots.length === 0);
    },
    apply(ctx, _seat, t) {
      if (t.t !== 'lot') return;
      const lots = streetOrSelf(ctx.map, t.lot);
      for (const lot of lots) {
        const target = land(ctx.s, ctx.map, lot) ?? fac(ctx.s, ctx.map, lot)!;
        target.mark = { kind, days: ECON.MARK_DAYS };
      }
      ctx.emit('MARK_SET', { lots, kind, days: ECON.MARK_DAYS });
      // 查封研究所：清掉研发倒数（exe v3.11 0x4456cf：type==4 时 +0x1e = 0；r_items §6），补发 RESEARCH_CANCELLED
      const f = kind === 'seal' ? fac(ctx.s, ctx.map, t.lot) : null;
      if (f !== null && f.type === 'lab') cancelResearchOf(ctx, f);
    },
  };
}

export const raisePrice: CardEffect = markCard('raise');
export const seal: CardEffect = markCard('seal');
