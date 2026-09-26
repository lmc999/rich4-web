import type { Cell, Rect } from '@rich4/shared/data';
import { describe, expect, it } from 'vitest';
import { DepthBias, depthOfCell, depthOfMove, depthOfRect, relationToRect } from './depth';
import { cellToView, type GridSize, isoToScreen, ROTATIONS, rectToView } from './projection';

/** 角色精灵半宽（128×0.62/2 ≈ 40） */
const ACTOR_HALF_W = 40;

function ring(r: Rect): Cell[] {
  const out: Cell[] = [];
  for (let y = r.y - 1; y <= r.y + r.h; y++) {
    for (let x = r.x - 1; x <= r.x + r.w; x++) {
      const inside = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
      if (!inside) out.push({ x, y });
    }
  }
  return out;
}

/** 屏幕 x 区间是否相交（side 关系要求不相交，才允许任意顺序） */
function screenOverlapX(c: Cell, r: Rect): boolean {
  const corners = [
    isoToScreen(r.x, r.y),
    isoToScreen(r.x + r.w, r.y),
    isoToScreen(r.x + r.w, r.y + r.h),
    isoToScreen(r.x, r.y + r.h),
  ];
  const bx0 = Math.min(...corners.map((p) => p.x));
  const bx1 = Math.max(...corners.map((p) => p.x));
  const cx = isoToScreen(c.x + 0.5, c.y + 0.5).x;
  return cx + ACTOR_HALF_W > bx0 && cx - ACTOR_HALF_W < bx1;
}

function checkFootprint(r: Rect): void {
  const b = depthOfRect(r, DepthBias.Building);
  for (const c of ring(r)) {
    const a = depthOfCell(c, DepthBias.Actor);
    const rel = relationToRect(c, r);
    if (rel === 'front') expect(a, `actor ${c.x},${c.y} 应在 ${JSON.stringify(r)} 之前`).toBeGreaterThan(b);
    else if (rel === 'behind') expect(a, `actor ${c.x},${c.y} 应在 ${JSON.stringify(r)} 之后`).toBeLessThan(b);
    else expect(screenOverlapX(c, r), `side ${c.x},${c.y} 屏幕上不应重叠`).toBe(false);
  }
}

describe('深度排序', () => {
  it('1×1 建筑的 8 邻域', () => {
    const r = { x: 5, y: 5, w: 1, h: 1 };
    expect(ring(r)).toHaveLength(8);
    checkFootprint(r);
  });

  it('2×2 footprint 的外圈（12 条边邻 + 4 个角）', () => {
    const r = { x: 4, y: 6, w: 2, h: 2 };
    expect(ring(r)).toHaveLength(12);
    checkFootprint(r);
  });

  it('旋转到视图网格后依然正确（4 个方向）', () => {
    const g: GridSize = { w: 12, h: 10 };
    const r = { x: 3, y: 4, w: 2, h: 2 };
    for (const rot of ROTATIONS) {
      const vr = rectToView(r, rot, g);
      const b = depthOfRect(vr, DepthBias.Building);
      for (const c of ring(r)) {
        const vc = cellToView(c, rot, g);
        const rel = relationToRect(vc, vr);
        const a = depthOfCell(vc, DepthBias.Actor);
        if (rel === 'front') expect(a).toBeGreaterThan(b);
        if (rel === 'behind') expect(a).toBeLessThan(b);
      }
    }
  });

  it('同格按 bias：角色 > 建筑 > 路面物件 > 标记 > 地面', () => {
    const c = { x: 3, y: 3 };
    const order = [
      DepthBias.Ground,
      DepthBias.Marker,
      DepthBias.RoadObject,
      DepthBias.Building,
      DepthBias.Actor,
      DepthBias.Fx,
    ];
    const ds = order.map((b) => depthOfCell(c, b));
    expect([...ds].sort((a, b) => a - b)).toEqual(ds);
  });

  it('行走中取起点与终点的较大值', () => {
    const a = { x: 2, y: 2 };
    const b = { x: 3, y: 2 };
    expect(depthOfMove(a, b, DepthBias.Actor)).toBe(depthOfCell(b, DepthBias.Actor));
    expect(depthOfMove(b, a, DepthBias.Actor)).toBe(depthOfCell(b, DepthBias.Actor));
  });

  it('x 稳定偏移不会跨越 bias 档', () => {
    const d1 = depthOfCell({ x: 1000, y: 0 }, DepthBias.Building);
    const d2 = depthOfCell({ x: 0, y: 1000 }, DepthBias.Actor);
    expect(d2).toBeGreaterThan(d1);
  });
});
