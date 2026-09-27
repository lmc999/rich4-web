/**
 * 落点码 3：命运格（design/engine.md §8、§10.7）。停下才触发；梦游中跳过（squares/index.ts）。
 * 游标取下一张（按座驾替换）可行的命运并压 FATE 帧（effects/fate）。
 */
import { drawFate } from '../effects/fate/index';
import type { SquareHandler } from './index';

export const fateSquare: SquareHandler = (ctx, sq) => {
  drawFate(ctx, sq.seat);
};
