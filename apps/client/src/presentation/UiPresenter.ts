// DOM 演出桥（design/client.md §4.2 UiPresenter）：事件 handler 通过它弹 toast、横幅、骰子、HUD 数字闪动。
// 等待一律走动画时钟（倍速、中止、instant 即刻完成）；显示内容写进 uiStore，由 HUD 组件渲染。
import type { SeatIndex } from '@rich4/shared/engine';
import { DICE_FLIC_FRAMES, DICE_KNOCK_FRAME, DICE_TIMING } from '@rich4/shared/view';
import { useUiStore } from '../store/uiStore';
import type { UiPort } from './types';

export interface UiPresenterDeps {
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * 骰子的缺省时序（original 节奏：FLC 30 ms/帧、落定停留 500 ms；handler 按房间节奏传入 DiceShow）。
 * 滚动 = FLC 36 帧：第 30 帧与播完时各「咚」一声（exe 0x44fb9d / 0x418dc8），播完换成点数面
 */
export const DICE_ROLL_MS = DICE_FLIC_FRAMES * DICE_TIMING.original.flicFrameMs;
export const DICE_HOLD_MS = DICE_TIMING.original.holdMs;

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
    async dice(seat: SeatIndex, faces, signal, show = {}) {
      const frameMs = show.frameMs ?? DICE_TIMING.original.flicFrameMs;
      const holdMs = show.holdMs ?? DICE_HOLD_MS;
      const slot = show.slot ?? null;
      const at = show.at ?? null;
      const locate = show.locate;
      // 中止（封顶、reset、skipAll）之后不再出声：等待会立即完成，否则剩下的「咚」会挤在一起
      const knock = (): void => {
        if (!signal.aborted) show.onKnock?.();
      };
      ui().setDice({ seat, faces: [...faces], rolling: true, frameMs, holdMs, slot, at, locate });
      await d.wait((DICE_KNOCK_FRAME - 1) * frameMs, signal);
      knock();
      await d.wait((DICE_FLIC_FRAMES - DICE_KNOCK_FRAME + 1) * frameMs, signal);
      const cur = ui().dice;
      if (cur) ui().setDice({ seat, faces: [...faces], rolling: false, frameMs, holdMs, slot, at, locate });
      knock();
      await d.wait(holdMs, signal);
    },
    flash(seat, field, delta) {
      ui().flash(seat, field, delta);
    },
    closeTransient() {
      ui().closeTransient();
    },
  };
}
