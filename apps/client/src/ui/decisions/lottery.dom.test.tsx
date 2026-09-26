// LotteryDialog：已售号码禁用并标出买主，机选只挑未售号码，买 → LOTTERY_BUY{number=下标}
import type { SeatIndex } from '@rich4/shared/engine';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import LotteryDialog, { freeNumbers, quickPick } from './LotteryDialog';
import { expectSingleIntent, renderDialog } from './testing';

describe('quickPick / freeNumbers', () => {
  const sold: (SeatIndex | null)[] = Array.from({ length: 36 }, (_, i) => (i % 3 === 0 ? 1 : null));

  it('未售号码列表', () => {
    expect(freeNumbers(sold)).toHaveLength(24);
    expect(freeNumbers(sold)).not.toContain(0);
  });

  it('任何随机值都只挑未售号码', () => {
    for (let k = 0; k < 200; k++) {
      const r = k / 200;
      const n = quickPick(sold, () => r);
      expect(n).not.toBeNull();
      expect(sold[n!]).toBeNull();
    }
    expect(quickPick(sold, () => 0.9999999)).toBe(35);
    expect(quickPick(sold, () => 0)).toBe(1);
  });

  it('全部售出时返回 null', () => {
    expect(quickPick(Array.from({ length: 36 }, () => 2 as SeatIndex))).toBeNull();
  });
});

describe('LotteryDialog', () => {
  it('显示奖池；已售号码禁用并标注买主与「我的」', () => {
    renderDialog(LotteryDialog, 'LOTTERY');
    expect(screen.getByTestId('lottery-pool')).toHaveTextContent('18,000');
    const b3 = screen.getByTestId('lottery-ball-3');
    expect(b3).toBeDisabled();
    expect(b3).toHaveAttribute('data-mine', 'true');
    expect(b3).toHaveAccessibleName('3 号（孙小美 已买）');
    expect(screen.getByTestId('lottery-ball-8')).toHaveAccessibleName('8 号（阿土伯 已买）');
    expect(screen.getByTestId('lottery-ball-1')).toBeEnabled();
    expect(screen.getByText('我已买 1 张')).toBeInTheDocument();
  });

  it('机选（注入随机源）选中未售号码，买 → LOTTERY_BUY{下标}', async () => {
    // 未售下标依次为 0,1,3,4,5,6,9,…；random=0.1 → 第 floor(0.1×31)=3 个 → 下标 4（显示 5 号）
    const r = renderDialog(LotteryDialog, 'LOTTERY', { extraProps: { random: () => 0.1 } });
    expect(screen.getByTestId('lottery-buy')).toBeDisabled();
    await r.user.click(screen.getByTestId('lottery-quick'));
    expect(screen.getByTestId('lottery-ball-5')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('lottery-buy')).toHaveTextContent('买 5 号');
    await r.user.dblClick(screen.getByTestId('lottery-buy'));
    expectSingleIntent(r.submit, { type: 'LOTTERY_BUY', number: 4 });
  });

  it('手选号码；现金不足时不能买；不买 → SKIP', async () => {
    const r = renderDialog(LotteryDialog, 'LOTTERY', { options: { cash: 500 } });
    await r.user.click(screen.getByTestId('lottery-ball-36'));
    expect(screen.getByTestId('lottery-ball-36')).toHaveAttribute('aria-pressed', 'false'); // 36 号已售，点不动
    await r.user.click(screen.getByTestId('lottery-ball-12'));
    expect(screen.getByTestId('lottery-buy')).toBeDisabled();
    await r.user.click(screen.getByTestId('lottery-skip'));
    expectSingleIntent(r.submit, { type: 'SKIP' });
  });

  it('全部售出时机选禁用', () => {
    renderDialog(LotteryDialog, 'LOTTERY', { options: { sold: Array.from({ length: 36 }, () => 1 as SeatIndex) } });
    expect(screen.getByTestId('lottery-quick')).toBeDisabled();
  });
});
