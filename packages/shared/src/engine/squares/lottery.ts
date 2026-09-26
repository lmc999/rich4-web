/**
 * 落点码 9：乐透（design/engine.md §8、§11.4；docs/research/r_squares_events.md §4）。
 * 现金 ≥ 1000 且有未售号码 → LOTTERY 决策；每次停留只能买 1 注，1000 元不乘 PI，只用现金，票款进公库。
 * 15 日开奖（flow/day.ts）：无人购票不开奖；有人持号 > 10 个只在已售号码里开，否则在 36 个里开；
 * 中奖者独得公库（进现金），号码清空；无人中奖则公库与号码原样保留。
 */
import { ECON } from '../../data/tables/economy';
import type { Ctx } from '../core/ctx';
import { EngineRuleError } from '../errors';
import type { SeatIndex } from '../types/ids';
import type { SquareHandler } from './index';

export const lotterySquare: SquareHandler = (ctx, sq) => {
  ctx.push({ k: 'ASK', seat: sq.seat, kind: 'LOTTERY', data: {}, stage: 'ask' });
};

/** LOTTERY_BUY{number}（number 为 0..35） */
export function buyTicket(ctx: Ctx, seat: SeatIndex, n: number): void {
  const owners = ctx.s.lottery.owners;
  if (!Number.isInteger(n) || n < 0 || n >= owners.length) throw new EngineRuleError('OUT_OF_RANGE', `number ${n}`);
  if (owners[n] !== null) throw new EngineRuleError('NOT_ALLOWED', `number ${n + 1} is sold`);
  const p = ctx.player(seat);
  if (p.cash < ECON.LOTTERY_TICKET) throw new EngineRuleError('CANNOT_AFFORD', `cash ${p.cash}`);
  ctx.pay({ t: 'seat', seat }, { t: 'pool' }, ECON.LOTTERY_TICKET, {
    reason: 'lotteryTicket',
    cause: { k: 'system', ref: 'lottery', by: seat },
  });
  owners[n] = seat;
  ctx.emit('LOTTERY_TICKET', { seat, number: n });
}
