/**
 * 落点码 10 / 11 / 12：得 50 / 30 / 10 点券（design/engine.md §8）。点券按 uint16，溢出由 intOverflow 控制（DEV-01）。
 */
import { ECON } from '../../data/tables/economy';
import { addU16 } from '../../util/int32';
import type { SquareHandler } from './index';

const POINTS: Readonly<Record<string, number>> = {
  points50: ECON.POINTS_SQUARE_50,
  points30: ECON.POINTS_SQUARE_30,
  points10: ECON.POINTS_SQUARE_10,
};

export const pointsSquare: SquareHandler = (ctx, sq) => {
  const amount = POINTS[sq.tile.kind] ?? 0;
  if (amount <= 0) return;
  const p = ctx.player(sq.seat);
  p.points = addU16(p.points, amount, ctx.s.config.rules.intOverflow);
  ctx.emit('POINTS_GAINED', { seat: sq.seat, amount, source: 'square' });
};
