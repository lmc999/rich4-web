/**
 * BasicAiPolicy（architecture §5.11；M1 交付，供 M2 的 AiDriver 与 scripts/simulate 使用）。
 * 对 23 种决策都给出「合法但简单」的回答；拿不准的一律退回 defaultIntent（引擎保证它合法）。
 * 只读投影后的 GameView 与本座位的 DecisionForYou，随机数只来自 ctx（不碰引擎 RNG，不读 secret）。
 * 规则取自原版 AI 的简化（design/minigames-ai.md §9.7）：
 * - 买地 / 买设施：价格 ≤ 现金，且 现金 + 存款 − 价格 > min(trunc(开局资金 × 5%), 7000) × PI；
 * - 加盖：钱够就盖；首建设施：rng%4 选旅馆 / 购物中心 / 加油站 / 研究所，从不盖公园；
 * - 掷骰：交通工具允许的最多颗数；小游戏一律 decline；拍卖一律 PASS；其余多为 SKIP / DECLINE。
 */
import { cardDef } from '../data/tables/cards';
import { ECON } from '../data/tables/economy';
import type { DecisionKind, FacilityType, MagicEffectId, PlayerIntent, SeatIndex } from '../engine/types/index';
import type { DecisionForYou, GameView } from '../view/types';
import type { AiContext, AiHandler, AiHandlers, AiPolicy } from './types';

function me(view: GameView, seat: SeatIndex) {
  const p = view.players.find((x) => x.seat === seat);
  if (!p) throw new RangeError(`no player at seat ${seat}`);
  return p;
}

/** 电脑买地保留额：min(trunc(开局资金 × 5%), 7000) × PI */
export function buyReserve(view: GameView): number {
  const base = Math.min(Math.trunc((view.econ.initialFund * ECON.AI_BUY_RESERVE_PCT) / 100), ECON.AI_BUY_RESERVE_CAP);
  return base * view.econ.priceIndex;
}

function wantsToBuy(view: GameView, seat: SeatIndex, price: number): boolean {
  const p = me(view, seat);
  return price <= p.cash && p.cash + p.deposit - price > buyReserve(view);
}

const BUILD_TYPES: readonly FacilityType[] = ['hotel', 'mall', 'gas', 'lab'];

function pickFacilityType(offered: readonly FacilityType[], ctx: AiContext): FacilityType | null {
  const want = BUILD_TYPES[ctx.rng.mod(BUILD_TYPES.length)]!;
  if (offered.includes(want)) return want;
  return offered.find((t) => t !== 'park') ?? offered[0] ?? null;
}

export const BASIC_HANDLERS = Object.freeze({
  TURN_MENU: (_v, d) => {
    const o = d.options.dice;
    const max = o.allowed[o.allowed.length - 1];
    return o.locked !== null || max === undefined ? { type: 'ROLL' } : { type: 'ROLL', dice: max };
  },
  BANK_ATM: () => ({ type: 'SKIP' }),
  BANK_COUNTER: () => ({ type: 'SKIP' }),
  BUY_LAND: (v, d) => (wantsToBuy(v, d.seat, d.options.price) ? { type: 'CONFIRM' } : { type: 'DECLINE' }),
  UPGRADE_LAND: (v, d) => (d.options.cost <= me(v, d.seat).cash ? { type: 'CONFIRM' } : { type: 'DECLINE' }),
  BUY_FACILITY: (v, d) => (wantsToBuy(v, d.seat, d.options.price) ? { type: 'CONFIRM' } : { type: 'DECLINE' }),
  BUILD_FACILITY: (v, d, ctx) => {
    if (d.options.cost > me(v, d.seat).cash) return { type: 'DECLINE' };
    const t = pickFacilityType(
      d.options.types.map((x) => x.type),
      ctx,
    );
    return t === null ? { type: 'DECLINE' } : { type: 'BUILD_FACILITY', facility: t };
  },
  UPGRADE_FACILITY: (v, d) => (d.options.cost <= me(v, d.seat).cash ? { type: 'CONFIRM' } : { type: 'DECLINE' }),
  FACILITY_TYPE: (_v, d, ctx) => {
    const t = pickFacilityType(
      d.options.types.map((x) => x.type),
      ctx,
    );
    return t === null ? d.defaultIntent : { type: 'CHOOSE_FACILITY_TYPE', facility: t };
  },
  RESEARCH: (_v, d) => {
    const last = d.options.projects[d.options.projects.length - 1];
    return last ? { type: 'RESEARCH', project: last.project } : { type: 'SKIP' };
  },
  SHOP: () => ({ type: 'LEAVE' }),
  LOTTERY: (v, d, ctx) => {
    const free: number[] = [];
    d.options.sold.forEach((o, i) => {
      if (o === null) free.push(i);
    });
    if (me(v, d.seat).cash <= d.options.price || free.length === 0) return { type: 'SKIP' };
    return { type: 'LOTTERY_BUY', number: free[ctx.rng.mod(free.length)]! };
  },
  BAIL: () => ({ type: 'SKIP' }),
  MINIGAME: () => ({ type: 'MINIGAME_DECLINE' }),
  MAGIC_CAST: (_v, d, ctx) => {
    if (d.options.targets.includes(d.seat)) return { type: 'MAGIC_CAST', effect: 6 };
    const r = ctx.rng.mod(11);
    const effect = (r === 6 ? 7 : r) as MagicEffectId;
    return d.options.effects.includes(effect) ? { type: 'MAGIC_CAST', effect } : d.defaultIntent;
  },
  CONSTRUCTION_PICK: (v, d) => {
    const cash = me(v, d.seat).cash;
    const affordable = d.options.lots.filter((l) => l.cost <= cash);
    if (affordable.length === 0) return d.options.canSkip ? { type: 'SKIP' } : d.defaultIntent;
    let best = affordable[0]!;
    for (const l of affordable) if (l.level > best.level) best = l;
    return { type: 'PICK_LOT', lot: best.lot };
  },
  SUBSCRIBE_SHARES: () => ({ type: 'SKIP' }),
  USE_FREE_CARD: (v, d) => (d.options.amount > me(v, d.seat).cash ? { type: 'CONFIRM' } : { type: 'DECLINE' }),
  SCAPEGOAT: (_v, d) => {
    const target = d.options.candidates[0];
    const always = d.options.context === 'frame' || d.options.context === 'sleepwalk';
    return always && target !== undefined ? { type: 'SCAPEGOAT', target } : { type: 'DECLINE' };
  },
  AUCTION_BID: () => ({ type: 'PASS' }),
  BIRTHDAY_PICK: (_v, d) => d.defaultIntent,
  DISCARD_CARD: (_v, d) => {
    let best = d.options.hand[0];
    for (const h of d.options.hand)
      if (best === undefined || cardDef(h.card).price < cardDef(best.card).price) best = h;
    return best === undefined ? d.defaultIntent : { type: 'DISCARD', slot: best.slot };
  },
  DEATH_GOD_TARGET: (_v, d) => d.defaultIntent,
} satisfies AiHandlers);

export const BasicAiPolicy: AiPolicy = Object.freeze({
  id: 'basic' as const,
  decide(view: GameView, d: DecisionForYou, ctx: AiContext): PlayerIntent {
    const h = BASIC_HANDLERS[d.kind] as unknown as AiHandler<DecisionKind>;
    return h(view, d, ctx);
  },
});
