// 经典舞台登记 toast 落点（client-dom，original-skin.md §4.1「toast」）：对局画面（toasts）在舞台缩小时登记棋盘视窗以外的
// 空位，Toasts 排在那里；抽屉盖住时换位；不是对局画面、桌面、卸载后回到缺省位置。
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../../store/uiStore';
import { Toasts } from '../hud/Overlays';
import { useToastSlot } from '../hud/toastSlot';
import { ClassicStage } from './ClassicStage';
import { TOAST_GUTTER_TOP, TOAST_INSET } from './layout';

afterEach(() => {
  useUiStore.getState().clear();
});

function renderStage(size: { w: number; h: number }, toasts = true) {
  const utils = render(
    <>
      <ClassicStage
        size={size}
        toasts={toasts}
        leftLabel="座位"
        rightLabel="聊天"
        left={() => <p>left</p>}
        right={() => <p>right</p>}
      >
        <i />
      </ClassicStage>
      <Toasts />
    </>,
  );
  act(() => {
    useUiStore.getState().toast('忍太郎 與 孫小美 的同盟破裂');
  });
  return utils;
}

describe('ClassicStage：toast 落点', () => {
  it('844×390：排在左边距条（抽屉按钮以下）；开左抽屉换到右边距条，关上回来；卸载后回到缺省位置', async () => {
    const { unmount } = renderStage({ w: 844, h: 390 });
    const list = screen.getByTestId('toasts');
    expect(list).toHaveAttribute('data-place', 'gutter-left');
    expect(list.style).toMatchObject({ left: `${TOAST_INSET}px`, top: `${TOAST_GUTTER_TOP}px`, width: '150px' });
    await userEvent.click(screen.getByTestId('classic-drawer-left-btn'));
    expect(screen.getByTestId('toasts')).toHaveAttribute('data-place', 'gutter-right');
    expect(screen.getByTestId('toasts').style.left).toBe(`${682 + TOAST_INSET}px`);
    await userEvent.click(screen.getByTestId('classic-drawer-left-close'));
    expect(screen.getByTestId('toasts')).toHaveAttribute('data-place', 'gutter-left');
    unmount();
    expect(useToastSlot.getState().slot).toBeNull();
  });

  it('667×375：舞台右栏底部；开右抽屉（盖住右栏）时回到缺省位置', async () => {
    renderStage({ w: 667, h: 375 });
    expect(screen.getByTestId('toasts')).toHaveAttribute('data-place', 'stage-right');
    await userEvent.click(screen.getByTestId('classic-drawer-right-btn'));
    expect(screen.getByTestId('toasts')).toHaveAttribute('data-place', 'page');
    expect(screen.getByTestId('toasts').style).toMatchObject({ left: '', top: '', width: '' });
  });

  it('桌面 1920×1080、不是对局画面（toasts 未开）：缺省位置', () => {
    const a = renderStage({ w: 1920, h: 1080 });
    expect(screen.getByTestId('toasts')).toHaveAttribute('data-place', 'page');
    a.unmount();
    renderStage({ w: 844, h: 390 }, false);
    expect(screen.getByTestId('toasts')).toHaveAttribute('data-place', 'page');
  });
});
