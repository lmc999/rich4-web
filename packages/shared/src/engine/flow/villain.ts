/**
 * VILLAIN 帧：四大恶人的回合（design/engine.md §7.8；docs/research/g_villains.md §2）。
 * 轮次：玩家 0..N-1 → 恶人 小偷、强盗、流氓、间谍（在棋盘上、有雇主的才行动；ROOT 'villains'）→ 日推进。
 *
 * start  回合数 +1；计时器两段式倒数（带 0x80 的清 0，非 0 的 −1，减到 0 写 0x80，本回合仍算生效）→ TURN_STARTED；
 *        冬眠或停留 ≠ 0 → 本回合不动；否则步数 = 乌龟 ≠ 0 ? 1 : rand15()%9 + 2（不掷骰子），压 MOVE(mode 'villain')
 * done   TURN_ENDED → 出栈
 */
import { ECON } from '../../data/tables/economy';
import type { FrameHandler } from '../core/frameHandler';
import { villainOf } from '../effects/villains/index';
import { tick2 } from '../rules/counters';
import type { FrameOf } from '../types/frames';

type VillainFrame = FrameOf<'VILLAIN'>;

export const VILLAIN: FrameHandler<VillainFrame> = {
  step(ctx, f) {
    const s = ctx.s;
    const actor = { t: 'villain', kind: f.v } as const;
    switch (f.stage) {
      case 'start': {
        const v = villainOf(s, f.v);
        if (!v.onBoard || v.employer === null) {
          ctx.pop(f);
          return;
        }
        f.stage = 'done';
        s.clock.turnNo += 1;
        v.st.hibernate = tick2(v.st.hibernate).next;
        v.st.sleepwalk = tick2(v.st.sleepwalk).next;
        v.st.stay = tick2(v.st.stay).next;
        v.st.tortoise = tick2(v.st.tortoise).next;
        ctx.emit('TURN_STARTED', { actor, turnNo: s.clock.turnNo });
        if (v.st.hibernate !== 0 || v.st.stay !== 0) return;
        const steps =
          v.st.tortoise !== 0 ? 1 : ctx.pick('villainSteps', ECON.VILLAIN_STEPS_RANGE) + ECON.VILLAIN_STEPS_MIN;
        ctx.push({ k: 'MOVE', actor, remaining: steps, total: steps, seg: [], mode: 'villain', bankPassed: false });
        return;
      }
      case 'moving':
      case 'act':
        f.stage = 'done';
        return;
      case 'done':
        ctx.emit('TURN_ENDED', { actor });
        ctx.pop(f);
        return;
    }
  },
};
