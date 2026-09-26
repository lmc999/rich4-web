/**
 * 原版 AI 的股票买卖（design/minigames-ai.md §9.4 stockBuy / stockSell；@0x42bf03..0x42d0ee）。
 * 只用公开数据（行情、盈余、持股、可成交量）；随机数一律用 ctx.turnRng('<步骤名>')，同一回合重复调用结果稳定。
 *
 * 卖出打分表在原版里另有两张（有企业 / 无企业），remake 只解出了部分地址，这里按调研给出的方向做了简化 ⚑：
 *   无企业：现价 ≥ 平均成本 × 1.5 → +2；avg6 < avg24 → +1；现价 > 初始价 × 2.5 → +2
 *   有企业：现价 > 资产价 × 2 → +2；累计盈余 < 0 → +1；自己是董事长时不卖（除非有还款压力）
 *   有还款压力：分数 ×2，0 分的也给 1 分（只要能卖）
 */
import type { StockRow, TurnMenuOptions } from '../engine/types/index';
import {
  STOCK_BUY_GATE,
  STOCK_BUY_LOAN_DAYS,
  STOCK_COMPANY_MIN_DEPOSIT,
  STOCK_PLAIN_MIN_DEPOSIT,
  STOCK_PRESSURE_DAYS,
  STOCK_RANK_BASE,
  STOCK_RANK_MOD,
  STOCK_SELL_GATE,
  STOCK_SURPLUS_HIGH,
  STOCK_SURPLUS_LOW,
} from './constants';
import type { AiContext } from './types';
import type { AiView } from './view';

/** 最近 n 个非 0 收盘价的均值（不足 n 个取全部；没有返回 0） */
export function recentAverage(history: readonly number[], n: number): number {
  let sum = 0;
  let k = 0;
  for (let i = history.length - 1; i >= 0 && k < n; i--) {
    const v = history[i]!;
    if (v <= 0) continue;
    sum += v;
    k++;
  }
  return k === 0 ? 0 : sum / k;
}

/** 是否有还款压力：到期 ≤ 6 天且 现金 + 存款 < 贷款 */
export function repayPressure(v: AiView): boolean {
  const me = v.me;
  if (me.loan <= 0) return false;
  const left = v.daysUntil(me.loanDue);
  return left !== null && left <= STOCK_PRESSURE_DAYS && me.cash + me.deposit < me.loan;
}

/** 买入打分（0 表示不考虑） */
export function buyScore(v: AiView, row: StockRow): number {
  if (row.suspended || row.limitUp || row.quota <= 0 || row.maxBuy <= 0) return 0;
  const me = v.me;
  const pi = v.pi;
  const st = v.view.stocks[row.idx];
  if (!st) return 0;
  const company = v.companyOfStock(row.idx);
  const price = row.priceCents;
  if (company === null) {
    if (me.deposit <= STOCK_PLAIN_MIN_DEPOSIT * pi) return 0;
    const def = v.map.def.stocks[row.idx];
    const ref = def?.initPriceCents ?? price;
    const vol = def?.volatility ?? 0;
    const avg6 = recentAverage(st.history, 6);
    const avg24 = recentAverage(st.history, 24);
    let s = 0;
    if (price < ref * 2.5 && vol > 2.0 && avg6 > avg24) s += 2;
    if (price < ref * 0.6 && avg6 > avg24) s += 4;
    if (avg6 < avg24 * 0.5) s += 2;
    return s;
  }
  if (me.deposit <= STOCK_COMPANY_MIN_DEPOSIT * pi) return 0;
  const cs = v.view.companies.find((c) => c.stock === row.idx);
  const monthly = cs ? Math.trunc(cs.surplusTotal / v.totalMonths) : 0;
  const assetCents = Math.trunc(company.assetValue / 10000) * 100;
  let s = 0;
  if (monthly > 0 && monthly < STOCK_SURPLUS_LOW * pi) s += 1;
  else if (monthly >= STOCK_SURPLUS_LOW * pi && monthly < STOCK_SURPLUS_HIGH * pi) s += 2;
  else if (monthly >= STOCK_SURPLUS_HIGH * pi) s += 3;
  const mine = row.shares;
  if (cs && cs.surplusTotal > 0 && mine < 5000 && price * 10 <= assetCents * 12) {
    s += 1;
    const ch = row.chairman;
    if (ch !== null && ch !== v.seat) {
      const chShares = v.player(ch).holdings[row.idx]?.shares ?? 0;
      if (row.float + mine + cs.reserved > chShares) s += 1;
      if (mine + row.quota > chShares) s += 2;
    }
  }
  if (price * 100 < assetCents * 70) s += 5;
  else if (price * 100 < assetCents * 85) s += 3;
  return s;
}

/** 卖出打分（0 表示不卖） */
export function sellScore(v: AiView, row: StockRow, pressure: boolean): number {
  if (row.maxSell <= 0) return 0;
  const st = v.view.stocks[row.idx];
  if (!st) return 0;
  const company = v.companyOfStock(row.idx);
  const price = row.priceCents;
  let s = 0;
  if (company === null) {
    const avgCost = row.shares > 0 ? row.costCents / row.shares : price;
    const ref = v.map.def.stocks[row.idx]?.initPriceCents ?? price;
    if (price * 2 >= avgCost * 3) s += 2;
    if (recentAverage(st.history, 6) < recentAverage(st.history, 24)) s += 1;
    if (price * 2 > ref * 5) s += 2;
  } else {
    if (row.chairman === v.seat && !pressure) return 0;
    const assetCents = Math.trunc(company.assetValue / 10000) * 100;
    if (price > assetCents * 2) s += 2;
    const cs = v.view.companies.find((c) => c.stock === row.idx);
    if (cs && cs.surplusTotal < 0) s += 1;
  }
  if (pressure) s = s > 0 ? s * 2 : 1;
  return s;
}

/** stockBuy 步骤：返回要买的 {stock, shares}，不买返回 null */
export function planStockBuy(v: AiView, o: TurnMenuOptions, ctx: AiContext): { stock: number; shares: number } | null {
  if (ctx.turnRng('buyGate').mod(STOCK_BUY_GATE) !== 0) return null;
  if (ctx.traits.stockRatio <= 0 || !o.stock.open) return null;
  const me = v.me;
  if (me.loan > 0) {
    const left = v.daysUntil(me.loanDue);
    if (left !== null && left < STOCK_BUY_LOAN_DAYS) return null;
  }
  const hv = v.holdingsValue();
  const budget = Math.min(me.deposit, Math.trunc(((hv + me.cash + me.deposit) * ctx.traits.stockRatio) / 100) - hv);
  if (budget <= 0) return null;
  const scored = o.stock.rows.map((row) => ({ row, score: buyScore(v, row) }));
  // 原版 qsort 不稳定；这里按分数降序的稳定排序（有意偏差 DEV-03）
  const order = scored
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i));
  const r = ctx.turnRng('rank');
  for (let rank = 0; rank < order.length; rank++) {
    const x = order[rank]!;
    if (x.score === 0) continue;
    if (r.mod(STOCK_RANK_MOD) > STOCK_RANK_BASE - rank) continue;
    const shares = Math.min(Math.trunc((budget * 100) / x.row.priceCents), x.row.maxBuy);
    return shares > 0 ? { stock: x.row.idx, shares } : null;
  }
  return null;
}

/** stockSell 步骤：返回要卖的 {stock, shares}（整支卖光），不卖返回 null */
export function planStockSell(v: AiView, o: TurnMenuOptions, ctx: AiContext): { stock: number; shares: number } | null {
  const pressure = repayPressure(v);
  if (!pressure && ctx.turnRng('sellGate').mod(STOCK_SELL_GATE) !== 0) return null;
  if (!o.stock.open) return null;
  let best: { row: StockRow; score: number } | null = null;
  for (const row of o.stock.rows) {
    const score = sellScore(v, row, pressure);
    if (score > 0 && (best === null || score > best.score)) best = { row, score };
  }
  return best ? { stock: best.row.idx, shares: best.row.maxSell } : null;
}
