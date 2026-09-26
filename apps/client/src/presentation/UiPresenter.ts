// DOM 演出桥（design/client.md §4.2 UiPresenter）：事件 handler 通过它弹 toast、横幅、骰子、HUD 数字闪动。
// 等待一律走动画时钟（倍速、中止、instant 即刻完成）；显示内容写进 uiStore，由 HUD 组件渲染。
import type { SeatIndex } from '@rich4/shared/engine';
import { useUiStore } from '../store/uiStore';
import type { UiPort } from './types';

export interface UiPresenterDeps {
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

/** 骰子滚动时长（1x）与落定后的停留 */
export const DICE_ROLL_MS = 520;
export const DICE_HOLD_MS = 280;

export function createUiPresenter(d: UiPresenterDeps): UiPort {
  const ui = () => useUiStore.getState();
  return {
    toast(text, kind = 'info') {
      ui().toast(text, kind);
    },
    async banner(b, ms, signal) {
      const id = ui().showBanner(b);
      await d.wait(ms, signal);
      ui().hideBanner(id);
    },
    async dice(seat: SeatIndex, faces, signal) {
      ui().setDice({ seat, faces: [...faces], rolling: true });
      await d.wait(DICE_ROLL_MS, signal);
      const cur = ui().dice;
      if (cur) ui().setDice({ seat, faces: [...faces], rolling: false });
      await d.wait(DICE_HOLD_MS, signal);
    },
    flash(seat, field, delta) {
      ui().flash(seat, field, delta);
    },
    closeTransient() {
      ui().closeTransient();
    },
  };
}
