/**
 * 回合菜单里的股票买卖（design/engine.md §11.5；docs/research/r_stocks_time.md §4.3）。
 * - 只能在开市日（非星期日、非休市节日、没有全面停市）、个股未停牌时交易；涨停不能买、跌停不能卖。
 * - 买：股数 ≤ 本回合可买量、≤ 流通股，金额 = trunc(价 × 股数 / 100) ≤ 存款；扣存款（销毁），累计成本（分）。
 * - 卖：股数 ≤ 持股；进存款（铸造）；平均成本不变（累计成本按比例减少）。
 * - 买卖同时增减流通股与可买量；成交后重算董事长。没有手续费。
 */
import type { Ctx } from '../core/ctx';
import { EngineRuleError } from '../errors';
import { addMoney } from '../rules/payment';
import { isLimitDown, isLimitUp, tradeAmount, updateChairman } from '../rules/stock';
import type { SeatIndex } from '../types/ids';

function marketOpenNow(ctx: Ctx): boolean {
  return ctx.s.clock.marketOpen && ctx.s.econ.marketClosedDays === 0;
}

function stockOf(ctx: Ctx, idx: number) {
  const st = ctx.s.stocks[idx];
  if (!st) throw new EngineRuleError('INVALID_TARGET', `stock ${idx}`);
  if (!marketOpenNow(ctx)) throw new EngineRuleError('NOT_USABLE', 'market is closed', { reason: 'marketClosed' });
  if (st.suspend > 0) throw new EngineRuleError('NOT_USABLE', `stock ${idx} is suspended`, { reason: 'suspended' });
  return st;
}

export function buyStock(ctx: Ctx, seat: SeatIndex, idx: number, shares: number): void {
  const st = stockOf(ctx, idx);
  if (isLimitUp(st)) throw new EngineRuleError('NOT_USABLE', `stock ${idx} is limit-up`, { reason: 'limitUp' });
  const p = ctx.player(seat);
  if (!Number.isInteger(shares) || shares < 1) throw new EngineRuleError('OUT_OF_RANGE', `shares ${shares}`);
  const quota = p.quota[idx] ?? 0;
  if (shares > quota || shares > st.float) {
    throw new EngineRuleError('OUT_OF_RANGE', `shares ${shares} > quota ${quota} / float ${st.float}`);
  }
  const amount = tradeAmount(st.priceCents, shares);
  if (amount > p.deposit) throw new EngineRuleError('CANNOT_AFFORD', `deposit ${p.deposit} < ${amount}`);
  const s = ctx.s;
  p.deposit = addMoney(s, p.deposit, -amount);
  s.econ.ledger.burned += amount;
  const h = p.holdings[idx]!;
  p.holdings[idx] = { shares: h.shares + shares, costCents: h.costCents + st.priceCents * shares };
  p.quota[idx] = quota - shares;
  st.float -= shares;
  ctx.emit('STOCK_TRADED', { seat, stock: idx, side: 'buy', shares, priceCents: st.priceCents, amount });
  const ch = updateChairman(s, idx);
  if (ch) ctx.emit('CHAIRMAN_CHANGED', ch);
}

export function sellStock(ctx: Ctx, seat: SeatIndex, idx: number, shares: number): void {
  const st = stockOf(ctx, idx);
  if (isLimitDown(st)) throw new EngineRuleError('NOT_USABLE', `stock ${idx} is limit-down`, { reason: 'limitDown' });
  const p = ctx.player(seat);
  const h = p.holdings[idx]!;
  if (!Number.isInteger(shares) || shares < 1 || shares > h.shares) {
    throw new EngineRuleError('OUT_OF_RANGE', `shares ${shares} not in 1..${h.shares}`);
  }
  const s = ctx.s;
  const amount = tradeAmount(st.priceCents, shares);
  const left = h.shares - shares;
  p.holdings[idx] = { shares: left, costCents: left === 0 ? 0 : Math.trunc((h.costCents * left) / h.shares) };
  p.deposit = addMoney(s, p.deposit, amount);
  s.econ.ledger.minted += amount;
  p.quota[idx] = (p.quota[idx] ?? 0) + shares;
  st.float += shares;
  ctx.emit('STOCK_TRADED', { seat, stock: idx, side: 'sell', shares, priceCents: st.priceCents, amount });
  const ch = updateChairman(s, idx);
  if (ch) ctx.emit('CHAIRMAN_CHANGED', ch);
}
