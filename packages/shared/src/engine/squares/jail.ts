/**
 * 落点码 4 / 5：监狱、医院的保释格（design/engine.md §8；docs/research/g_villains.md §1）。停下不会被关。
 * 建筑内关着别的玩家（坐牢 / 住院计数 ≠ 0 且不是已待释放的 0x80）且自己点券 ≥ 30 → BAIL 决策：
 *   BAIL{seat}  花 30 点券保释该玩家：他的计数改为 0x80（待释放），下一个自己的回合开头释放、走回棋盘（不掷骰）
 *   HIRE{villain}  雇恶人（300 点券）属于 M7：本期 options 里的恶人一律 available=false，提交 HIRE 会被拒绝
 *   SKIP
 * 恶人没有刑期，关在里面的恶人都列出来（供前端展示）。
 */
import { ECON } from '../../data/tables/economy';
import type { Ctx } from '../core/ctx';
import { EngineRuleError } from '../errors';
import { COUNTER_PENDING, displayRemaining } from '../rules/counters';
import type { BailOptions } from '../types/decision';
import type { SeatIndex } from '../types/ids';
import type { GameState } from '../types/state';
import type { SquareHandler } from './index';

export function buildBail(s: GameState, seat: SeatIndex, where: 'jail' | 'hospital'): BailOptions | null {
  const p = s.players.find((x) => x.seat === seat);
  if (!p) return null;
  const inmates = s.players
    .filter((q) => q.alive && q.seat !== seat && q.st[where] !== 0 && q.st[where] !== COUNTER_PENDING)
    .map((q) => ({ seat: q.seat, remaining: displayRemaining(q.st[where]) }));
  const villains = s.villains
    .filter((v) => !v.onBoard && v.home === where)
    .map((v) => ({ kind: v.kind, available: false }));
  if (inmates.length === 0 || p.points < ECON.BAIL_POINTS) return null;
  return { where, points: p.points, inmates, villains, costs: { bail: ECON.BAIL_POINTS, hire: ECON.HIRE_POINTS } };
}

export const jailSquare: SquareHandler = (ctx, sq) => {
  const where = sq.tile.kind === 'hospital' ? 'hospital' : 'jail';
  if (buildBail(ctx.s, sq.seat, where) === null) return;
  ctx.push({ k: 'ASK', seat: sq.seat, kind: 'BAIL', data: { where }, stage: 'ask' });
};

/** BAIL{seat}：付 30 点券，目标的计数改为 0x80（下一个自己的回合开头释放） */
export function bailOut(ctx: Ctx, by: SeatIndex, where: 'jail' | 'hospital', seat: SeatIndex): void {
  const o = buildBail(ctx.s, by, where);
  if (!o?.inmates.some((i) => i.seat === seat)) {
    throw new EngineRuleError('INVALID_TARGET', `seat ${seat} cannot be bailed out here`);
  }
  const p = ctx.player(by);
  p.points -= ECON.BAIL_POINTS;
  ctx.player(seat).st[where] = COUNTER_PENDING;
  ctx.emit('BAIL', { by, seat, cost: ECON.BAIL_POINTS });
}
