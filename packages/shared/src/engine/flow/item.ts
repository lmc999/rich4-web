/**
 * ITEM 帧（design/engine.md §6.1）：13 种道具都在 USE_ITEM 时立即结算（effects/items），目前没有需要跨决策的道具链；
 * 保留帧类型供以后的多步道具（例如 M7 的时光机）使用，被压入时直接出栈。
 */
import type { FrameHandler } from '../core/frameHandler';
import type { FrameOf } from '../types/frames';

export const ITEM: FrameHandler<FrameOf<'ITEM'>> = {
  step(ctx, f) {
    ctx.pop(f);
  },
};
