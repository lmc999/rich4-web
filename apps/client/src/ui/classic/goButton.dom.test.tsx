// GO 钮的点击声（审查回归：按 GO 时缺少原版的界面点击声 Effect#1）：鼠标 / 触摸按下 GO、点骰子数竖槽时先放 cue.ui.go
// （exe 0x417ac9 / 0x417a08，在隐去 GO、开始掷骰之前），键盘的 GO 与 D 键不出声（0x40126d–0x401283、0x4012c9–0x401306）。
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoButton, type RollControl } from './GoButton';
import { playScreenCue, warmScreenCues } from './screens/uiSound';

vi.mock('./screens/uiSound', () => ({ playScreenCue: vi.fn(), warmScreenCues: vi.fn() }));

afterEach(() => {
  vi.mocked(playScreenCue).mockClear();
  vi.mocked(warmScreenCues).mockClear();
});

function control(o: Partial<RollControl> = {}): RollControl {
  return {
    spectator: false,
    ready: true,
    lock: null,
    allowed: [1, 2, 3],
    chosen: 3,
    canChooseDice: true,
    slots: 3,
    shown: 3,
    stay: false,
    roll: vi.fn(),
    cycleDice: vi.fn(),
    pickDice: vi.fn(),
    ...o,
  };
}

describe('GO 钮的点击声', () => {
  it('鼠标按下 GO：先放 go（Effect#1），再提交掷骰；键盘触发只掷骰不出声', () => {
    const ctl = control();
    render(<GoButton ctl={ctl} />);
    expect(warmScreenCues).toHaveBeenCalledTimes(1);
    const go = screen.getByTestId('action-roll');
    fireEvent.click(go, { detail: 1 });
    expect(vi.mocked(playScreenCue).mock.calls).toEqual([['go']]);
    expect(ctl.roll).toHaveBeenCalledTimes(1);
    expect(vi.mocked(playScreenCue).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(ctl.roll).mock.invocationCallOrder[0]!,
    );
    fireEvent.click(go, { detail: 0 });
    expect(ctl.roll).toHaveBeenCalledTimes(2);
    expect(playScreenCue).toHaveBeenCalledTimes(1);
  });

  it('点骰子数竖槽（鼠标）放同一声再改颗数；键盘循环不出声；不能按时不出声', () => {
    const ctl = control();
    const { unmount } = render(<GoButton ctl={ctl} />);
    const dc = screen.getByTestId('action-dice-count');
    fireEvent.click(dc, { detail: 1, clientX: 0, clientY: 0 });
    expect(vi.mocked(playScreenCue).mock.calls).toEqual([['go']]);
    expect(ctl.pickDice).toHaveBeenCalledTimes(1);
    fireEvent.click(dc, { detail: 0 });
    expect(ctl.cycleDice).toHaveBeenCalledTimes(1);
    expect(playScreenCue).toHaveBeenCalledTimes(1);
    unmount();
    // 不是本人可按的时候：GO 与竖槽都禁用，点了也不出声
    const off = control({ ready: false, canChooseDice: false });
    render(<GoButton ctl={off} />);
    fireEvent.click(screen.getByTestId('action-roll'), { detail: 1 });
    fireEvent.click(screen.getByTestId('action-dice-count'), { detail: 1 });
    expect(playScreenCue).toHaveBeenCalledTimes(1);
    expect(off.roll).not.toHaveBeenCalled();
  });

  it('观战者没有 GO 钮，也不预载音频模块', () => {
    render(<GoButton ctl={control({ spectator: true, ready: false })} />);
    expect(screen.queryByTestId('action-roll')).toBeNull();
    expect(warmScreenCues).not.toHaveBeenCalled();
  });
});
