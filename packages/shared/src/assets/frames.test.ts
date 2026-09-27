import { describe, expect, it } from 'vitest';
import {
  actorFrame,
  attachedObjectFrame,
  buildingFrame,
  decorFrame,
  directionFromDelta,
  roadObjectFrame,
  rotateView,
} from './frames';

const mod8 = (x: number): number => ((x % 8) + 8) % 8;

/** 原版 fcn.00453614 的浮点写法（测试里用 Math.atan2 作参照） */
function referenceDirection(dx: number, dy: number): number {
  const table = [2, 3, 4, 5, 6, 7, 0, 1];
  const k = Math.round(Math.atan2(-dy, dx) / (Math.PI / 4));
  return table[mod8(k)]!;
}

describe('帧选择规则', () => {
  it('建筑、路面物件、附身物件的 8 视角公式', () => {
    for (let facing = 0; facing < 8; facing++) {
      for (let view = 0; view < 8; view++) {
        expect(buildingFrame(facing, view)).toBe(mod8(8 - (facing + view)));
        expect(roadObjectFrame(facing, view)).toBe(mod8(8 - view + facing));
      }
    }
    expect(buildingFrame(0, 0)).toBe(0);
    expect(buildingFrame(7, 7)).toBe(2);
    expect(attachedObjectFrame(0)).toBe(4);
    expect(attachedObjectFrame(6)).toBe(2);
    expect(decorFrame(1)).toBe(0);
  });

  it('棋子帧：方向槽 × perDir + 动画帧（走姿 72 帧 = 8 × 9）', () => {
    for (let dir = 0; dir < 8; dir++) {
      for (let view = 0; view < 8; view++) {
        for (let anim = 0; anim < 9; anim++) {
          const f = actorFrame(dir, view, 9, anim);
          expect(f).toBe(mod8(8 - view + dir) * 9 + anim);
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThan(72);
        }
      }
    }
    expect(actorFrame(2, 0, 9, 10)).toBe(2 * 9 + 1);
    expect(actorFrame(0, 0, 1, 5)).toBe(0);
    expect(actorFrame(0, 0, 9, -1)).toBe(8);
  });

  it('移动方向与原版 atan2 写法逐点一致', () => {
    for (let dx = -40; dx <= 40; dx++) {
      for (let dy = -40; dy <= 40; dy++) {
        expect(directionFromDelta(dx, dy), `${dx},${dy}`).toBe(referenceDirection(dx, dy));
      }
    }
    expect(directionFromDelta(0, 5)).toBe(0); // 南（+y）
    expect(directionFromDelta(5, 0)).toBe(2); // 东（+x）
    expect(directionFromDelta(0, -5)).toBe(4); // 北
    expect(directionFromDelta(-5, 0)).toBe(6); // 西
    expect(directionFromDelta(0, 0)).toBe(2);
    expect(directionFromDelta(1752 - 1700, 1871 - 1900)).toBe(referenceDirection(52, -29));
  });

  it('视角旋转在 0..7 内循环', () => {
    expect(rotateView(7, 1)).toBe(0);
    expect(rotateView(0, -1)).toBe(7);
    expect(rotateView(3, 8)).toBe(3);
  });
});
