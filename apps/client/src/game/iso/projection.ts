// 等角投影与 4 方向旋转（design/client.md §3.2；architecture §16.4）。
// 三套坐标：
//   逻辑网格（MapDef.cell）：+x 为默认视角下屏幕 SE，+y 为 SW；cell (x,y) 覆盖 [x,x+1]×[y,y+1]
//   视图网格：逻辑网格按当前旋转 rot 转 rot×90° 后的网格（连续坐标）；深度排序与投影都用它
//   屏幕（world 容器本地像素）：2:1 dimetric，TILE_W×TILE_H 的菱形
// 旋转一步 R：连续点 (x,y) → (h - y, x)，网格 (w,h) → (h,w)；方向 (dx,dy) → (-dy,dx)，
// 即 NE→SE→SW→NW→NE（棋盘在屏幕上顺时针转 90°）。
import type { Cell, Rect } from '@rich4/shared/data';

export const TILE_W = 128;
export const TILE_H = 64;
export const HALF_W = TILE_W / 2;
export const HALF_H = TILE_H / 2;
/** 每层楼高度（像素） */
export const Z_UNIT = 24;

export type Rotation = 0 | 1 | 2 | 3;
export const ROTATIONS: readonly Rotation[] = [0, 1, 2, 3];

export interface Pt {
  x: number;
  y: number;
}

export interface GridSize {
  w: number;
  h: number;
}

export function normRotation(r: number): Rotation {
  return (((r % 4) + 4) % 4) as Rotation;
}

/** 旋转后的视图网格尺寸 */
export function viewGrid(g: GridSize, rot: Rotation): GridSize {
  return rot % 2 === 0 ? { w: g.w, h: g.h } : { w: g.h, h: g.w };
}

/** 逻辑连续坐标 → 视图连续坐标 */
export function toView(p: Pt, rot: Rotation, g: GridSize): Pt {
  switch (rot) {
    case 0:
      return { x: p.x, y: p.y };
    case 1:
      return { x: g.h - p.y, y: p.x };
    case 2:
      return { x: g.w - p.x, y: g.h - p.y };
    case 3:
      return { x: p.y, y: g.w - p.x };
  }
}

/** 视图连续坐标 → 逻辑连续坐标（toView 的逆） */
export function fromView(p: Pt, rot: Rotation, g: GridSize): Pt {
  switch (rot) {
    case 0:
      return { x: p.x, y: p.y };
    case 1:
      return { x: p.y, y: g.h - p.x };
    case 2:
      return { x: g.w - p.x, y: g.h - p.y };
    case 3:
      return { x: g.w - p.y, y: p.x };
  }
}

/** 整数格：逻辑 cell → 视图 cell（按格中心旋转） */
export function cellToView(c: Cell, rot: Rotation, g: GridSize): Cell {
  const v = toView({ x: c.x + 0.5, y: c.y + 0.5 }, rot, g);
  return { x: Math.floor(v.x), y: Math.floor(v.y) };
}

/** 整数格：视图 cell → 逻辑 cell */
export function cellFromView(c: Cell, rot: Rotation, g: GridSize): Cell {
  const v = fromView({ x: c.x + 0.5, y: c.y + 0.5 }, rot, g);
  return { x: Math.floor(v.x), y: Math.floor(v.y) };
}

/** 逻辑矩形 → 视图矩形（仍为轴对齐整数矩形，90° 时宽高互换） */
export function rectToView(r: Rect, rot: Rotation, g: GridSize): Rect {
  const a = toView({ x: r.x, y: r.y }, rot, g);
  const b = toView({ x: r.x + r.w, y: r.y + r.h }, rot, g);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** 逻辑方向向量 → 视图方向向量 */
export function rotateDir(d: Pt, rot: Rotation): Pt {
  switch (rot) {
    case 0:
      return { x: d.x, y: d.y };
    case 1:
      return { x: -d.y, y: d.x };
    case 2:
      return { x: -d.x, y: -d.y };
    case 3:
      return { x: d.y, y: -d.x };
  }
}

/** 视图网格连续坐标 → 屏幕像素（z 为楼层数，可为小数） */
export function isoToScreen(vx: number, vy: number, z = 0): Pt {
  return { x: (vx - vy) * HALF_W, y: (vx + vy) * HALF_H - z * Z_UNIT };
}

/** 屏幕像素（地面 z=0）→ 视图网格连续坐标 */
export function screenToIso(sx: number, sy: number): Pt {
  const a = sx / HALF_W;
  const b = sy / HALF_H;
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** 逻辑连续坐标 → 屏幕像素 */
export function logicalToScreen(p: Pt, rot: Rotation, g: GridSize, z = 0): Pt {
  const v = toView(p, rot, g);
  return isoToScreen(v.x, v.y, z);
}

/** 屏幕像素 → 逻辑连续坐标 */
export function screenToLogical(sx: number, sy: number, rot: Rotation, g: GridSize): Pt {
  return fromView(screenToIso(sx, sy), rot, g);
}

/** 逻辑 cell 中心的屏幕坐标 */
export function cellCenterScreen(c: Cell, rot: Rotation, g: GridSize): Pt {
  return logicalToScreen({ x: c.x + 0.5, y: c.y + 0.5 }, rot, g);
}

/** 屏幕像素 → 逻辑 cell（向下取整；可能落在网格外，由调用方判断） */
export function screenToCell(sx: number, sy: number, rot: Rotation, g: GridSize): Cell {
  const p = screenToLogical(sx, sy, rot, g);
  return { x: Math.floor(p.x), y: Math.floor(p.y) };
}

/** 视图 cell 的菱形 4 角（N、E、S、W 顺序，屏幕像素），可直接作 hitArea 的 Polygon 点集 */
export function diamondPoints(vx: number, vy: number, inset = 0): number[] {
  const n = isoToScreen(vx + inset, vy + inset);
  const e = isoToScreen(vx + 1 - inset, vy + inset);
  const s = isoToScreen(vx + 1 - inset, vy + 1 - inset);
  const w = isoToScreen(vx + inset, vy + 1 - inset);
  return [n.x, n.y, e.x, e.y, s.x, s.y, w.x, w.y];
}

/** 视图网格整体的屏幕包围盒 */
export function gridScreenBounds(g: GridSize, rot: Rotation): { x: number; y: number; w: number; h: number } {
  const v = viewGrid(g, rot);
  const left = isoToScreen(0, v.h).x;
  const right = isoToScreen(v.w, 0).x;
  const bottom = isoToScreen(v.w, v.h).y;
  return { x: left, y: 0, w: right - left, h: bottom };
}

export type IsoDir = 'NE' | 'SE' | 'SW' | 'NW';

/** 视图方向（单位轴向） → 屏幕朝向：+x→SE，+y→SW，-x→NW，-y→NE；零向量视为 SE */
export function dirOfViewStep(dx: number, dy: number): IsoDir {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'SE' : 'NW';
  return dy > 0 ? 'SW' : 'NE';
}

/** 两个视图点之间的主方向 */
export function dirBetween(a: Pt, b: Pt): IsoDir {
  return dirOfViewStep(b.x - a.x, b.y - a.y);
}

/** 屏幕朝向 → 角色图的正/背面与是否镜像（正面图朝 SE，背面图朝 NE） */
export function facingOf(dir: IsoDir): { facing: 'front' | 'back'; mirror: boolean } {
  switch (dir) {
    case 'SE':
      return { facing: 'front', mirror: false };
    case 'SW':
      return { facing: 'front', mirror: true };
    case 'NE':
      return { facing: 'back', mirror: false };
    case 'NW':
      return { facing: 'back', mirror: true };
  }
}
