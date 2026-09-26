/**
 * 地产类决策（design/minigames-ai.md §9.7）：
 * - BUY_LAND / BUY_FACILITY：买，当且仅当 现金 + 存款 − 价格 > min(trunc(开局资金 × 5%), 7000) × PI（@0x41d7d4）；
 *   引擎只在 价格 ≤ 现金 时才问。不看仇恨，不看同街。
 * - UPGRADE_LAND / UPGRADE_FACILITY：能盖就盖（钱够、未满级），不留保留额（@0x419911）
 * - BUILD_FACILITY / FACILITY_TYPE：rng%4+1 → 旅馆 / 购物中心 / 加油站 / 研究所，永远不盖公园；首建付不起放弃（@0x41a23e）
 * - RESEARCH：当前可选的最高等级项目（@0x44101d）
 * - CONSTRUCTION_PICK：自己的住宅里当前等级租金最高的一块；没有住宅则地价最高的设施（@0x40b455）
 */
import { ECON } from '../../data/tables/economy';
import { FACILITY_TYPES, type FacilityType, type PlayerIntent } from '../../engine/types/index';
import type { DecisionForYou } from '../../view/types';
import type { AiContext } from '../types';
import type { AiView } from '../view';

/** 电脑买地保留额：min(trunc(开局资金 × 5%), 7000) × PI */
export function aiBuyReserve(v: AiView): number {
  const base = Math.min(Math.trunc((v.initialFund * ECON.AI_BUY_RESERVE_PCT) / 100), ECON.AI_BUY_RESERVE_CAP);
  return base * v.pi;
}

export function wantsToBuy(v: AiView, price: number): boolean {
  const me = v.me;
  return price <= me.cash && me.cash + me.deposit - price > aiBuyReserve(v);
}

export function buyLand(v: AiView, d: DecisionForYou<'BUY_LAND' | 'BUY_FACILITY'>): PlayerIntent {
  return wantsToBuy(v, d.options.price) ? { type: 'CONFIRM' } : { type: 'DECLINE' };
}

export function upgrade(v: AiView, d: DecisionForYou<'UPGRADE_LAND' | 'UPGRADE_FACILITY'>): PlayerIntent {
  return d.options.cost <= v.me.cash ? { type: 'CONFIRM' } : { type: 'DECLINE' };
}

/** rng%4+1：FACILITY_TYPES 下标 1..4（旅馆、购物中心、加油站、研究所） */
export function pickBuildType(ctx: AiContext): FacilityType {
  return FACILITY_TYPES[ctx.rng.mod(4) + 1]!;
}

export function buildFacility(v: AiView, d: DecisionForYou<'BUILD_FACILITY'>, ctx: AiContext): PlayerIntent {
  if (d.options.cost > v.me.cash) return { type: 'DECLINE' };
  const t = pickBuildType(ctx);
  return d.options.types.some((x) => x.type === t) ? { type: 'BUILD_FACILITY', facility: t } : { type: 'DECLINE' };
}

export function facilityType(_v: AiView, d: DecisionForYou<'FACILITY_TYPE'>, ctx: AiContext): PlayerIntent {
  const t = pickBuildType(ctx);
  return d.options.types.some((x) => x.type === t) ? { type: 'CHOOSE_FACILITY_TYPE', facility: t } : d.defaultIntent;
}

export function research(_v: AiView, d: DecisionForYou<'RESEARCH'>): PlayerIntent {
  const last = d.options.projects[d.options.projects.length - 1];
  return last ? { type: 'RESEARCH', project: last.project } : { type: 'SKIP' };
}

export function construction(v: AiView, d: DecisionForYou<'CONSTRUCTION_PICK'>): PlayerIntent {
  const lots = d.options.lots;
  let best: (typeof lots)[number] | null = null;
  for (const l of lots) {
    if (!l.lot.startsWith('L')) continue;
    if (best === null || l.rent > best.rent) best = l;
  }
  if (best === null) {
    let bestPrice = -1;
    for (const l of lots) {
      const f = v.view.facilities.find((x) => x.id === l.lot);
      if (f && f.landPrice > bestPrice) {
        bestPrice = f.landPrice;
        best = l;
      }
    }
  }
  if (best !== null) return { type: 'PICK_LOT', lot: best.lot };
  return d.options.canSkip ? { type: 'SKIP' } : d.defaultIntent;
}
