// 中央决策倒计时的纯逻辑（client-unit）：显示条件、剩余整秒、定时器对齐、提示音档位与去重。
import type { YourDecision } from '@rich4/shared/net';
import { describe, expect, it } from 'vitest';
import {
  BeepGate,
  beepKey,
  beepLevelFor,
  COUNTDOWN_FINAL_S,
  COUNTDOWN_URGENT_S,
  countdownOnline,
  countdownTarget,
  msToNextSecond,
  secsLeft,
} from './countdownLogic';

function decision(over: Partial<YourDecision> = {}): YourDecision {
  return {
    decisionId: 'd1',
    seat: 0,
    kind: 'TURN_MENU',
    timing: 'menu',
    options: {} as YourDecision['options'],
    defaultIntent: { type: 'ROLL' },
    deadlineAt: 50_000,
    ...over,
  };
}

describe('countdownTarget', () => {
  it('本人、有截止时间、未提交、非托管、不是小游戏时才跟随', () => {
    expect(countdownTarget(decision(), null, 'human')).toEqual({
      decisionId: 'd1',
      kind: 'TURN_MENU',
      deadlineAt: 50_000,
    });
    expect(countdownTarget(decision({ kind: 'BUY_LAND' }), 'other', 'human')?.kind).toBe('BUY_LAND');
  });

  it('没有决策 / 观战者 / 不限时（含暂停中）/ 已提交 / 托管 / 小游戏：不显示', () => {
    expect(countdownTarget(null, null, 'human')).toBeNull();
    expect(countdownTarget(decision(), null, null)).toBeNull();
    expect(countdownTarget(decision({ deadlineAt: null }), null, 'human')).toBeNull();
    expect(countdownTarget(decision(), 'd1', 'human')).toBeNull();
    for (const c of ['autopilot:manual', 'autopilot:afk', 'autopilot:disconnect', 'autopilot:left', 'ai'] as const) {
      expect(countdownTarget(decision(), null, c), c).toBeNull();
    }
    expect(countdownTarget(decision({ kind: 'MINIGAME' }), null, 'human')).toBeNull();
  });

  it('断线（重连中 / 已断开 / 断开后重新连接中）：不显示；open 与还没连过的 idle（单测、预览）照常', () => {
    expect(countdownOnline('open')).toBe(true);
    expect(countdownOnline('idle')).toBe(true);
    for (const st of ['reconnecting', 'closed', 'connecting'] as const) expect(countdownOnline(st), st).toBe(false);
    expect(countdownTarget(decision(), null, 'human', false)).toBeNull();
    expect(countdownTarget(decision(), null, 'human', true)?.decisionId).toBe('d1');
  });
});

describe('剩余整秒与定时器对齐', () => {
  it('secsLeft 向上取整，到点为 0', () => {
    expect(secsLeft(15_000)).toBe(15);
    expect(secsLeft(14_001)).toBe(15);
    expect(secsLeft(14_000)).toBe(14);
    expect(secsLeft(1)).toBe(1);
    expect(secsLeft(0)).toBe(0);
    expect(secsLeft(-500)).toBe(0);
  });

  it('msToNextSecond：到显示的秒数下一次变化还有多久，跨过边界后正好少一秒', () => {
    expect(msToNextSecond(7_300)).toBe(300);
    expect(msToNextSecond(7_000)).toBe(1_000);
    expect(msToNextSecond(10_999)).toBe(999);
    expect(msToNextSecond(0.4)).toBe(1);
    expect(msToNextSecond(-10)).toBe(1);
    for (const ms of [7_300, 7_000, 10_999, 999, 1]) {
      expect(secsLeft(ms - msToNextSecond(ms)), String(ms)).toBe(secsLeft(ms) - 1);
    }
  });
});

describe('提示音', () => {
  it('最后 10 秒单响、最后 3 秒双响档；10 秒以上与到点不响', () => {
    expect(COUNTDOWN_URGENT_S).toBe(10);
    expect(COUNTDOWN_FINAL_S).toBe(3);
    expect(beepLevelFor(11)).toBeNull();
    expect(beepLevelFor(10)).toBe('tick');
    expect(beepLevelFor(4)).toBe('tick');
    expect(beepLevelFor(3)).toBe('final');
    expect(beepLevelFor(1)).toBe('final');
    expect(beepLevelFor(0)).toBeNull();
  });

  it('beepKey 只看截止时间：回合菜单换了 decisionId 重发、截止时间没变时键相同；截止时间变了键不同', () => {
    const a = beepKey({ decisionId: 'd1', kind: 'TURN_MENU', deadlineAt: 50_000 });
    expect(beepKey({ decisionId: 'd2', kind: 'TURN_MENU', deadlineAt: 50_000 })).toBe(a);
    expect(beepKey({ decisionId: 'd1', kind: 'TURN_MENU', deadlineAt: 51_000 })).not.toBe(a);
    // 同一秒：旧决策刚响过「10」，换了 id 的新决策到达时不再响
    const g = new BeepGate();
    expect(g.take(a, 10)).toBe('tick');
    expect(g.take(beepKey({ decisionId: 'd2', kind: 'TURN_MENU', deadlineAt: 50_000 }), 10)).toBeNull();
    expect(g.take(beepKey({ decisionId: 'd2', kind: 'TURN_MENU', deadlineAt: 50_000 }), 9)).toBe('tick');
  });

  it('BeepGate：同一截止时间下每秒最多一次（回跳也不重复）；换键重新计', () => {
    const g = new BeepGate();
    const k = beepKey({ decisionId: 'd1', kind: 'TURN_MENU', deadlineAt: 50_000 });
    expect(g.take(k, 12)).toBeNull();
    expect(g.take(k, 10)).toBe('tick');
    expect(g.take(k, 10)).toBeNull();
    expect(g.take(k, 9)).toBe('tick');
    // 时钟重新校准让显示回跳一格：不再响
    expect(g.take(k, 10)).toBeNull();
    expect(g.take(k, 3)).toBe('final');
    expect(g.take(k, 3)).toBeNull();
    // 暂停恢复换了截止时间：重新计
    const k2 = beepKey({ decisionId: 'd1', kind: 'TURN_MENU', deadlineAt: 60_000 });
    expect(g.take(k2, 3)).toBe('final');
    g.reset();
    expect(g.take(k2, 3)).toBe('final');
  });
});
