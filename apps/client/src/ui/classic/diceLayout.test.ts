// 骰子 FLC 的摆放（审查回归：FLC 用原版固定舞台坐标摆放，而我们的镜头跟随偏上 16、棋盘缩放可以与舞台缩放不同、
// 可以关闭跟随或 pin 别人——骰子相对人物的位置和大小对不上）：按人物实际的画面位置与棋盘缩放 / 舞台缩放摆。
import { describe, expect, it } from 'vitest';
import {
  BOARD_RENDER_BASE,
  DICE_FLC_H,
  DICE_FLC_OFFSETS,
  DICE_FLC_W,
  DICE_SCALE_MAX,
  diceFlcPlacement,
  diceFlcRect,
  REGION,
} from './layout';

/** 舞台缩放 s、镜头缩放 zoom 时，人物锚点在棋盘视窗里的舞台坐标 (sx, sy) 对应的画布坐标 */
function anchorAt(s: number, zoom: number, sx: number, sy: number) {
  const w = REGION.board.w * s;
  const h = REGION.board.h * s;
  return { x: (sx - REGION.board.x) * s, y: (sy - REGION.board.y) * s, w, h, zoom };
}

describe('骰子 FLC 的摆放（diceFlcPlacement）', () => {
  it('没有人物位置：原版固定画点 (136,48)+表 0x4730ac[槽]，比例 1', () => {
    for (let slot = 0; slot < 8; slot++) {
      const r = diceFlcRect(slot);
      expect(diceFlcPlacement(slot, null)).toEqual({ x: r.x, y: r.y, scale: 1, tracked: false });
    }
    expect(DICE_FLC_OFFSETS[4]).toEqual([-12, -12]);
    expect(BOARD_RENDER_BASE).toEqual({ x: 220, y: 260 });
  });

  it('桌面默认（棋盘缩放 = 舞台缩放 1.85）：人物锚点正在 (220,260) 时与原版画点完全相同', () => {
    for (let slot = 0; slot < 8; slot++) {
      const p = diceFlcPlacement(slot, anchorAt(1.85, 1.85, 220, 260));
      const r = diceFlcRect(slot);
      expect(p.scale).toBeCloseTo(1, 9);
      expect(p.x).toBeCloseTo(r.x, 6);
      expect(p.y).toBeCloseTo(r.y, 6);
      expect(p.tracked).toBe(true);
    }
  });

  it('镜头跟随偏上 16（人物锚点实测在 (220,276)）：FLC 跟着人物下移 16，相对人物的位置与原版一致', () => {
    const p = diceFlcPlacement(4, anchorAt(1.85, 1.85, 220, 276));
    expect(p.x).toBeCloseTo(124, 6);
    expect(p.y).toBeCloseTo(36 + 16, 6);
  });

  it('手机横屏（舞台缩放 0.8125、棋盘缩放 1）：FLC 与点数面按 1/0.8125 放大，相对人物的落点同比例', () => {
    const k = 1 / 0.8125;
    const p = diceFlcPlacement(4, anchorAt(0.8125, 1, 220.3, 320));
    expect(p.scale).toBeCloseTo(k, 9);
    // FLC 左上 − 人物锚点 = ((136,48) − (220,260) + T[4]) × k
    expect(p.x - 220.3).toBeCloseTo((124 - 220) * k, 6);
    expect(p.y - 320).toBeCloseTo((36 - 260) * k, 6);
    // 实测的锚点 (220.3,280)：放大后的 FLC 上缘会伸到视窗外 36 像素，夹到视窗上缘 −12（骰子整体仍在人物附近）
    const q = diceFlcPlacement(4, anchorAt(0.8125, 1, 220.3, 280));
    expect(q.x - 220.3).toBeCloseTo((124 - 220) * k, 6);
    expect(q.y).toBe(REGION.board.y - 12);
  });

  it('人物不在棋盘视窗里（关闭跟随 / pin 别人）：按人物在视窗中心摆，不画到看不见的地方', () => {
    const p = diceFlcPlacement(2, anchorAt(1.85, 1.85, -300, 900));
    const r = diceFlcRect(2);
    expect(p.tracked).toBe(false);
    expect([p.x, p.y]).toEqual([r.x, r.y]);
  });

  it('放得很大时比例封顶，整块 FLC 夹在棋盘视窗里（上缘最多伸出 12）', () => {
    const big = diceFlcPlacement(4, anchorAt(1.85, 4, 220, 260));
    expect(big.scale).toBe(DICE_SCALE_MAX);
    expect(big.y).toBe(REGION.board.y - 12);
    const edge = diceFlcPlacement(5, anchorAt(1.85, 1.85, 5, 470));
    expect(edge.tracked).toBe(true);
    expect(edge.x).toBe(REGION.board.x);
    expect(edge.x + DICE_FLC_W * edge.scale).toBeLessThanOrEqual(REGION.board.x + REGION.board.w);
    expect(edge.y + DICE_FLC_H * edge.scale).toBeLessThanOrEqual(REGION.board.y + REGION.board.h);
  });
});
