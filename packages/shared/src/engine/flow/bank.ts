/**
 * BANK 帧（design/engine.md §7.5、§8 kind 14、§11.3；规则见 rules/bank.ts）。
 *
 * atm      拒绝往来 → BANK_REJECTED{reason:'rejected'}；sundayBankClosed 且星期日 → BANK_REJECTED{reason:'sunday'}；
 *          否则有可存或可取时发 BANK_ATM（路过与停下都有）
 * counter  只有停下（mode='stop'）才到柜台：贷款 / 还款 / 特别融资三选一，各一笔
 * done     出栈（路过时回到 MOVE 继续走）
 */
import { add32 } from '../../util/int32';
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { buildBankAtm, buildBankCounter } from '../decisions/economy';
import { EngineRuleError } from '../errors';
import { newLoanDue, reserveShortfall } from '../rules/bank';
import { displayRemaining } from '../rules/counters';
import { addMoney } from '../rules/payment';
import type { FrameOf } from '../types/frames';
import type { PlayerAction } from '../types/intent';

type BankFrame = FrameOf<'BANK'>;

function atm(ctx: Ctx, f: BankFrame, a: PlayerAction): void {
  if (a.type === 'SKIP') return;
  if (a.type !== 'ATM') throw new EngineRuleError('INTENT_NOT_ALLOWED', a.type);
  const s = ctx.s;
  const p = ctx.player(f.seat);
  const amount = a.amount;
  if (!Number.isInteger(amount) || amount < 1) throw new EngineRuleError('OUT_OF_RANGE', `amount ${amount}`);
  if (a.op === 'deposit') {
    if (amount > p.cash) throw new EngineRuleError('CANNOT_AFFORD', `cash ${p.cash} < ${amount}`);
    p.cash = addMoney(s, p.cash, -amount);
    p.deposit = addMoney(s, p.deposit, amount);
    ctx.emit('ATM', { seat: f.seat, op: 'deposit', amount });
    return;
  }
  if (s.econ.bankRunDays > 0) throw new EngineRuleError('NOT_ALLOWED', 'bank run: deposits only');
  if (amount > p.deposit) throw new EngineRuleError('CANNOT_AFFORD', `deposit ${p.deposit} < ${amount}`);
  p.deposit = addMoney(s, p.deposit, -amount);
  p.cash = addMoney(s, p.cash, amount);
  ctx.emit('ATM', { seat: f.seat, op: 'withdraw', amount });
  const gap = reserveShortfall(s, ctx.map, f.seat);
  if (gap === null) return;
  const chairman = ctx.player(gap.chairman);
  const r = ctx.pay({ t: 'seat', seat: gap.chairman }, { t: 'bank' }, gap.amount, {
    order: 'depositFirst',
    reason: 'reserveShortfall',
    cause: { k: 'system', ref: 'reserveShortfall', by: f.seat },
  });
  chairman.finance = Math.max(0, chairman.finance - gap.amount);
  ctx.emit('RESERVE_SHORTFALL', { chairman: gap.chairman, amount: r.paid });
}

function counter(ctx: Ctx, f: BankFrame, a: PlayerAction): void {
  if (a.type === 'SKIP') return;
  const s = ctx.s;
  const p = ctx.player(f.seat);
  const o = buildBankCounter(s, ctx.map, f.seat);
  if (o === null) throw new EngineRuleError('NOT_ALLOWED', 'nothing to do at the counter');
  switch (a.type) {
    case 'LOAN': {
      if (o.loanBlocked !== null) throw new EngineRuleError('NOT_ALLOWED', `loan blocked: ${o.loanBlocked}`);
      if (!Number.isInteger(a.amount) || a.amount < 1 || a.amount > o.loanLimit) {
        throw new EngineRuleError('OUT_OF_RANGE', `loan ${a.amount} not in 1..${o.loanLimit}`);
      }
      if (p.loan === 0 || p.loanDue === 0) p.loanDue = newLoanDue(s, ctx.map);
      p.loan = add32(p.loan, a.amount, s.config.rules.intOverflow);
      ctx.mint(f.seat, a.amount, 'deposit');
      ctx.emit('LOAN', { seat: f.seat, amount: a.amount, due: p.loanDue });
      return;
    }
    case 'REPAY': {
      if (!Number.isInteger(a.amount) || a.amount < 1 || a.amount > o.repayMax) {
        throw new EngineRuleError('OUT_OF_RANGE', `repay ${a.amount} not in 1..${o.repayMax}`);
      }
      ctx.pay({ t: 'seat', seat: f.seat }, { t: 'bank' }, a.amount, {
        order: 'depositFirst',
        reason: 'repay',
        cause: { k: 'loan', ref: null, by: null },
      });
      p.loan -= a.amount;
      if (p.loan <= 0) {
        p.loan = 0;
        p.loanDue = 0;
      }
      ctx.emit('REPAY', { seat: f.seat, amount: a.amount });
      return;
    }
    case 'FINANCE': {
      const limit = o.financeLimit ?? 0;
      if (!Number.isInteger(a.amount) || a.amount < 1 || a.amount > limit) {
        throw new EngineRuleError('OUT_OF_RANGE', `finance ${a.amount} not in 1..${limit}`);
      }
      p.finance += a.amount;
      ctx.mint(f.seat, a.amount, 'deposit');
      ctx.emit('FINANCE', { seat: f.seat, amount: a.amount });
      return;
    }
    default:
      throw new EngineRuleError('INTENT_NOT_ALLOWED', a.type);
  }
}

export const BANK: FrameHandler<BankFrame> = {
  step(ctx, f) {
    const s = ctx.s;
    switch (f.stage) {
      case 'atm': {
        const p = ctx.player(f.seat);
        if (p.bankReject !== 0) {
          f.stage = 'done';
          ctx.emit('BANK_REJECTED', { seat: f.seat, days: displayRemaining(p.bankReject), reason: 'rejected' });
          return;
        }
        if (s.config.rules.sundayBankClosed && s.clock.weekday === 0) {
          f.stage = 'done';
          ctx.emit('BANK_REJECTED', { seat: f.seat, days: 0, reason: 'sunday' });
          return;
        }
        f.stage = f.mode === 'stop' ? 'counter' : 'done';
        const o = buildBankAtm(s, ctx.map, f.seat, f.mode);
        if (o !== null) ctx.ask(f, f.seat, 'BANK_ATM', o, { type: 'SKIP' });
        return;
      }
      case 'counter': {
        f.stage = 'done';
        const o = buildBankCounter(s, ctx.map, f.seat);
        if (o !== null) ctx.ask(f, f.seat, 'BANK_COUNTER', o, { type: 'SKIP' });
        return;
      }
      case 'done':
        ctx.pop(f);
        return;
    }
  },
  resume(ctx, f, a, d) {
    if (d.kind === 'BANK_ATM') atm(ctx, f, a);
    else counter(ctx, f, a);
  },
};
