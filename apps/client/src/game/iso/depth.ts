// 等角深度排序（design/client.md §3.2）。所有输入都是「视图网格」坐标（已按旋转变换）。
// 规则：depth = (x + y) × STRIDE + bias；建筑取 footprint 中 max(x+y)；行走中的角色取起点与终点的较大值；
// 同深度按 bias（角色压过建筑），再按 x 做微小的稳定偏移。
// 前提：footprint 为矩形且每边不超过 2 格、角色只走 4-相邻路格（含 via 连接格）。
// 在此前提下对 8 邻域与 2×2 footprint 的外圈都正确（见 depth.test.ts）；更大的矩形需要拓扑排序。
import type { Cell, Rect } from '@rich4/shared/data';

export const DepthBias = {
  Ground: 0,
  Marker: 1,
  RoadObject: 2,
  Building: 3,
  Actor: 4,
  Fx: 5,
} as const;
export type DepthBias = (typeof DepthBias)[keyof typeof DepthBias];

export const DEPTH_STRIDE = 8;
/** x 方向稳定偏移的比例：网格最多 1024 格时仍小于 1（不会跨越 bias 档） */
const X_TIEBREAK = 1 / 1024;

export function depthOf(vx: number, vy: number, bias: DepthBias): number {
  return (vx + vy) * DEPTH_STRIDE + bias + vx * X_TIEBREAK;
}

export function depthOfCell(c: Cell, bias: DepthBias): number {
  return depthOf(c.x, c.y, bias);
}

/** 矩形 footprint：取最靠前（x+y 最大）的格 */
export function depthOfRect(r: Rect, bias: DepthBias): number {
  return depthOf(r.x + r.w - 1, r.y + r.h - 1, bias);
}

/** 行走中：起点格与终点格深度的较大值，防止跨格时跳层 */
export function depthOfMove(from: Cell, to: Cell, bias: DepthBias): number {
  return Math.max(depthOfCell(from, bias), depthOfCell(to, bias));
}

/**
 * 对「格上的点对象」与「矩形 footprint」判断谁在前（几何真值，供测试与调试断言）：
 * 返回 'front'（对象在建筑之前）、'behind'（之后）或 'side'（屏幕上不重叠，任意顺序皆可）。
 */
export function relationToRect(c: Cell, r: Rect): 'front' | 'behind' | 'side' | 'inside' {
  const maxX = r.x + r.w - 1;
  const maxY = r.y + r.h - 1;
  const inX = c.x >= r.x && c.x <= maxX;
  const inY = c.y >= r.y && c.y <= maxY;
  if (inX && inY) return 'inside';
  const front = c.x > maxX || c.y > maxY;
  const behind = c.x < r.x || c.y < r.y;
  if (front && !behind) return 'front';
  if (behind && !front) return 'behind';
  return 'side';
}
