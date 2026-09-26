/**
 * M4 各决策的 options 构造（design/engine.md §9.2）：银行、设施、研究所、百货、乐透、认购、建设公司。
 * 「只在确实有选择时才问」：没有任何可做的操作时返回 null，调用方不发决策。
 */
import { cardDef } from '../../data/tables/cards';
import { ECON } from '../../data/tables/economy';
import { FACILITY_CAPS } from '../../data/tables/facilities';
import { FACILITY_TYPES, ITEM_IDS, isPoolItem, researchItemOf } from '../../data/tables/ids';
import { itemDef } from '../../data/tables/items';
import { mul32 } from '../../util/int32';
import type { EngineMap } from '../core/mapCache';
import { bankChairman, financeLimitOf, loanLimitOf, newLoanDue } from '../rules/bank';
import { constructionFee } from '../rules/fee';
import { HAND_MAX, ITEM_MAX, sellValue } from '../rules/inventory';
import { playerAt } from '../rules/payment';
import {
  canBuildFacility,
  canBuyFacility,
  canUpgradeFacility,
  facilityCap,
  facilityLevelAfter,
  fortuneBonus,
} from '../rules/purchase';
import {
  type BankAtmOptions,
  type BankCounterOptions,
  type BuildFacilityOptions,
  type BuyFacilityOptions,
  type ConstructionPickOptions,
  type FacilityTypeOptions,
  type FacilityTypeRow,
  type LotteryOptions,
  type ResearchOptions,
  SHOP_TRADE_LIMIT,
  type ShopOptions,
  type ShopTradeRecord,
  type SubscribeSharesOptions,
  type UpgradeFacilityOptions,
} from '../types/decision';
import type { CardId, CompanyLotId, ResearchProject, SeatIndex } from '../types/ids';
import type { GameState } from '../types/state';

// ───────────────────────── 银行 ─────────────────────────

export function bankRunActive(s: GameState): boolean {
  return s.econ.bankRunDays > 0;
}

/** ATM：没有可存也没有可取时返回 null */
export function buildBankAtm(
  s: GameState,
  em: EngineMap,
  seat: SeatIndex,
  mode: 'pass' | 'stop',
): BankAtmOptions | null {
  const p = playerAt(s, seat);
  const canWithdraw = !bankRunActive(s);
  if (p.cash <= 0 && (!canWithdraw || p.deposit <= 0)) return null;
  return { mode, cash: p.cash, deposit: p.deposit, canWithdraw, reserveShortfallPayer: shortfallPayer(s, em, seat) };
}

/** 取款可能触发垫付的银行董事长：有融资余额、在场且不是取款人；否则 null */
function shortfallPayer(s: GameState, em: EngineMap, seat: SeatIndex): SeatIndex | null {
  const c = bankChairman(s, em);
  if (c === null || c === seat) return null;
  const p = playerAt(s, c);
  return p.alive && p.finance > 0 ? c : null;
}

/** 柜台：贷款、还款、特别融资都不可能时返回 null */
export function buildBankCounter(s: GameState, em: EngineMap, seat: SeatIndex): BankCounterOptions | null {
  const p = playerAt(s, seat);
  const loanBlocked = bankRunActive(s) ? 'bankRun' : null;
  const loanLimit = loanLimitOf(s, em, seat);
  const liquid = p.cash + p.deposit;
  const repayMax = Math.max(0, Math.min(p.loan, liquid));
  const financeLimit = financeLimitOf(s, em, seat);
  const canLoan = loanBlocked === null && loanLimit > 0;
  if (!canLoan && repayMax <= 0 && (financeLimit ?? 0) <= 0) return null;
  return {
    cash: p.cash,
    deposit: p.deposit,
    loan: p.loan,
    loanDue: p.loanDue,
    loanLimit,
    loanBlocked,
    dueDatePreview: p.loan > 0 && p.loanDue !== 0 ? p.loanDue : newLoanDue(s, em),
    repayMax,
    financeLimit,
    finance: p.finance,
  };
}

// ───────────────────────── 设施 ─────────────────────────

/** 各类型的上限与收费预览（旅馆 / 购物中心按转盘 1、1 级；加油站按 1 步、机车；公园、研究所 0） */
export function facilityTypeRows(s: GameState, em: EngineMap, facIdx: number, level: number): FacilityTypeRow[] {
  const mode = s.config.rules.intOverflow;
  const pi = s.econ.priceIndex;
  const rate = em.facilities[facIdx]!.rateWindow;
  return FACILITY_TYPES.map((type) => {
    const lv = Math.min(Math.max(level, 1), FACILITY_CAPS[type]);
    let feePreview = 0;
    if (type === 'hotel' || type === 'mall') feePreview = mul32(rate[lv]!, pi, mode);
    else if (type === 'gas') feePreview = mul32(ECON.GAS_PER_STEP, pi, mode);
    return { type, cap: facilityCap(type), feePreview };
  });
}

export function buildBuyFacility(
  s: GameState,
  em: EngineMap,
  seat: SeatIndex,
  facIdx: number,
): BuyFacilityOptions | null {
  const chk = canBuyFacility(s, em, seat, facIdx);
  if (!chk.ok) return null;
  const f = s.facilities[facIdx]!;
  return {
    lot: f.id,
    price: chk.price,
    cash: playerAt(s, seat).cash,
    level: f.level,
    type: f.type,
    fortuneBonus: fortuneBonus(s, playerAt(s, seat)) > 0,
  };
}

export function buildBuildFacility(
  s: GameState,
  em: EngineMap,
  seat: SeatIndex,
  facIdx: number,
): BuildFacilityOptions | null {
  const chk = canBuildFacility(s, seat, facIdx);
  if (!chk.ok) return null;
  const f = s.facilities[facIdx]!;
  return { lot: f.id, cost: chk.price, cash: playerAt(s, seat).cash, types: facilityTypeRows(s, em, facIdx, 1) };
}

export function buildUpgradeFacility(
  s: GameState,
  em: EngineMap,
  seat: SeatIndex,
  facIdx: number,
): UpgradeFacilityOptions | null {
  const chk = canUpgradeFacility(s, em, seat, facIdx);
  if (!chk.ok) return null;
  const f = s.facilities[facIdx]!;
  const p = playerAt(s, seat);
  return {
    lot: f.id,
    type: f.type,
    cost: chk.price,
    cash: p.cash,
    fromLevel: f.level,
    toLevel: facilityLevelAfter(f.level, 1 + fortuneBonus(s, p), f.type),
    cap: facilityCap(f.type),
  };
}

/** 免费首建：设施须仍为 0 级且归 seat 所有 */
export function buildFacilityType(
  s: GameState,
  em: EngineMap,
  seat: SeatIndex,
  facIdx: number,
): FacilityTypeOptions | null {
  const f = s.facilities[facIdx];
  if (!f || f.owner !== seat || f.level !== 0) return null;
  return { lot: f.id, types: facilityTypeRows(s, em, facIdx, 1) };
}

/** 研究所：自己的、已建成的研究所；可选项目 1..等级 */
export function buildResearch(s: GameState, seat: SeatIndex, facIdx: number): ResearchOptions | null {
  const f = s.facilities[facIdx];
  if (!f || f.owner !== seat || f.type !== 'lab' || f.level < 1) return null;
  const projects: ResearchOptions['projects'] = [];
  for (let n = 1; n <= f.level; n++) {
    const project = n as ResearchProject;
    projects.push({ project, item: researchItemOf(project), days: ECON.RESEARCH_DAYS });
  }
  return {
    lot: f.id,
    level: f.level,
    current: f.research ? { project: f.research.project, days: f.research.days } : null,
    projects,
  };
}

// ───────────────────────── 百货公司 ─────────────────────────

/** 电脑座位的货架：牌堆里每种剩余的卡各一行（按卡号） */
export function fullDeckShelf(s: GameState): CardId[] {
  const out: CardId[] = [];
  for (let c = 1; c < s.pools.cards.length; c++) if ((s.pools.cards[c] ?? 0) > 0) out.push(c as CardId);
  return out;
}

export function buildShop(
  s: GameState,
  seat: SeatIndex,
  shelf: readonly CardId[],
  fullDeck: boolean,
  visit: { entryPoints: number; trades: readonly ShopTradeRecord[] },
): ShopOptions {
  const p = playerAt(s, seat);
  const handFull = p.cards.length >= HAND_MAX;
  const remaining = Math.max(0, SHOP_TRADE_LIMIT - visit.trades.length);
  const rows = (fullDeck ? fullDeckShelf(s) : shelf).map((card, idx) => {
    const price = cardDef(card).price;
    const buyable = remaining > 0 && !handFull && p.points >= price && (s.pools.cards[card] ?? 0) > 0;
    return { idx, card, price, buyable };
  });
  const items = ITEM_IDS.filter((it) => isPoolItem(it)).map((item) => {
    const price = itemDef(item).price;
    const own = p.items[item] ?? 0;
    const pool = s.pools.items[item] ?? 0;
    const byPoints = price > 0 ? Math.trunc(p.points / price) : 0;
    const maxQty = remaining > 0 ? Math.max(0, Math.min(pool, ITEM_MAX - own, byPoints)) : 0;
    return { item, price, pool, own, maxQty };
  });
  return {
    points: p.points,
    handCount: p.cards.length,
    handMax: HAND_MAX,
    shelf: rows,
    fullDeck,
    items,
    sell: {
      cards: p.cards.map((card, slot) => ({ slot, card, value: sellValue(cardDef(card).price, 1) })),
      items: ITEM_IDS.filter((it) => (p.items[it] ?? 0) > 0).map((item) => ({
        item,
        count: p.items[item]!,
        unitValue: sellValue(itemDef(item).price, 1),
      })),
    },
    visit: { entryPoints: visit.entryPoints, trades: visit.trades.slice(), remaining },
  };
}

/** 进店后是否有任何可做的交易（买或卖） */
export function shopHasChoice(o: ShopOptions): boolean {
  if (o.visit.remaining <= 0) return false;
  return (
    o.shelf.some((r) => r.buyable) ||
    o.items.some((r) => r.maxQty > 0) ||
    o.sell.cards.length > 0 ||
    o.sell.items.length > 0
  );
}

// ───────────────────────── 乐透 ─────────────────────────

export function buildLottery(s: GameState, seat: SeatIndex): LotteryOptions | null {
  const p = playerAt(s, seat);
  if (p.cash < ECON.LOTTERY_TICKET) return null;
  if (!s.lottery.owners.some((o) => o === null)) return null;
  return { cash: p.cash, price: ECON.LOTTERY_TICKET, sold: s.lottery.owners.slice(), pool: s.econ.pool };
}

// ───────────────────────── 企业：认购与建设公司 ─────────────────────────

export function subscribeUnitPrice(em: EngineMap, companyIdx: number): number {
  return Math.trunc(em.companies[companyIdx]!.assetValue / ECON.SUBSCRIBE_UNIT_DIV);
}

export function buildSubscribe(
  s: GameState,
  em: EngineMap,
  seat: SeatIndex,
  companyIdx: number,
): SubscribeSharesOptions | null {
  const c = s.companies[companyIdx];
  if (!c || c.reserved <= 0) return null;
  const unit = subscribeUnitPrice(em, companyIdx);
  if (unit <= 0) return null;
  const p = playerAt(s, seat);
  const max = Math.min(ECON.SUBSCRIBE_MAX_SHARES, p.cash > 0 ? Math.trunc(p.cash / unit) : 0, c.reserved);
  if (max <= 0) return null;
  return { company: c.id, stock: c.stock, unitPrice: unit, max, cash: p.cash, reserved: c.reserved };
}

/** 建设公司的目标：自己的住宅（非连锁、未满 5 级）与自己已建成、未到上限的设施 */
export function constructionTargets(
  s: GameState,
  em: EngineMap,
  seat: SeatIndex,
  chairman: boolean,
): ConstructionPickOptions['lots'] {
  const p = playerAt(s, seat);
  const fee = (landPrice: number) => (chairman ? 0 : constructionFee(s, p, landPrice));
  const out: ConstructionPickOptions['lots'] = [];
  s.lands.forEach((l, i) => {
    if (l.owner !== seat || l.chain || l.level >= ECON.MAX_LEVEL) return;
    out.push({ lot: l.id, level: l.level, cost: fee(l.landPrice), rent: em.lands[i]!.rent[l.level] });
  });
  s.facilities.forEach((f) => {
    if (f.owner !== seat || f.level === 0 || f.level >= facilityCap(f.type)) return;
    out.push({ lot: f.id, level: f.level, cost: fee(f.landPrice), rent: 0 });
  });
  return out;
}

export function buildConstruction(
  s: GameState,
  em: EngineMap,
  seat: SeatIndex,
  company: CompanyLotId,
  chairman: boolean,
): ConstructionPickOptions | null {
  const lots = constructionTargets(s, em, seat, chairman);
  if (lots.length === 0) return null;
  return {
    company,
    chairman,
    levels: chairman ? s.config.rules.constructionChairmanLevels : 1,
    lots,
    canSkip: false,
  };
}
