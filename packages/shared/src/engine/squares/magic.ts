/**
 * 落点码 16：魔法屋（design/engine.md §8、§10.8）。停下才触发；梦游中跳过（squares/index.ts）。
 * 压 MAGIC 帧（effects/magic）：抽条件 → MAGIC_CAST → 对名单逐人执行。
 */
import { pushMagic } from '../effects/magic/index';
import type { SquareHandler } from './index';

export const magicSquare: SquareHandler = (ctx, sq) => {
  pushMagic(ctx, sq.seat);
};
