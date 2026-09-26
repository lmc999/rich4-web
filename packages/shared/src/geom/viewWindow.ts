/** 世界坐标点（与 data/maps 的 World 结构相同；geom 只依赖 util，故单独声明） */
export interface WorldPoint {
  x: number;
  y: number;
}

/** 原版 440×440 屏幕视窗的一半（DEV-04） */
export const VIEW_WINDOW_HALF = 220;

/**
 * v1 世界坐标方窗：-half ≤ d < half（半开区间）。
 * 引擎计算卡片/道具目标候选与 AI 视野共用这一个实现（architecture §7.2）。
 */
export function inViewWindow(center: WorldPoint, p: WorldPoint, half: number = VIEW_WINDOW_HALF): boolean {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return dx >= -half && dx < half && dy >= -half && dy < half;
}
