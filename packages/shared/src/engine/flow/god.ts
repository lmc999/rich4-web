/**
 * GOD 帧：神明附身（design/engine.md §6.1、§10.5；docs/research/r_deities.md §3–§4）。
 * 来源：停在路上的神明上（LAND 'object' 阶段）、请神符（卡 23）。
 *
 * displace  身上已有神明 → 无条件先送走（GOD_LEFT{displaced}），它的搭档在远处刷出；cursor 记下被挤走的种类
 * attach    附身（7 天，死神 13 天），三项运势加上去 → GOD_ATTACHED{displaced}
 * power     立即发威（effects/gods GOD_EFFECTS[kind].power；可能让别人或自己破产，BANKRUPT 帧随后处理）
 * done      出栈
 * 附身者在发威前出局（不会发生）或神已被别人附身（同一 action 内不可能）时直接出栈。
 */
import type { FrameHandler } from '../core/frameHandler';
import { godEffect } from '../effects/gods/index';
import { attachedSlot, attachGod, leaveGod } from '../effects/gods/lifecycle';
import type { FrameOf } from '../types/frames';
import type { GodKind } from '../types/ids';

type GodFrame = FrameOf<'GOD'>;

export const GOD: FrameHandler<GodFrame> = {
  step(ctx, f) {
    const slot = ctx.s.gods.find((g) => g.slot === f.slot);
    switch (f.stage) {
      case 'displace': {
        f.stage = 'attach';
        if (slot?.where.t !== 'road') {
          f.stage = 'done';
          return;
        }
        const old = attachedSlot(ctx.s, f.seat);
        if (old !== null) {
          f.cursor = old.kind;
          leaveGod(ctx, old, 'displaced');
        }
        return;
      }
      case 'attach':
        f.stage = 'power';
        if (slot?.where.t !== 'road') {
          f.stage = 'done';
          return;
        }
        attachGod(ctx, f.seat, slot, f.cursor > 0 ? (f.cursor as GodKind) : null);
        return;
      case 'power': {
        f.stage = 'done';
        if (!slot) return;
        const power = godEffect(slot.kind).power;
        if (power) power(ctx, f.seat);
        return;
      }
      case 'done':
        ctx.pop(f);
        return;
    }
  },
};
