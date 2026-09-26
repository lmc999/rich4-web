import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cellCenterScreen,
  cellFromView,
  cellToView,
  diamondPoints,
  dirOfViewStep,
  facingOf,
  fromView,
  type GridSize,
  gridScreenBounds,
  isoToScreen,
  normRotation,
  ROTATIONS,
  type Rotation,
  rectToView,
  rotateDir,
  screenToCell,
  screenToIso,
  toView,
  viewGrid,
} from './projection';

const G: GridSize = { w: 18, h: 9 };
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

describe('isoToScreen / screenToIso', () => {
  it('2:1 dimetric：+x 向屏幕右下（SE），+y 向左下（SW）', () => {
    expect(isoToScreen(1, 0)).toEqual({ x: 64, y: 32 });
    expect(isoToScreen(0, 1)).toEqual({ x: -64, y: 32 });
    expect(isoToScreen(1, 1)).toEqual({ x: 0, y: 64 });
    expect(isoToScreen(0, 0, 2)).toEqual({ x: 0, y: -48 });
  });

  it('往返转换', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: -500, max: 500, noNaN: true }),
        (x, y) => {
          const s = isoToScreen(x, y);
          const b = screenToIso(s.x, s.y);
          return close(b.x, x) && close(b.y, y);
        },
      ),
    );
  });
});

describe('4 方向旋转', () => {
  it('toView / fromView 互逆（连续坐标，所有旋转）', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: G.w, noNaN: true }),
        fc.double({ min: 0, max: G.h, noNaN: true }),
        fc.constantFrom(...ROTATIONS),
        (x, y, r) => {
          const v = toView({ x, y }, r, G);
          const back = fromView(v, r, G);
          return close(back.x, x) && close(back.y, y);
        },
      ),
    );
  });

  it('旋转可复合：R∘R = rot2，R∘R∘R∘R = 恒等', () => {
    const p = { x: 3.25, y: 7.5 };
    let q = p;
    let g = G;
    for (let i = 1; i <= 4; i++) {
      q = toView(q, 1, g);
      g = viewGrid(g, 1);
      const direct = toView(p, normRotation(i), G);
      expect(q.x).toBeCloseTo(direct.x, 9);
      expect(q.y).toBeCloseTo(direct.y, 9);
    }
    expect(q.x).toBeCloseTo(p.x, 9);
    expect(q.y).toBeCloseTo(p.y, 9);
  });

  it('网格四角映射到视图网格四角，且格子全部落在视图网格内', () => {
    for (const r of ROTATIONS) {
      const vg = viewGrid(G, r);
      expect(vg.w * vg.h).toBe(G.w * G.h);
      const seen = new Set<string>();
      for (let y = 0; y < G.h; y++) {
        for (let x = 0; x < G.w; x++) {
          const v = cellToView({ x, y }, r, G);
          expect(v.x).toBeGreaterThanOrEqual(0);
          expect(v.y).toBeGreaterThanOrEqual(0);
          expect(v.x).toBeLessThan(vg.w);
          expect(v.y).toBeLessThan(vg.h);
          seen.add(`${v.x},${v.y}`);
          expect(cellFromView(v, r, G)).toEqual({ x, y });
        }
      }
      expect(seen.size).toBe(G.w * G.h);
    }
  });

  it('rot1 让逻辑北（-y）朝向屏幕 SE，方向与点变换一致', () => {
    expect(rotateDir({ x: 0, y: -1 }, 1)).toEqual({ x: 1, y: 0 });
    for (const r of ROTATIONS) {
      for (const d of [
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: -1, y: 0 },
        { x: 0, y: -1 },
      ]) {
        const a = toView({ x: 4.5, y: 4.5 }, r, G);
        const b = toView({ x: 4.5 + d.x, y: 4.5 + d.y }, r, G);
        const rd = rotateDir(d, r);
        expect(close(b.x - a.x, rd.x) && close(b.y - a.y, rd.y)).toBe(true);
      }
    }
  });

  it('rectToView 保持面积、奇数旋转宽高互换，且覆盖矩形内每一格', () => {
    const rect = { x: 3, y: 1, w: 2, h: 3 };
    for (const r of ROTATIONS) {
      const vr = rectToView(rect, r, G);
      expect(vr.w * vr.h).toBe(6);
      if (r % 2 === 1) expect([vr.w, vr.h]).toEqual([3, 2]);
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const v = cellToView({ x, y }, r, G);
          expect(v.x >= vr.x && v.x < vr.x + vr.w && v.y >= vr.y && v.y < vr.y + vr.h).toBe(true);
        }
      }
    }
  });
});

describe('拾取与包围盒', () => {
  it('screenToCell 在格中心及菱形内部都取回同一格（所有旋转）', () => {
    for (const r of ROTATIONS as readonly Rotation[]) {
      for (const c of [
        { x: 0, y: 0 },
        { x: 5, y: 2 },
        { x: 17, y: 8 },
      ]) {
        const p = cellCenterScreen(c, r, G);
        for (const [dx, dy] of [
          [0, 0],
          [40, 0],
          [-40, 0],
          [0, 18],
          [0, -18],
        ] as const) {
          expect(screenToCell(p.x + dx, p.y + dy, r, G)).toEqual(c);
        }
      }
    }
  });

  it('diamondPoints 为 N、E、S、W 四角', () => {
    expect(diamondPoints(0, 0)).toEqual([0, 0, 64, 32, 0, 64, -64, 32]);
  });

  it('gridScreenBounds 包含所有格角', () => {
    for (const r of ROTATIONS) {
      const b = gridScreenBounds(G, r);
      const vg = viewGrid(G, r);
      for (const [x, y] of [
        [0, 0],
        [vg.w, 0],
        [0, vg.h],
        [vg.w, vg.h],
      ] as const) {
        const p = isoToScreen(x, y);
        expect(p.x).toBeGreaterThanOrEqual(b.x - 1e-9);
        expect(p.x).toBeLessThanOrEqual(b.x + b.w + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(b.y - 1e-9);
        expect(p.y).toBeLessThanOrEqual(b.y + b.h + 1e-9);
      }
    }
  });
});

describe('朝向', () => {
  it('视图步 → 屏幕朝向 → 正/背面与镜像', () => {
    expect(dirOfViewStep(1, 0)).toBe('SE');
    expect(dirOfViewStep(0, 1)).toBe('SW');
    expect(dirOfViewStep(-1, 0)).toBe('NW');
    expect(dirOfViewStep(0, -1)).toBe('NE');
    expect(facingOf('SE')).toEqual({ facing: 'front', mirror: false });
    expect(facingOf('SW')).toEqual({ facing: 'front', mirror: true });
    expect(facingOf('NE')).toEqual({ facing: 'back', mirror: false });
    expect(facingOf('NW')).toEqual({ facing: 'back', mirror: true });
  });

  it('normRotation 处理负数与越界', () => {
    expect(normRotation(-1)).toBe(3);
    expect(normRotation(5)).toBe(1);
  });
});
