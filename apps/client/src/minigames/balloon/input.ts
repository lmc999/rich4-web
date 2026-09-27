// 七彩气球的输入（design/minigames-ai.md §7.2）：左键射击，触屏每根手指按下算一次；坐标取整到舞台坐标。
// tick 归属（最近 tick、回滚一步）由宿主处理。
import type { BalloonState } from '@rich4/shared/minigames';
import type { InputContext, MinigameInput } from '../types';

export function createBalloonInput(ctx: InputContext<BalloonState>): MinigameInput {
  const { el, sink } = ctx;
  let last: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent): void => {
    if (!ctx.interactive) return;
    e.preventDefault();
    const p = ctx.toStage(e.clientX, e.clientY);
    last = p;
    sink.hover(p);
    sink.click(p);
  };
  const onMove = (e: PointerEvent): void => {
    const p = ctx.toStage(e.clientX, e.clientY);
    last = p;
    sink.hover(p);
  };
  const onLeave = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') sink.hover(null);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!ctx.interactive || (e.key !== ' ' && e.key !== 'Enter') || !last) return;
    e.preventDefault();
    sink.click(last);
  };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('keydown', onKey);
  return {
    destroy() {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('keydown', onKey);
    },
  };
}
