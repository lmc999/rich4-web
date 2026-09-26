/**
 * 股市（design/engine.md §11.5；docs/research/r_stocks_time.md §4；g_arbitration.md §2.a、§2.f）。价格一律以「分」存整数。
 *
 * 行情（每个开市日一次，exe v3.11 fcn_004291d6）：
 *   G = (rand15 − 16384) / 4097
 *   每支：prev = 当前价；停牌 → rate 0；有利多 / 利空天数 → ±10；
 *         否则 rate = momentum + (rand15 − 16384)/1171 × volatility + G，再做均值回归：
 *           有公司：anchor = 资产额/10000 元，上下界 3.0 / 0.85；无公司：anchor = 初始价，上下界 8.0 / 0.5
 *           prev > 上界 → rate>0 ? rate×0.5 : rate×2；prev < 下界 → rate>0 ? rate×2 : rate×0.5
 *         momentum = clamp(rate, −10, 10)；raw = prev × (100 + momentum) / 100
 *         新价 = clamp(prev + trunc((raw − prev) / tick(raw)) × tick(raw), 1 元, 9999 元)
 *   浮点只做四则运算（momentum 是 state 里唯一的浮点字段）；只有需要 shock 的股票才消耗随机数。
 * 涨停 / 跌停：当日价 ≥ / ≤ 前日价 ±10% 后按档位截断的价格（价格不变不算）。涨停不能买、跌停不能卖。
 * 交易：买入扣存款、卖出进存款，金额 = trunc(价 × 股数 / 100)，没有手续费；同时增减流通股与本回合可买量。
 * 董事长：持股严格最多者；平手保留现任；没有现任时取座位靠前者；没人持股为 null。
 * 纯计算与状态变换：不发事件（调用方先改再 emit）。
 */
import type { StockDef } from '../../data/maps/types';
import { ECON } from '../../data/tables/economy';
import type { EngineMap } from '../core/mapCache';
import type { SeatIndex } from '../types/ids';
import type { GameState, StockState } from '../types/state';
import type { RulePlayer, RuleWorld } from './world';

/** 价格档位（分）：按新价格判断 */
export function tickSize(priceCents: number): number {
  if (priceCents < ECON.STOCK_TICK_BREAK_1) return 1;
  if (priceCents < ECON.STOCK_TICK_BREAK_2) return 5;
  if (priceCents < ECON.STOCK_TICK_BREAK_3) return 10;
  if (priceCents < ECON.STOCK_TICK_BREAK_4) return 50;
  return 100;
}

export function clampPrice(cents: number): number {
  if (cents < ECON.STOCK_PRICE_MIN_CENTS) return ECON.STOCK_PRICE_MIN_CENTS;
  return cents > ECON.STOCK_PRICE_MAX_CENTS ? ECON.STOCK_PRICE_MAX_CENTS : cents;
}

/** 从 prev 按涨跌幅 pct（可为负、可为小数）变动后的价格：差额按新价档位朝零截断，并夹到价格范围 */
export function movePrice(prev: number, pct: number): number {
  const raw = (prev * (100 + pct)) / 100;
  const tick = tickSize(raw);
  return clampPrice(prev + Math.trunc((raw - prev) / tick) * tick);
}

/** 涨停价 / 跌停价（前日价 ±10% 按档位截断） */
export function limitUpPrice(prev: number): number {
  return movePrice(prev, ECON.STOCK_LIMIT_PCT);
}

export function limitDownPrice(prev: number): number {
  return movePrice(prev, -ECON.STOCK_LIMIT_PCT);
}

export function isLimitUp(st: Pick<StockState, 'priceCents' | 'prevCents'>): boolean {
  return st.priceCents > st.prevCents && st.priceCents >= limitUpPrice(st.prevCents);
}

export function isLimitDown(st: Pick<StockState, 'priceCents' | 'prevCents'>): boolean {
  return st.priceCents < st.prevCents && st.priceCents <= limitDownPrice(st.prevCents);
}

/** 成交金额（元）= trunc(价(分) × 股数 / 100) */
export function tradeAmount(priceCents: number, shares: number): number {
  return Math.trunc((priceCents * shares) / 100);
}

/** 均值回归的锚价（分）与上下界系数（×100）；有公司的股票用 资产额/10000 元 */
export function anchorOf(em: EngineMap, idx: number): { anchorCents: number; upX100: number; loX100: number } {
  const def: StockDef | undefined = em.def.stocks[idx];
  const company = em.companies.find((c) => c.stockIndex === idx);
  if (def?.hasCompany && company) {
    return {
      anchorCents: Math.trunc(company.assetValue / ECON.SUBSCRIBE_UNIT_DIV) * 100,
      upX100: ECON.MARKET_COMPANY_UP_X100,
      loX100: ECON.MARKET_COMPANY_LO_X100,
    };
  }
  return {
    anchorCents: def?.initPriceCents ?? 0,
    upX100: ECON.MARKET_PLAIN_UP_X100,
    loX100: ECON.MARKET_PLAIN_LO_X100,
  };
}

function clampMomentum(r: number): number {
  const m = ECON.STOCK_LIMIT_PCT;
  if (r > m) return m;
  return r < -m ? -m : r;
}

/**
 * 跑一次行情（原地修改 s.stocks）。rand15 由调用方接到引擎 RNG（purpose 'market'）。
 * 先取全市场冲击 G，再逐支按需取个股冲击。
 */
export function tickMarket(s: GameState, em: EngineMap, rand15: () => number): void {
  const mid = ECON.MARKET_RAND_MID;
  const g = (rand15() - mid) / ECON.MARKET_G_DIV;
  for (let i = 0; i < s.stocks.length; i++) {
    const st = s.stocks[i]!;
    const prev = st.priceCents;
    st.prevCents = prev;
    st.openCents = prev;
    let rate: number;
    if (st.suspend > 0) rate = 0;
    else if (st.up > 0 || st.down > 0) rate = st.up > 0 ? ECON.STOCK_LIMIT_PCT : -ECON.STOCK_LIMIT_PCT;
    else {
      const shock = (rand15() - mid) / ECON.MARKET_SHOCK_DIV;
      const vol = em.def.stocks[i]?.volatility ?? 1;
      rate = st.momentum + shock * vol + g;
      const a = anchorOf(em, i);
      if (a.anchorCents > 0) {
        if (prev * 100 > a.upX100 * a.anchorCents) rate = rate > 0 ? rate * 0.5 : rate * 2;
        else if (prev * 100 < a.loX100 * a.anchorCents) rate = rate > 0 ? rate * 2 : rate * 0.5;
      }
    }
    st.momentum = clampMomentum(rate);
    st.priceCents = movePrice(prev, st.momentum);
    st.history.push(st.priceCents);
    if (st.history.length > ECON.STOCK_HISTORY_DAYS) st.history.splice(0, st.history.length - ECON.STOCK_HISTORY_DAYS);
  }
}

/** 某支股票在场玩家的持股（按座位升序；0 股的不列） */
export function holdersOf(w: Pick<RuleWorld, 'players'>, idx: number): { seat: SeatIndex; shares: number }[] {
  const out: { seat: SeatIndex; shares: number }[] = [];
  for (const p of w.players) {
    if (!p.alive) continue;
    const n = p.holdings[idx]?.shares ?? 0;
    if (n > 0) out.push({ seat: p.seat, shares: n });
  }
  return out;
}

/** 按持股重算董事长：严格最多者；平手保留现任；没有现任取座位靠前者；没人持股为 null */
export function chairmanFor(players: readonly RulePlayer[], idx: number, current: SeatIndex | null): SeatIndex | null {
  let best = 0;
  for (const p of players) if (p.alive) best = Math.max(best, p.holdings[idx]?.shares ?? 0);
  if (best === 0) return null;
  if (current !== null) {
    const cur = players.find((p) => p.seat === current);
    if (cur?.alive && (cur.holdings[idx]?.shares ?? 0) === best) return current;
  }
  for (const p of players) if (p.alive && (p.holdings[idx]?.shares ?? 0) === best) return p.seat;
  return null;
}

/** 重算并写回董事长；有变化时返回 {from, to}（调用方 emit CHAIRMAN_CHANGED） */
export function updateChairman(
  s: GameState,
  idx: number,
): { stock: number; from: SeatIndex | null; to: SeatIndex | null } | null {
  const st = s.stocks[idx]!;
  const to = chairmanFor(s.players, idx, st.chairman);
  if (to === st.chairman) return null;
  const from = st.chairman;
  st.chairman = to;
  return { stock: idx, from, to };
}

/** 本回合对某支股票的最大可买 / 可卖量（不可交易时为 0） */
export function maxBuyShares(w: RuleWorld, seat: SeatIndex, idx: number, open: boolean): number {
  const st = w.stocks[idx]!;
  if (!open || st.suspend > 0 || isLimitUp(st) || st.priceCents <= 0) return 0;
  const p = w.players.find((x) => x.seat === seat);
  if (!p) return 0;
  const quota = p.quota[idx] ?? 0;
  const byMoney = p.deposit > 0 ? Math.trunc((p.deposit * 100) / st.priceCents) : 0;
  return Math.max(0, Math.min(quota, st.float, byMoney));
}

export function maxSellShares(w: RuleWorld, seat: SeatIndex, idx: number, open: boolean): number {
  const st = w.stocks[idx]!;
  if (!open || st.suspend > 0 || isLimitDown(st)) return 0;
  const p = w.players.find((x) => x.seat === seat);
  return p ? (p.holdings[idx]?.shares ?? 0) : 0;
}

/** 股票是否有实体公司（有公司的股票股本守恒含公司保留股） */
export function companyOfStock(s: Pick<GameState, 'companies'>, idx: number): number {
  return s.companies.findIndex((c) => c.stock === idx);
}
