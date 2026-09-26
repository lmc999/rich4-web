/**
 * ROOT 帧：座位轮转 → 恶人段 → 日推进（design/engine.md §7.1；docs/research/g_arbitration.md §3.1）。
 * 原版游标回到 0 号座位时推进一天：不论 0 号是否在场，每轮都日推进一次。ROOT 永不出栈。
 */
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import type { FrameOf } from '../types/frames';

export const ROOT: FrameHandler<FrameOf<'ROOT'>> = {
  step(ctx: Ctx, f) {
    const s = ctx.s;
    switch (f.stage) {
      case 'seat': {
        const next = s.players.find((p) => p.alive && p.seat >= f.nextSeatFrom);
        if (next) {
          f.nextSeatFrom = next.seat + 1;
          ctx.push({ k: 'TURN', seat: next.seat, stage: 'start' });
          return;
        }
        f.stage = 'villains';
        f.villainIdx = 0;
        return;
      }
      case 'villains': {
        // 在场且有雇主的恶人按 [thief, robber, thug, spy] 依次走一次（M7：VILLAIN 帧）
        while (f.villainIdx < s.villains.length) {
          const idx = f.villainIdx;
          f.villainIdx += 1;
          const v = s.villains[idx]!;
          if (v.onBoard && v.employer !== null) {
            s.clock.cursor = { t: 'villain', idx: idx as 0 | 1 | 2 | 3 };
            ctx.push({ k: 'VILLAIN', v: v.kind, stage: 'start' });
            return;
          }
        }
        f.stage = 'day';
        return;
      }
      case 'day': {
        // DAY 帧完成后回到 'seat'，从 0 号座位开始新的一天
        s.clock.cursor = { t: 'day' };
        f.stage = 'seat';
        f.nextSeatFrom = 0;
        ctx.push({ k: 'DAY', stage: 'date', cursor: 0 });
        return;
      }
    }
  },
};
