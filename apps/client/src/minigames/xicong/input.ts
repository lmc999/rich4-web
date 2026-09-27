// 喜从天降的输入（design/minigames-ai.md §7.2）：鼠标横向位置（游玩时隐藏光标）；触屏按住横向拖动，按绝对 x 映射；
// ←/→ 键以每 tick 20px 移动一个虚拟光标（无障碍）。宿主每个 tick 至多记一条 [t, CursorX, x]，只在 x 变化时记。
import type { XicongState } from '@rich4/shared/minigames';
import type { InputContext, MinigameInput } from '../types';

export const KEY_STEP = 20;

export function createXicongInput(ctx: InputContext<XicongState>): MinigameInput {
  const { el, sink } = ctx;
  let held = 0;
  let vx: number | null = null;
  const onPointer = (e: PointerEvent): void => {
    const p = ctx.toStage(e.clientX, e.clientY);
    sink.hover(p);
    if (!ctx.interactive) return;
    if (e.type === 'pointerdown') {
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // 合成事件没有真实指针
      }
    }
    // 触屏只在按住时跟随；鼠标一直跟随
    if (e.pointerType === 'touch' && e.type === 'pointermove' && e.buttons === 0) return;
    vx = p.x;
    sink.cursor(p.x);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!ctx.interactive) return;
    const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (d === 0) return;
    e.preventDefault();
    held = e.type === 'keydown' ? d : held === d ? 0 : held;
  };
  el.addEventListener('pointerdown', onPointer);
  el.addEventListener('pointermove', onPointer);
  el.addEventListener('keydown', onKey);
  el.addEventListener('keyup', onKey);
  return {
    beforeTick() {
      if (held === 0) return;
      const base = vx ?? ctx.state().cursorX;
      vx = Math.max(0, Math.min(639, base + held * KEY_STEP));
      sink.cursor(vx);
    },
    destroy() {
      el.removeEventListener('pointerdown', onPointer);
      el.removeEventListener('pointermove', onPointer);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('keyup', onKey);
    },
  };
}
