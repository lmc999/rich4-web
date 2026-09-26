/**
 * 各 kind 的 options 构造（design/engine.md §9.2–§9.3）：渲染和 AI 需要的全部数值与合法候选都由引擎算好，
 * 客户端不需要重新实现规则。M1 实现 TURN_MENU、BUY_LAND、UPGRADE_LAND；其余在各自里程碑补上。
 */
import { ITEM_IDS, isPassiveCard } from '../../data/tables/ids';
import type { EngineMap } from '../core/mapCache';
import { diceAllowed } from '../rules/movement';
import { playerAt } from '../rules/payment';
import { canBuyLand, canUpgradeLand, fortuneBonus, upgradedLevel } from '../rules/purchase';
import { landTollPreview } from '../rules/toll';
import {
  type BuyLandOptions,
  MENU_ACTION_LIMIT,
  type StockRow,
  type TurnMenuOptions,
  type UpgradeLandOptions,
} from '../types/decision';
import type { SeatIndex } from '../types/ids';
import type { GameState } from '../types/state';

function stockRows(s: GameState, seat: SeatIndex): StockRow[] {
  const p = playerAt(s, seat);
  return s.stocks.map((st, i) => ({
    idx: st.idx,
    priceCents: st.priceCents,
    changePct10: st.prevCents > 0 ? Math.trunc(((st.priceCents - st.prevCents) * 1000) / st.prevCents) : 0,
    quota: p.quota[i] ?? 0,
    float: st.float,
    // 涨跌停、可买卖量由 M4 的 rules/stock 计算；M1 不开放交易
    limitUp: false,
    limitDown: false,
    suspended: st.suspend > 0,
    shares: p.holdings[i]?.shares ?? 0,
    costCents: p.holdings[i]?.costCents ?? 0,
    maxBuy: 0,
    maxSell: 0,
    chairman: st.chairman,
  }));
}

export function buildTurnMenu(s: GameState, em: EngineMap, seat: SeatIndex): TurnMenuOptions {
  void em;
  const p = playerAt(s, seat);
  const locked = p.st.stay !== 0 ? 'stay' : p.st.tortoise !== 0 ? 'tortoise' : null;
  const open = s.clock.marketOpen && s.econ.marketClosedDays === 0;
  const reason = open ? null : s.econ.marketClosedDays > 0 ? 'halted' : s.clock.weekday === 0 ? 'sunday' : 'holiday';
  return {
    dice: { allowed: diceAllowed(p.vehicle), current: p.diceCount, locked },
    // 卡片与道具的使用属于 M6：先列出手牌与背包，全部标记不可用
    cards: p.cards.map((card, slot) => ({
      slot,
      card,
      usable: false,
      reason: isPassiveCard(card) ? 'passive' : 'noTarget',
      targets: { t: 'none' },
    })),
    items: ITEM_IDS.filter((it) => (p.items[it] ?? 0) > 0).map((item) => ({
      item,
      count: p.items[item]!,
      usable: false,
      reason: 'noTarget',
      targets: { t: 'none' },
    })),
    stock: { open, reason, rows: stockRows(s, seat), deposit: p.deposit },
    board: { listings: [], mine: 0, canList: false, lotCaps: [] },
    canSurrender: false,
    timeMachine: { usable: false, anchorTurn: null },
    turnLog: p.turn.log.slice(),
    menuActions: { used: p.turn.menuActions, limit: MENU_ACTION_LIMIT },
  };
}

/** 无主住宅：买不起或被禁止时返回 null（不问） */
export function buildBuyLand(s: GameState, em: EngineMap, seat: SeatIndex, landIdx: number): BuyLandOptions | null {
  const chk = canBuyLand(s, em, seat, landIdx);
  if (!chk.ok) return null;
  const p = playerAt(s, seat);
  const land = s.lands[landIdx]!;
  const bonus = fortuneBonus(s, p);
  const level = bonus > 0 ? upgradedLevel(land.level, 0) : land.level;
  const streetIdx = em.streetOf(landIdx);
  return {
    lot: land.id,
    price: chk.price,
    cash: p.cash,
    level: land.level,
    street: { lots: streetIdx.map((i) => s.lands[i]!.id), owners: streetIdx.map((i) => s.lands[i]!.owner) },
    tollAfter: landTollPreview(s, em, landIdx, { landIdx, owner: seat, level: bonus > 0 ? level : land.level }),
    fortuneBonus: bonus > 0,
  };
}

/** 自己的住宅：不能盖时返回 null（不问） */
export function buildUpgradeLand(
  s: GameState,
  em: EngineMap,
  seat: SeatIndex,
  landIdx: number,
): UpgradeLandOptions | null {
  const chk = canUpgradeLand(s, em, seat, landIdx);
  if (!chk.ok) return null;
  const p = playerAt(s, seat);
  const land = s.lands[landIdx]!;
  const toLevel = upgradedLevel(land.level, fortuneBonus(s, p));
  return {
    lot: land.id,
    cost: chk.price,
    cash: p.cash,
    fromLevel: land.level,
    toLevel,
    tollBefore: landTollPreview(s, em, landIdx, null),
    tollAfter: landTollPreview(s, em, landIdx, { landIdx, owner: seat, level: toLevel }),
  };
}
