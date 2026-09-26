/**
 * 落点码 14：银行，停下 → BANK(stop)：先 ATM 再柜台（design/engine.md §8；路过由 MOVE 帧压 BANK(pass)）。
 */
import type { SquareHandler } from './index';

export const bankSquare: SquareHandler = (ctx, sq) => {
  ctx.push({ k: 'BANK', seat: sq.seat, mode: 'stop', stage: 'atm' });
};
