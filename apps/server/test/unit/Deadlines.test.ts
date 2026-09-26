import { describe, expect, it } from 'vitest';
import {
  computeDeadline,
  DEFAULT_TIMING,
  effectiveDeadline,
  fireAt,
  minigameWindow,
  releaseDeadline,
  resumeDeadline,
  type TimingOptions,
} from '../../src/game/Deadlines';

const T: TimingOptions = DEFAULT_TIMING;
const now = 1_000_000;

describe('Deadlines', () => {
  it('deadline = now + animMs + 超时 × 档位', () => {
    const base = { now, animMs: 1500, budget: null, chained: false } as const;
    expect(computeDeadline({ ...base, timing: 'menu', preset: 'normal' }, T).deadlineAt).toBe(now + 1500 + 30_000);
    expect(computeDeadline({ ...base, timing: 'confirm', preset: 'fast' }, T).deadlineAt).toBe(now + 1500 + 7500);
    expect(computeDeadline({ ...base, timing: 'auction', preset: 'slow' }, T).deadlineAt).toBe(now + 1500 + 30_000);
    expect(computeDeadline({ ...base, timing: 'pick', preset: 'off' }, T)).toEqual({ deadlineAt: null, budget: null });
  });

  it('animScale 与 maxAnimMs；timerScale 缩短超时', () => {
    const i = { now, animMs: 100_000, timing: 'menu', preset: 'normal', budget: null, chained: false } as const;
    expect(computeDeadline(i, T).deadlineAt).toBe(now + 60_000 + 30_000);
    expect(computeDeadline(i, { ...T, animScale: 0 }).deadlineAt).toBe(now + 30_000);
    expect(computeDeadline(i, { ...T, animScale: 0, timerScale: 0.1 }).deadlineAt).toBe(now + 3000);
  });

  it('TURN_MENU 链：继承、至少 8 秒、上限首次可见 + 90 秒（随档位缩放）', () => {
    const first = computeDeadline(
      { now, animMs: 1000, timing: 'menu', preset: 'normal', budget: null, chained: true },
      T,
    );
    expect(first.budget).toEqual({ firstVisibleAt: now + 1000, lastDeadline: now + 31_000 });
    const inherit = computeDeadline(
      { now: now + 5000, animMs: 400, timing: 'menu', preset: 'normal', budget: first.budget, chained: true },
      T,
    );
    expect(inherit.deadlineAt).toBe(now + 31_000);
    const extend = computeDeadline(
      { now: now + 29_000, animMs: 400, timing: 'menu', preset: 'normal', budget: inherit.budget, chained: true },
      T,
    );
    expect(extend.deadlineAt).toBe(now + 29_000 + 400 + 8000);
    const capped = computeDeadline(
      { now: now + 89_000, animMs: 0, timing: 'menu', preset: 'normal', budget: extend.budget, chained: true },
      T,
    );
    expect(capped.deadlineAt).toBe(now + 1000 + 90_000);
    const fast = computeDeadline(
      { now: now + 89_000, animMs: 0, timing: 'menu', preset: 'fast', budget: extend.budget, chained: true },
      T,
    );
    expect(fast.deadlineAt).toBe(now + 1000 + 45_000);
  });

  it('小游戏窗口：startsAt = now + anim + 3s，deadline = startsAt + maxTicks×tickMs + 5s', () => {
    expect(minigameWindow(now, 800, 'penguin', T)).toEqual({
      startsAt: now + 800 + 3000,
      deadlineAt: now + 800 + 3000 + 170 * 100 + 5000,
    });
    const x = minigameWindow(now, 0, 'xicong', T);
    expect(x.deadlineAt - x.startsAt).toBe(420 * 50 + 5000);
  });

  it('宽限、恢复、解除托管、断线展示', () => {
    expect(fireAt(now, T)).toBe(now + 800);
    expect(resumeDeadline(now, 20_000, T)).toBe(now + 20_000);
    expect(resumeDeadline(now, 1000, T)).toBe(now + 5000);
    expect(releaseDeadline(now, now + 3000, T)).toBe(now + 10_000);
    expect(releaseDeadline(now, now + 25_000, T)).toBe(now + 25_000);
    expect(releaseDeadline(now, null, T)).toBeNull();
    expect(effectiveDeadline(now + 30_000, now, 15_000)).toBe(now + 15_000);
    expect(effectiveDeadline(now + 10_000, now, 15_000)).toBe(now + 10_000);
    expect(effectiveDeadline(null, now, 15_000)).toBe(now + 15_000);
    expect(effectiveDeadline(now + 1, null, 15_000)).toBe(now + 1);
  });
});
