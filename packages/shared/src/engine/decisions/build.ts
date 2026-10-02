/**
 * 各 kind 的 options 构造（design/engine.md §9.2–§9.3）：渲染和 AI 需要的全部数值与合法候选都由引擎算好，
 * 客户端不需要重新实现规则。M1 实现 TURN_MENU、BUY_LAND、UPGRADE_LAND；M4 的决策见 decisions/economy.ts；
 * M6 的卡片、道具行由 effects 注册表给出（候选见 decisions/targets.ts）。
 */
import { type CardId, ITEM_IDS } from '../../data/tables/ids';
import type { EngineMap } from '../core/mapCache';
import { cardEffect } from '../effects/cards/index';
import { itemEffect } from '../effects/items/index';
import { canStowVehicle } from '../effects/items/vehicle';
import { timeMachineStatus } from '../effects/timeMachine';
import type { MenuRow } from '../effects/types';
import { canSurrender } from '../flow/surrender';
import { isMarketClosedDay } from '../rules/calendar';
import { diceAllowed } from '../rules/movement';
import { boardOptions } from '../rules/noticeBoard';
import { playerAt } from '../rules/payment';
import { canBuyLand, canUpgradeLand, fortuneBonus, upgradedLevel } from '../rules/purchase';
import { isLimitDown, isLimitUp, maxBuyShares, maxSellShares } from '../rules/stock';
import { landTollPreview } from '../rules/toll';
import {
  type BuyLandOptions,
  MENU_ACTION_LIMIT,
  type StockRow,
  type TurnMenuCardRow,
  type TurnMenuOptions,
  type UpgradeLandOptions,
} from '../types/decision';
import type { SeatIndex } from '../types/ids';
import type { GameState } from '../types/state';

function stockRows(s: GameState, seat: SeatIndex, open: boolean): StockRow[] {
  const p = playerAt(s, seat);
  return s.stocks.map((st, i) => ({
    idx: st.idx,
    priceCents: st.priceCents,
    changePct10: st.prevCents > 0 ? Math.trunc(((st.priceCents - st.prevCents) * 1000) / st.prevCents) : 0,
    quota: p.quota[i] ?? 0,
    float: st.float,
    limitUp: isLimitUp(st),
    limitDown: isLimitDown(st),
    suspended: st.suspend > 0,
    shares: p.holdings[i]?.shares ?? 0,
    costCents: p.holdings[i]?.costCents ?? 0,
    maxBuy: maxBuyShares(s, seat, i, open),
    maxSell: maxSellShares(s, seat, i, open),
    chairman: st.chairman,
  }));
}

function cardRows(s: GameState, em: EngineMap, seat: SeatIndex): TurnMenuCardRow[] {
  const p = playerAt(s, seat);
  const cache = new Map<CardId, MenuRow>();
  return p.cards.map((card, slot) => {
    let row = cache.get(card);
    if (row === undefined) {
      row = cardEffect(card).menu(s, em, seat);
      cache.set(card, row);
    }
    return { slot, card, usable: row.usable, reason: row.reason, targets: row.targets };
  });
}

export function buildTurnMenu(s: GameState, em: EngineMap, seat: SeatIndex): TurnMenuOptions {
  const p = playerAt(s, seat);
  const locked = p.st.stay !== 0 ? 'stay' : p.st.tortoise !== 0 ? 'tortoise' : null;
  const open = s.clock.marketOpen && s.econ.marketClosedDays === 0;
  const closedDay = isMarketClosedDay(s.clock.date, s.clock.weekday, em.def.holidays);
  const reason = open
    ? null
    : s.econ.marketClosedDays > 0 || !closedDay
      ? 'halted'
      : s.clock.weekday === 0
        ? 'sunday'
        : 'holiday';
  return {
    dice: { allowed: diceAllowed(p.vehicle), current: p.diceCount, locked },
    // 卡片与道具：可用性、原因与合法候选来自效果注册表（同一张卡的多个卡槽共用一次计算）
    cards: cardRows(s, em, seat),
    items: ITEM_IDS.filter((it) => (p.items[it] ?? 0) > 0).map((item) => {
      const row = itemEffect(item).menu(s, em, seat);
      return { item, count: p.items[item]!, usable: row.usable, reason: row.reason, targets: row.targets };
    }),
    vehicle: { current: p.vehicle, canStow: canStowVehicle(p) },
    stock: { open, reason, rows: stockRows(s, seat, open), deposit: p.deposit },
    board: boardOptions(s, em, seat),
    canSurrender: canSurrender(s, seat),
    timeMachine: timeMachineStatus(s, seat),
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
