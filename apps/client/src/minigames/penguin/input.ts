// 企鹅挖宝的输入（design/minigames-ai.md §7.2）：左键 / 轻点冰面 → 菱形拾取得到格号；方向键移动高亮格、回车确认（无障碍）。
// 宿主在 accepting 时才记录 [t, PickCell, cell]。
import { type PenguinState, penguin } from '@rich4/shared/minigames';
import type { InputContext, MinigameInput } from '../types';

const { pickCell, cellCenter, rowOf, colOf, cellAt, isValidCell } = penguin;

const KEY_DIR: Readonly<Record<string, readonly [number, number]>> = {
  // 屏幕方向 → (行, 列) 增量：行 +1 为右下，列 +1 为右上
  ArrowRight: [1, 1],
  ArrowLeft: [-1, -1],
  ArrowUp: [-1, 1],
  ArrowDown: [1, -1],
};

export function createPenguinInput(ctx: InputContext<PenguinState>): MinigameInput {
  const { el, sink } = ctx;
  let kbCell = -1;
  const onDown = (e: PointerEvent): void => {
    if (!ctx.interactive) return;
    e.preventDefault();
    const p = ctx.toStage(e.clientX, e.clientY);
    sink.hover(p);
    sink.pick(pickCell(p.x, p.y));
  };
  const onMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    sink.hover(ctx.toStage(e.clientX, e.clientY));
  };
  const onLeave = (): void => sink.hover(null);
  const onKey = (e: KeyboardEvent): void => {
    if (!ctx.interactive) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (kbCell >= 0) sink.pick(kbCell);
      return;
    }
    const d = KEY_DIR[e.key];
    if (!d) return;
    e.preventDefault();
    const from = kbCell >= 0 ? kbCell : ctx.state().cell;
    // 沿方向找下一个有效格（跳过冰屋）
    let r = rowOf(from);
    let c = colOf(from);
    for (let i = 0; i < 3; i++) {
      r += d[0];
      c += d[1];
      const n = cellAt(r, c);
      if (n < 0) break;
      if (isValidCell(n)) {
        kbCell = n;
        sink.hover(cellCenter(n));
        break;
      }
    }
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
