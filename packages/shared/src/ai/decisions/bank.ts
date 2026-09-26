/**
 * 银行（design/minigames-ai.md §9.7）：
 * - BANK_ATM（路过或停下）：按比例重新分配现金（@0x437acd..0x437bca）：t = cashRatio/100；当月 1–7 日 ×1.5，
 *   26 日及以后 ×0.5；t ≥ 1 取 0.9，t ≤ 0 取 0.1。|现金/(现金+存款) − t| ≥ 0.25 或现金为 0 时，把现金调成 trunc(总额 × t)
 *   （单精度语义用 Math.fround 复现）。挤兑期间不能取就只存不取。
 * - BANK_COUNTER：2 × 贷款 < 存款，或（到期 ≤ 6 天且现金 + 存款 ≥ 1.1 × 贷款）→ 全额还清；否则无贷款、loanRatio > 0、
 *   未冻结放款，且（rng%10 == 0 或 现金 + 存款 < 30000）→ 借 min(trunc(身家 × loanRatio / 100), 额度)。
 *   AI 不使用特別融資（DEV-11）。
 */
import type { PlayerIntent } from '../../engine/types/index';
import type { DecisionForYou } from '../../view/types';
import {
  ATM_BAND,
  ATM_EARLY_LAST_DAY,
  ATM_LATE_FIRST_DAY,
  LOAN_CASH_FLOOR,
  LOAN_RNG_MOD,
  REPAY_DAYS,
} from '../constants';
import type { AiContext } from '../types';
import type { AiView } from '../view';

/** 本月这一天的目标现金比例 t（单精度） */
export function atmTargetRatio(cashRatio: number, dayOfMonth: number): number {
  let t = Math.fround(cashRatio / 100);
  if (dayOfMonth <= ATM_EARLY_LAST_DAY) t = Math.fround(t * 1.5);
  else if (dayOfMonth >= ATM_LATE_FIRST_DAY) t = Math.fround(t * 0.5);
  if (t >= 1) return Math.fround(0.9);
  if (t <= 0) return Math.fround(0.1);
  return t;
}

export function atm(v: AiView, d: DecisionForYou<'BANK_ATM'>, ctx: AiContext): PlayerIntent {
  const o = d.options;
  const total = o.cash + o.deposit;
  if (total <= 0) return { type: 'SKIP' };
  const t = atmTargetRatio(ctx.traits.cashRatio, v.dayOfMonth);
  const ratio = Math.fround(Math.fround(o.cash) / Math.fround(total));
  const off = ratio > t ? ratio - t : t - ratio;
  if (!(off >= ATM_BAND || o.cash === 0)) return { type: 'SKIP' };
  const target = Math.trunc(Math.fround(Math.fround(total) * t));
  const diff = target - o.cash;
  if (diff > 0) {
    if (!o.canWithdraw) return { type: 'SKIP' };
    const amount = Math.min(diff, o.deposit);
    return amount > 0 ? { type: 'ATM', op: 'withdraw', amount } : { type: 'SKIP' };
  }
  if (diff < 0) {
    const amount = Math.min(-diff, o.cash);
    return amount > 0 ? { type: 'ATM', op: 'deposit', amount } : { type: 'SKIP' };
  }
  return { type: 'SKIP' };
}

export function bankCounter(v: AiView, d: DecisionForYou<'BANK_COUNTER'>, ctx: AiContext): PlayerIntent {
  const o = d.options;
  if (o.loan > 0 && o.repayMax > 0) {
    const left = v.daysUntil(o.loanDue);
    const liquid = o.cash + o.deposit;
    if (2 * o.loan < o.deposit || (left !== null && left <= REPAY_DAYS && liquid * 10 >= o.loan * 11)) {
      return { type: 'REPAY', amount: Math.min(o.loan, o.repayMax) };
    }
  }
  const loanRatio = ctx.traits.loanRatio;
  if (o.loan === 0 && loanRatio > 0 && o.loanBlocked === null && o.loanLimit > 0) {
    if (ctx.rng.mod(LOAN_RNG_MOD) === 0 || o.cash + o.deposit < LOAN_CASH_FLOOR) {
      const amount = Math.min(Math.trunc((v.netWorth() * loanRatio) / 100), o.loanLimit);
      if (amount > 0) return { type: 'LOAN', amount };
    }
  }
  return { type: 'SKIP' };
}
