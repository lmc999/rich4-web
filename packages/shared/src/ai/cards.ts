/**
 * 原版 AI 的用卡判据（design/minigames-ai.md §9.5；入口为 exe 跳表 v311:0x475328）。
 * 每个判据只读公平视图与本座位的 TURN_MENU 行（row.targets 是引擎算好的合法候选），返回想用的目标或 null。
 * 调用方（preRoll）再用 targetMatches 自检，不在候选里就放弃，保证 100% 合法。
 * 随机数一律用 ctx.turnRng('card:<号>')（同一回合重复调用结果稳定）。
 * 简化 ⚑：乌龟卡只判断对自己用；涨价卡的「esi 残值怪癖」按有意简化处理（取我第一栋 ≥3 级的非公园、非研究所设施）。
 */
import { cardDef } from '../data/tables/cards';
import { FACILITY_TYPES } from '../data/tables/ids';
import { stockLimitPrices } from '../engine/selectors/index';
import type { ActorRef, CardId, SeatIndex, TurnMenuCardRow, UseTarget } from '../engine/types/index';
import { inViewWindow, VIEW_WINDOW_HALF } from '../geom/viewWindow';
import { EQUAL_WEALTH_CASH, EQUAL_WEALTH_RATIO, HATED_CASH, MONEY_FLOOR, RIVAL_CASH } from './constants';
import type { AiContext } from './types';
import type { AiLot, AiView } from './view';

export type CardJudge = (v: AiView, row: TurnMenuCardRow, ctx: AiContext) => UseTarget | null;

/** 坏神：小/大穷神、小/大衰神、恶魔、死神 */
export const BAD_GODS: readonly number[] = [5, 6, 7, 8, 10, 15];
/** 请神符只请：小/大财神、小/大福神、土地公 */
export const WANTED_GODS: readonly number[] = [1, 2, 3, 4, 12];

const NONE: UseTarget = { t: 'none' };

/**
 * worthTaking(enemy, lot)（@0x41e8e6）：enemy == −1 → false。
 * 住宅：有主、不是我的、有房子，并且（同街有我的地，或者地主正是 enemy 且等级 ≥ 2）；设施：有主、不是我的、等级 > 0。
 */
export function worthTaking(v: AiView, enemy: SeatIndex | -1, lot: AiLot): boolean {
  if (enemy === -1 || lot.owner === null || lot.owner === v.seat || lot.level <= 0) return false;
  if (lot.kind === 'facility') return true;
  const mineOnStreet = v.streetLots(lot.street!).some((l) => l.owner === v.seat);
  return mineOnStreet || (lot.owner === enemy && lot.level >= 2);
}

function underfoot(v: AiView, row: TurnMenuCardRow): AiLot | null {
  return row.targets.t === 'underfoot' ? v.lot(row.targets.lot) : null;
}

function seatCands(row: TurnMenuCardRow): SeatIndex[] {
  return row.targets.t === 'seat' ? row.targets.seats : [];
}

function lotCands(row: TurnMenuCardRow): string[] {
  return row.targets.t === 'lot' || row.targets.t === 'lotOrObject' ? row.targets.lots : [];
}

function cashOf(v: AiView, seat: SeatIndex): number {
  return v.player(seat).cash;
}

/** 下标最大者 */
function maxSeat(seats: readonly SeatIndex[]): SeatIndex | null {
  let best: SeatIndex | null = null;
  for (const s of seats) if (best === null || s > best) best = s;
  return best;
}

function streetsInView(v: AiView, cands: readonly string[]): Map<string, AiLot[]> {
  const out = new Map<string, AiLot[]>();
  for (const id of cands) {
    const l = v.lot(id as AiLot['id']);
    if (l?.kind !== 'land' || out.has(l.street!)) continue;
    out.set(l.street!, v.streetLots(l.street!));
  }
  return out;
}

function firstCand(lots: readonly AiLot[], cands: readonly string[]): string | null {
  for (const l of lots) if (cands.includes(l.id)) return l.id;
  return null;
}

// ───────────────────────── 各卡判据 ─────────────────────────

const equalWealth: CardJudge = (v) => {
  const alive = v.view.players.filter((p) => p.alive);
  const avg = alive.reduce((a, p) => a + p.cash, 0) / Math.max(1, alive.length);
  const mine = v.me.cash;
  return avg > mine * EQUAL_WEALTH_RATIO && mine < EQUAL_WEALTH_CASH * v.pi ? NONE : null;
};

const equalPoverty: CardJudge = (v, row) => {
  const seats = seatCands(row);
  const hated = v.mostHated();
  const mine = v.me.cash;
  if (hated !== -1 && seats.includes(hated)) {
    const c = cashOf(v, hated);
    if (c > HATED_CASH * v.pi && c > mine * 2) return { t: 'seat', seat: hated };
  }
  const rich = seats.filter((s) => cashOf(v, s) > RIVAL_CASH * v.pi && cashOf(v, s) > mine * 3);
  const t = maxSeat(rich);
  return t === null ? null : { t: 'seat', seat: t };
};

const buyLand: CardJudge = (v, row) => {
  const l = underfoot(v, row);
  if (!l || !worthTaking(v, v.mostHated(), l)) return null;
  const price = (l.landPrice + l.housePrice * l.level) * v.pi;
  return price < v.me.cash ? { t: 'underfoot', facility: null } : null;
};

const swapLand: CardJudge = (v, row) => {
  if (row.targets.t !== 'lotPair') return null;
  const from = v.lot(row.targets.from);
  if (!from || from.owner !== v.seat || from.level > 1) return null;
  if (from.kind === 'land' && v.streetLots(from.street!).some((l) => l.id !== from.id && l.owner === v.seat)) {
    return null;
  }
  const hated = v.mostHated();
  const to = row.targets.to
    .map((id) => v.lot(id))
    .filter((l): l is AiLot => l !== null)
    .sort((a, b) => a.world.y - b.world.y || a.world.x - b.world.x);
  for (const l of to) {
    if (l.kind === 'land' && l.street === from.street) continue;
    if (l.landPrice > from.landPrice && l.level > from.level && worthTaking(v, hated, l)) {
      return { t: 'lotPair', from: from.id, to: l.id };
    }
  }
  return null;
};

const rebuild: CardJudge = (v, row, ctx) => {
  const l = underfoot(v, row);
  if (!l || row.targets.t !== 'underfoot') return null;
  if (l.kind === 'land') {
    if (l.owner !== v.seat) return null;
    const others = v.streetLots(l.street!).filter((x) => x.id !== l.id);
    if (l.chain) return others.some((x) => x.owner === v.seat) ? { t: 'underfoot', facility: null } : null;
    if (l.level !== 1) return null;
    if (ctx.traits.personality === 0) return { t: 'underfoot', facility: null };
    return others.every((x) => x.owner !== null && x.owner !== v.seat) ? { t: 'underfoot', facility: null } : null;
  }
  const types = row.targets.types ?? [];
  if (l.owner === v.seat && l.type === 'park' && l.level === 1) {
    const t = FACILITY_TYPES[ctx.turnRng('card:7').mod(4) + 1]!;
    return types.includes(t) ? { t: 'underfoot', facility: t } : null;
  }
  const hated = v.mostHated();
  if (l.owner !== null && l.owner !== v.seat && l.type !== 'park') {
    const need = l.owner === hated ? 2 : 3;
    if (l.level >= need && types.includes('park')) return { t: 'underfoot', facility: 'park' };
  }
  return null;
};

const auction: CardJudge = (v, row) => {
  const l = underfoot(v, row);
  if (!l || l.owner === null || l.owner === v.seat) return null;
  return l.level >= 3 || (l.owner === v.mostHated() && l.level >= 2) ? { t: 'underfoot', facility: null } : null;
};

const angel: CardJudge = (v, row, ctx) => {
  const cands = lotCands(row);
  const streets: AiLot[][] = [];
  for (const lots of streetsInView(v, cands).values()) {
    if (lots.filter((l) => l.owner === v.seat && !l.chain && l.level < 5).length >= 3) streets.push(lots);
  }
  if (streets.length === 0) return null;
  const pick = streets[ctx.turnRng('card:9').mod(streets.length)]!;
  const lot = firstCand(pick, cands);
  return lot === null ? null : { t: 'lot', lot: lot as AiLot['id'], facility: null };
};

const devil: CardJudge = (v, row) => {
  const cands = lotCands(row);
  const hated = v.mostHated();
  for (const lots of streetsInView(v, cands).values()) {
    const mine = lots.filter((l) => l.owner === v.seat);
    const mySum = mine.reduce((a, l) => a + l.level, 0);
    let ok: boolean;
    if (hated !== -1) {
      const his = lots.filter((l) => l.owner === hated);
      ok = his.length >= 2 && his.reduce((a, l) => a + l.level, 0) >= 7 && mySum <= 1;
    } else {
      const opp = lots.filter((l) => l.owner !== null && l.owner !== v.seat);
      ok = mine.length === 0 && opp.length >= 3 && opp.reduce((a, l) => a + l.level, 0) >= 9;
    }
    if (!ok) continue;
    const lot = firstCand(lots, cands);
    if (lot !== null) return { t: 'lot', lot: lot as AiLot['id'], facility: null };
  }
  return null;
};

/** 怪兽 / 拆除共用：最恨的人的设施优先、再看他的地，取最高级（同级取更贵）且 ≥3；没有最恨的人：全体对手，设施 ≥3、地 ≥4 */
function monsterPick(v: AiView, cands: readonly string[]): string | null {
  const hated = v.mostHated();
  const lots = cands.map((id) => v.lot(id as AiLot['id'])).filter((l): l is AiLot => l !== null && l.level > 0);
  const best = (xs: AiLot[], min: number): AiLot | null => {
    let b: AiLot | null = null;
    for (const l of xs) {
      if (l.level < min) continue;
      if (b === null || l.level > b.level || (l.level === b.level && l.landPrice > b.landPrice)) b = l;
    }
    return b;
  };
  if (hated !== -1) {
    const his = lots.filter((l) => l.owner === hated);
    const f = best(
      his.filter((l) => l.kind === 'facility'),
      3,
    );
    const l =
      f ??
      best(
        his.filter((x) => x.kind === 'land'),
        3,
      );
    return l?.id ?? null;
  }
  const opp = lots.filter((l) => l.owner !== null && l.owner !== v.seat);
  const f = best(
    opp.filter((l) => l.kind === 'facility'),
    3,
  );
  const l =
    f ??
    best(
      opp.filter((x) => x.kind === 'land'),
      4,
    );
  return l?.id ?? null;
}

const monster: CardJudge = (v, row) => {
  const lot = monsterPick(v, lotCands(row));
  return lot === null ? null : { t: 'lot', lot: lot as AiLot['id'], facility: null };
};

const demolish: CardJudge = (v, row, ctx) => {
  if (row.targets.t !== 'lotOrObject') return null;
  const lot = monsterPick(v, row.targets.lots);
  if (lot !== null) return { t: 'lot', lot: lot as AiLot['id'], facility: null };
  // 按屏幕行序扫：对手的连锁店（他连锁店 ≥4 间，乖宝宝不做）/ 我有座驾时对手的加油站
  for (const l of v.lotsInView()) {
    if (!row.targets.lots.includes(l.id) || l.owner === null || l.owner === v.seat) continue;
    if (l.chain && ctx.traits.personality !== 0) {
      const n = v.allLots().filter((x) => x.chain && x.owner === l.owner).length;
      if (n >= 4) return { t: 'lot', lot: l.id, facility: null };
    }
    if (l.type === 'gas' && v.me.vehicle !== 'walk') return { t: 'lot', lot: l.id, facility: null };
  }
  // 对手地上的路障 / 我地上的地雷
  for (const id of row.targets.objects) {
    const o = v.view.objects.find((x) => x.id === id);
    if (!o) continue;
    const l = v.lotAt(o.node);
    if (!l) continue;
    if (o.kind === 'roadblock' && l.owner !== null && l.owner !== v.seat) return { t: 'object', object: id };
    if (o.kind === 'mine' && l.owner === v.seat) return { t: 'object', object: id };
  }
  return null;
};

const rob: CardJudge = (v, row) => {
  if (row.targets.t !== 'rob') return null;
  const hated = v.mostHated();
  const pickCard = (min: number, exact: boolean, seats: readonly SeatIndex[]) => {
    let best: { seat: SeatIndex; slot: number; price: number } | null = null;
    for (const vic of row.targets.t === 'rob' ? row.targets.victims : []) {
      if (!seats.includes(vic.seat)) continue;
      for (const c of vic.cards) {
        const def = cardDef(c.card);
        if (exact ? def.f7 !== min : def.f7 < min) continue;
        if (best === null || def.price > best.price) best = { seat: vic.seat, slot: c.slot, price: def.price };
      }
    }
    return best;
  };
  const all = row.targets.victims.map((x) => x.seat);
  const b = (hated !== -1 ? pickCard(1, false, [hated]) : null) ?? pickCard(2, true, all);
  return b === null ? null : { t: 'rob', seat: b.seat, take: { k: 'card', slot: b.slot } };
};

const stay: CardJudge = (v, row) => {
  if (row.targets.t !== 'actor') return null;
  const actors: ActorRef[] = row.targets.actors;
  const me = v.me;
  const self = actors.some((a) => a.t === 'seat' && a.seat === v.seat);
  if (self && me.st.tortoise === 0 && me.placed) {
    const l = v.lotAt(me.node);
    const money = me.cash + me.deposit > MONEY_FLOOR && me.luck.wealth >= 0;
    if (l && l.owner === v.seat && money) {
      if (l.kind === 'land' && !l.chain && l.level < 5 && l.housePrice * v.pi < me.cash) {
        const others = v.streetLots(l.street!).some((x) => x.id !== l.id && x.owner === v.seat);
        if (others || l.level >= 2) return { t: 'actor', actor: { t: 'seat', seat: v.seat } };
      }
      if (l.kind === 'facility' && l.type !== 'park' && l.type !== 'gas' && l.level < 5 && me.cash > MONEY_FLOOR) {
        return { t: 'actor', actor: { t: 'seat', seat: v.seat } };
      }
    }
  }
  for (const a of actors) {
    if (a.t !== 'seat' || a.seat === v.seat) continue;
    const p = v.player(a.seat);
    const l = v.lotAt(p.node);
    if (l && l.kind === 'facility' && l.owner === v.seat && l.level >= 2 && l.type !== 'park')
      return { t: 'actor', actor: a };
    const company = v.map.tile(p.node).ref?.lot;
    if (company?.startsWith('C')) {
      const c = v.map.def.companies.find((x) => x.id === company);
      if (c && v.view.stocks[c.stockIndex]?.chairman === v.seat) return { t: 'actor', actor: a };
    }
  }
  return null;
};

const hibernate: CardJudge = (_v, _row, ctx) => (ctx.turnRng('card:15').mod(4) === 0 ? NONE : null);

/** 梦游 / 陷害：视野内对手中未冬眠、且手里没有复仇卡（可见时）的：最恨的人优先，否则随机 */
function harmJudge(card: CardId): CardJudge {
  return (v, row, ctx) => {
    if (row.targets.t !== 'actor') return null;
    const seats = row.targets.actors.filter((a) => a.t === 'seat').map((a) => (a as { seat: SeatIndex }).seat);
    const ok = seats.filter((s) => {
      const p = v.player(s);
      if (p.st.hibernate !== 0) return false;
      return ctx.handVisibility === 'private' || p.cards === null || !p.cards.includes(18);
    });
    if (ok.length === 0) return null;
    const hated = v.mostHated();
    const t = hated !== -1 && ok.includes(hated) ? hated : ok[ctx.turnRng(`card:${card}`).mod(ok.length)]!;
    return { t: 'actor', actor: { t: 'seat', seat: t } };
  };
}

const dispelGod: CardJudge = (v) => {
  const me = v.me;
  return me.bomb !== null || (me.god !== null && BAD_GODS.includes(me.god.kind)) ? NONE : null;
};

const summonGod: CardJudge = (v) => {
  const me = v.me;
  if (me.god !== null && WANTED_GODS.includes(me.god.kind)) return null;
  const c = v.center;
  if (c === null) return null;
  let best: { kind: number; key: [number, number, number, number] } | null = null;
  for (const g of v.roadGods()) {
    if (g.kind === 11 || g.kind === 15) continue;
    const w = v.tileWorld(g.node);
    if (!inViewWindow(c, w, VIEW_WINDOW_HALF)) continue;
    const dx = w.x - c.x;
    const dy = w.y - c.y;
    const key: [number, number, number, number] = [dx * dx + dy * dy, w.y, w.x, g.slot];
    if (best === null || lexLess(key, best.key)) best = { kind: g.kind, key };
  }
  return best !== null && WANTED_GODS.includes(best.kind) ? NONE : null;
};

function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

function holdingValue(v: AiView, seat: SeatIndex, idx: number): number {
  const n = v.player(seat).holdings[idx]?.shares ?? 0;
  const st = v.view.stocks[idx];
  return st ? Math.trunc((n * st.priceCents) / 100) : 0;
}

const redCard: CardJudge = (v, row) => {
  if (row.targets.t !== 'stock') return null;
  let best: { idx: number; value: number } | null = null;
  for (const idx of row.targets.stocks) {
    const st = v.view.stocks[idx];
    if (!st || st.suspend > 0 || (st.priceCents > st.prevCents && st.priceCents >= stockLimitPrices(st.prevCents).up)) {
      continue;
    }
    const value = holdingValue(v, v.seat, idx);
    if (value > 0 && (best === null || value > best.value)) best = { idx, value };
  }
  return best === null ? null : { t: 'stock', stock: best.idx };
};

const blackCard: CardJudge = (v, row) => {
  if (row.targets.t !== 'stock') return null;
  const cands = row.targets.stocks;
  const eligible = (idx: number) => {
    const st = v.view.stocks[idx];
    if (!st || st.suspend > 0 || (v.me.holdings[idx]?.shares ?? 0) > 0) return false;
    return !(st.priceCents < st.prevCents && st.priceCents <= stockLimitPrices(st.prevCents).down);
  };
  const largest = (seat: SeatIndex, companyOnly: boolean) => {
    let best: { idx: number; value: number } | null = null;
    for (const idx of cands) {
      if (!eligible(idx) || (companyOnly && v.companyOfStock(idx) === null)) continue;
      const value = holdingValue(v, seat, idx);
      if (value > 0 && (best === null || value > best.value)) best = { idx, value };
    }
    return best;
  };
  const hated = v.mostHated();
  let pick = hated !== -1 ? largest(hated, false) : null;
  if (pick === null) {
    // 拥有企业（董事长）最多的对手
    let who: SeatIndex | null = null;
    let most = 0;
    for (const s of v.rivals()) {
      const n = v.view.stocks.filter((st, i) => st.chairman === s && v.companyOfStock(i) !== null).length;
      if (n > most) {
        most = n;
        who = s;
      }
    }
    if (who !== null) pick = largest(who, true);
  }
  return pick === null ? null : { t: 'stock', stock: pick.idx };
};

const taxAudit: CardJudge = (v, row) => {
  const seats = seatCands(row);
  const hated = v.mostHated();
  if (hated !== -1 && seats.includes(hated) && cashOf(v, hated) > HATED_CASH * v.pi) return { t: 'seat', seat: hated };
  const t = maxSeat(seats.filter((s) => cashOf(v, s) > RIVAL_CASH * v.pi));
  return t === null ? null : { t: 'seat', seat: t };
};

const raisePrice: CardJudge = (v, row) => {
  const cands = lotCands(row);
  const hated = v.mostHated();
  for (const lots of streetsInView(v, cands).values()) {
    if (hated !== -1 && lots.some((l) => l.owner === hated)) continue;
    const mine = lots.filter((l) => l.owner === v.seat);
    const opp = lots.filter((l) => l.owner !== null && l.owner !== v.seat);
    const mySum = mine.reduce((a, l) => a + l.level, 0);
    const oppSum = opp.reduce((a, l) => a + l.level, 0);
    if (mySum >= 7 && oppSum <= 3 && 100 * mine.length >= 66 * lots.length) {
      const lot = firstCand(mine, cands);
      if (lot !== null) return { t: 'lot', lot: lot as AiLot['id'], facility: null };
    }
  }
  for (const id of cands) {
    const l = v.lot(id as AiLot['id']);
    if (l?.kind === 'facility' && l.owner === v.seat && l.level >= 3 && l.type !== 'park' && l.type !== 'lab') {
      return { t: 'lot', lot: l.id, facility: null };
    }
  }
  return null;
};

const seal: CardJudge = (v, row, ctx) => {
  const cands = lotCands(row);
  const ahead = v.lookahead(6, ctx.turnRng('card:28'));
  for (const node of ahead.nodes) {
    const l = v.lotAt(node);
    if (l?.kind !== 'land' || !cands.includes(l.id)) continue;
    const lots = v.streetLots(l.street!);
    if (lots.some((x) => x.owner === v.seat)) continue;
    const oppSum = lots.filter((x) => x.owner !== null).reduce((a, x) => a + x.level, 0);
    if (oppSum >= 7) return { t: 'lot', lot: l.id, facility: null };
  }
  const hated = v.mostHated();
  for (const id of cands) {
    const l = v.lot(id as AiLot['id']);
    if (l?.kind === 'facility' && l.owner === hated && l.level >= 3 && l.type !== 'park') {
      return { t: 'lot', lot: l.id, facility: null };
    }
  }
  return null;
};

const alliance: CardJudge = (v, row) => {
  const hated = v.mostHated();
  let best: { seat: SeatIndex; n: number } | null = null;
  for (const s of seatCands(row)) {
    if (s === hated || v.me.alliance?.seat === s) continue;
    const n = v.allLots().filter((l) => l.owner === s).length;
    if (best === null || n > best.n) best = { seat: s, n };
  }
  return best === null ? null : { t: 'seat', seat: best.seat };
};

const tortoise: CardJudge = (v, row, ctx) => {
  if (row.targets.t !== 'actor') return null;
  if (!row.targets.actors.some((a) => a.t === 'seat' && a.seat === v.seat)) return null;
  const me = v.me;
  if (me.cash + me.deposit <= MONEY_FLOOR || me.luck.wealth < 0 || me.st.tortoise !== 0) return null;
  const ahead = v.lookahead(3, ctx.turnRng('card:30'));
  if (ahead.forked) return null;
  let cost = 0;
  let usableTiles = 0;
  for (const node of ahead.nodes) {
    const l = v.lotAt(node);
    if (!l) continue;
    if (l.owner === null) {
      cost += (l.landPrice + l.housePrice * l.level) * v.pi;
      usableTiles++;
    } else if (l.owner === v.seat) {
      if (l.kind === 'land' && !l.chain && l.level < 5) {
        cost += l.housePrice * v.pi;
        usableTiles++;
      }
    } else if (v.streetToll(l) > 1000 * v.pi) return null;
  }
  return usableTiles >= 2 && cost * 1.5 < me.cash ? { t: 'actor', actor: { t: 'seat', seat: v.seat } } : null;
};

const never: CardJudge = () => null;

export const CARD_AI = Object.freeze({
  1: equalWealth,
  2: equalPoverty,
  3: buyLand,
  4: swapLand,
  5: never,
  6: never,
  7: rebuild,
  8: auction,
  9: angel,
  10: devil,
  11: monster,
  12: demolish,
  13: rob,
  14: stay,
  15: hibernate,
  16: harmJudge(16),
  17: harmJudge(17),
  18: never,
  19: never,
  20: never,
  21: never,
  22: dispelGod,
  23: summonGod,
  24: redCard,
  25: blackCard,
  26: taxAudit,
  27: raisePrice,
  28: seal,
  29: alliance,
  30: tortoise,
} satisfies { readonly [C in CardId]: CardJudge });
