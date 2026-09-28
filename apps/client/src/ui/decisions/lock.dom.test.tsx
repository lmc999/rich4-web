// 提交锁定与倒计时（useDecision + DecisionFrame）：提交后锁定、nack 解锁、新决策解锁、倒计时到 0 锁定、最后 5 秒变红
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGameStore } from '../../store/gameStore';
import BuyLotDialog from './BuyLotDialog';
import { DecisionClockProvider } from './clock';
import { demoOptions, makeDecision } from './devFixtures';
import { fixture, intents, renderDialog } from './testing';

afterEach(() => {
  vi.useRealTimers();
});

describe('提交锁定', () => {
  it('Promise 解析为 false（nack）后解锁，可以重试', async () => {
    let resolve!: (v: unknown) => void;
    const r = renderDialog(BuyLotDialog, 'BUY_LAND', {
      submit: () =>
        new Promise((res) => {
          resolve = res;
        }),
    });
    await r.user.click(screen.getByTestId('buy-confirm'));
    expect(screen.getByTestId('buy-confirm')).toBeDisabled();
    await act(async () => resolve(false));
    expect(screen.getByTestId('buy-confirm')).toBeEnabled();
    await r.user.click(screen.getByTestId('buy-confirm'));
    expect(intents(r.submit)).toEqual([{ type: 'CONFIRM' }, { type: 'CONFIRM' }]);
  });

  it('Promise 解析为 {ok:false} 或 reject 都解锁；{ok:true} 保持锁定', async () => {
    const results: unknown[] = [{ ok: false }, 'reject', { ok: true }];
    let i = 0;
    const r = renderDialog(BuyLotDialog, 'BUY_LAND', {
      submit: () => {
        const v = results[i++];
        return v === 'reject' ? Promise.reject(new Error('nack')) : Promise.resolve(v);
      },
    });
    for (let k = 0; k < 4; k++) {
      await r.user.click(screen.getByTestId('buy-confirm'));
      await act(async () => {});
    }
    expect(r.submit).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('buy-confirm')).toBeDisabled();
  });

  it('收到新决策（decisionId 变化）后解锁', async () => {
    const r = renderDialog(BuyLotDialog, 'BUY_LAND');
    await r.user.click(screen.getByTestId('buy-decline'));
    expect(screen.getByTestId('buy-decline')).toBeDisabled();
    r.rerenderWith({ decision: { ...r.decision, decisionId: 'd-2' } });
    expect(screen.getByTestId('buy-decline')).toBeEnabled();
    await r.user.click(screen.getByTestId('buy-decline'));
    expect(r.submit).toHaveBeenCalledTimes(2);
  });

  it('全局提交锁：同一决策已由 client.act 提交（store.submitting）时，重新挂载的对话框仍锁定、不再提交', async () => {
    const r = renderDialog(BuyLotDialog, 'BUY_LAND');
    act(() => useGameStore.getState().setSubmitting(r.decision.decisionId));
    try {
      expect(screen.getByTestId('buy-confirm')).toBeDisabled();
      await r.user.click(screen.getByTestId('buy-confirm'));
      expect(r.submit).not.toHaveBeenCalled();
      // 换成新决策后解锁
      r.rerenderWith({ decision: { ...r.decision, decisionId: 'd-9' } });
      expect(screen.getByTestId('buy-confirm')).toBeEnabled();
    } finally {
      act(() => useGameStore.getState().setSubmitting(null));
    }
  });

  it('isMine=false 时不提交', async () => {
    const r = renderDialog(BuyLotDialog, 'BUY_LAND', { isMine: false });
    expect(screen.getByRole('status')).toHaveTextContent('等待 孙小美 做决定');
    await r.user.click(screen.getByTestId('buy-confirm'));
    expect(r.submit).not.toHaveBeenCalled();
  });
});

describe('倒计时', () => {
  it('圆环显示剩余秒数，最后 10 秒变红（与中央倒计时同一档），到 0 锁定全部按钮', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
    const fx = fixture();
    const submit = vi.fn();
    const decision = makeDecision('BUY_LAND', demoOptions(fx.view).BUY_LAND, { now: Date.now(), timeoutMs: 14_000 });
    render(<BuyLotDialog decision={decision} isMine view={fx.view} map={fx.map} submit={submit} />);
    const ring = screen.getByTestId('countdown');
    expect(ring).toHaveAccessibleName('剩余 14 秒');
    expect(ring).toHaveAttribute('data-urgent', 'false');
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(ring).toHaveAccessibleName('剩余 11 秒');
    expect(ring).toHaveAttribute('data-urgent', 'false');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(ring).toHaveAccessibleName('剩余 10 秒');
    expect(ring).toHaveAttribute('data-urgent', 'true');
    expect(screen.getByTestId('buy-confirm')).toBeEnabled();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(ring).toHaveAccessibleName('剩余 0 秒');
    expect(screen.getByTestId('decision-BUY_LAND')).toHaveAttribute('data-expired', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('时间到');
    expect(screen.getByTestId('buy-confirm')).toBeDisabled();
    expect(screen.getByTestId('buy-decline')).toBeDisabled();
    screen.getByTestId('buy-confirm').click();
    expect(submit).not.toHaveBeenCalled();
  });

  it('时钟偏移由 DecisionClockProvider 提供（服务器快 10 秒 → 剩余少 10 秒）', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(5_000_000);
    const fx = fixture();
    const decision = makeDecision('BUY_LAND', demoOptions(fx.view).BUY_LAND, { now: Date.now(), timeoutMs: 30_000 });
    render(
      <DecisionClockProvider offsetMs={10_000}>
        <BuyLotDialog decision={decision} isMine view={fx.view} map={fx.map} submit={vi.fn()} />
      </DecisionClockProvider>,
    );
    expect(screen.getByTestId('countdown')).toHaveAccessibleName('剩余 20 秒');
  });

  it('不限时（deadlineAt=null）显示 ∞，不会超时', () => {
    renderDialog(BuyLotDialog, 'BUY_LAND', { timeoutMs: null });
    expect(screen.getByTestId('countdown')).toHaveAccessibleName('不限时');
    expect(screen.getByTestId('buy-confirm')).toBeEnabled();
  });
});
