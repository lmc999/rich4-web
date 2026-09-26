// 等角挤出几何（design/client.md §3.5）：盒子三面、屋顶、窗格。
// 局部坐标：原点 = footprint 中心的地面点；视图网格 +x→屏幕 SE、+y→SW；z 为像素高度（向上）。
// 纯函数返回点集（可单测），draw* 系列把点集画进 Pixi Graphics（只用类型，不在 node 下实例化）。
import type { Graphics } from 'pixi.js';
import { HALF_H, HALF_W, type Pt } from '../../iso/projection';
import { INK, OUTLINE } from './styles';

/** 局部 3D 点（x、y 以格为单位，相对 footprint 中心；z 为像素） → 屏幕 */
export function iso3(x: number, y: number, z = 0): Pt {
  return { x: (x - y) * HALF_W, y: (x + y) * HALF_H - z };
}

export interface BoxFaces {
  /** 顶面 N,E,S,W */
  top: Pt[];
  /** 左面（朝 SW，即 +y 侧） */
  left: Pt[];
  /** 右面（朝 SE，即 +x 侧） */
  right: Pt[];
}

/** w×d 格（已扣除内缩）的盒子，底面在 z0，高 h 像素 */
export function boxFaces(w: number, d: number, h: number, z0 = 0): BoxFaces {
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const y1 = d / 2;
  const zt = z0 + h;
  return {
    top: [iso3(x0, y0, zt), iso3(x1, y0, zt), iso3(x1, y1, zt), iso3(x0, y1, zt)],
    left: [iso3(x0, y1, z0), iso3(x1, y1, z0), iso3(x1, y1, zt), iso3(x0, y1, zt)],
    right: [iso3(x1, y1, z0), iso3(x1, y0, z0), iso3(x1, y0, zt), iso3(x1, y1, zt)],
  };
}

/** 面上的点：面由底边 a→b 与高度区间 [z0,z1] 定义，u 沿底边、v 向上（0..1） */
export interface FaceFrame {
  a: Pt;
  b: Pt;
  z0: number;
  z1: number;
}

export function leftFaceFrame(w: number, d: number, z0: number, z1: number): FaceFrame {
  return { a: iso3(-w / 2, d / 2), b: iso3(w / 2, d / 2), z0, z1 };
}

export function rightFaceFrame(w: number, d: number, z0: number, z1: number): FaceFrame {
  return { a: iso3(w / 2, d / 2), b: iso3(w / 2, -d / 2), z0, z1 };
}

export function facePoint(f: FaceFrame, u: number, v: number): Pt {
  const z = f.z0 + (f.z1 - f.z0) * v;
  return { x: f.a.x + (f.b.x - f.a.x) * u, y: f.a.y + (f.b.y - f.a.y) * u - z };
}

export function faceQuad(f: FaceFrame, u0: number, v0: number, u1: number, v1: number): Pt[] {
  return [facePoint(f, u0, v0), facePoint(f, u1, v0), facePoint(f, u1, v1), facePoint(f, u0, v1)];
}

/** 颜色明暗：factor<1 变暗，>1 变亮（夹在 0..255） */
export function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 255) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 255) * factor));
  const b = Math.min(255, Math.round((color & 255) * factor));
  return (r << 16) | (g << 8) | b;
}

/** 顶面 100%、左面 85%、右面 70%（光源在左上） */
export const FACE_SHADE = { top: 1, left: 0.85, right: 0.7 } as const;

export function flat(points: readonly Pt[]): number[] {
  return points.flatMap((p) => [p.x, p.y]);
}

// ───────────────────────── 绘制 ─────────────────────────

export interface Stroke {
  width: number;
  color: number;
}

export const INK_STROKE: Stroke = { width: OUTLINE, color: INK };

export function fillPoly(g: Graphics, pts: readonly Pt[], color: number, stroke: Stroke | null = INK_STROKE): void {
  g.poly(flat(pts), true).fill(color);
  if (stroke) g.stroke({ ...stroke, join: 'round' });
}

/** 画盒子三面；返回顶面高度 */
export function drawBox(
  g: Graphics,
  w: number,
  d: number,
  h: number,
  color: number,
  o: { z0?: number; top?: number; stroke?: Stroke | null } = {},
): number {
  const z0 = o.z0 ?? 0;
  const f = boxFaces(w, d, h, z0);
  const stroke = o.stroke === undefined ? INK_STROKE : o.stroke;
  fillPoly(g, f.left, shade(color, FACE_SHADE.left), stroke);
  fillPoly(g, f.right, shade(color, FACE_SHADE.right), stroke);
  fillPoly(g, f.top, o.top ?? shade(color, FACE_SHADE.top), stroke);
  return z0 + h;
}

/** 坡屋顶：屋脊沿视图 x 轴，高 rise 像素，屋檐外挑 eave 格 */
export function drawGableRoof(
  g: Graphics,
  w: number,
  d: number,
  zBase: number,
  rise: number,
  color: number,
  eave = 0.06,
): void {
  const x0 = -w / 2 - eave;
  const x1 = w / 2 + eave;
  const y0 = -d / 2 - eave;
  const y1 = d / 2 + eave;
  const zr = zBase + rise;
  // 背坡（朝 NE）、山墙（朝 SE）、前坡（朝 SW）
  fillPoly(g, [iso3(x0, y0, zBase), iso3(x1, y0, zBase), iso3(x1, 0, zr), iso3(x0, 0, zr)], shade(color, 0.95));
  fillPoly(g, [iso3(w / 2, -d / 2, zBase), iso3(w / 2, d / 2, zBase), iso3(w / 2, 0, zr)], shade(color, 0.62));
  fillPoly(g, [iso3(x0, 0, zr), iso3(x1, 0, zr), iso3(x1, y1, zBase), iso3(x0, y1, zBase)], shade(color, 0.82));
}

/** 平顶女儿墙：顶面内缩一圈的浅色方块 */
export function drawParapet(g: Graphics, w: number, d: number, zTop: number, color: number): void {
  const m = Math.min(w, d) * 0.1;
  const f = boxFaces(w - m * 2, d - m * 2, 0, zTop);
  fillPoly(g, f.top, shade(color, 0.9), { width: 2, color: INK });
}

/** 穹顶：以顶面中心为圆心的半球（椭圆底 + 半圆） */
export function drawDome(g: Graphics, cx: number, cy: number, zTop: number, r: number, color: number): void {
  const base = iso3(cx, cy, zTop);
  const rx = r * HALF_W;
  const ry = r * HALF_H;
  g.ellipse(base.x, base.y, rx, ry).fill(shade(color, 0.8)).stroke({ width: 2, color: INK });
  g.moveTo(base.x - rx, base.y)
    .arc(base.x, base.y, rx, Math.PI, 0)
    .closePath()
    .fill(color)
    .stroke({ width: OUTLINE, color: INK, join: 'round' });
  // 高光
  g.ellipse(base.x - rx * 0.35, base.y - rx * 0.55, rx * 0.18, rx * 0.12).fill({ color: 0xffffff, alpha: 0.7 });
}

/** 尖塔 / 天线 */
export function drawSpire(g: Graphics, zTop: number, height: number, color: number, tip = true): void {
  const a = iso3(0, 0, zTop);
  const b = iso3(0, 0, zTop + height);
  g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 3, color: INK, cap: 'round' });
  if (tip) g.circle(b.x, b.y, 4).fill(color).stroke({ width: 2, color: INK });
}

/** 在面上按 floors × cols 排窗 */
export function drawWindows(
  g: Graphics,
  f: FaceFrame,
  floors: number,
  cols: number,
  color: number,
  o: { skipDoor?: boolean; lit?: number; litEvery?: number } = {},
): void {
  if (floors <= 0 || cols <= 0) return;
  const du = 1 / cols;
  const dv = 1 / floors;
  let i = 0;
  for (let fl = 0; fl < floors; fl++) {
    for (let c = 0; c < cols; c++, i++) {
      if (o.skipDoor && fl === 0 && c === 0) continue;
      const u0 = c * du + du * 0.25;
      const u1 = (c + 1) * du - du * 0.25;
      const v0 = fl * dv + dv * 0.28;
      const v1 = (fl + 1) * dv - dv * 0.22;
      const lit = o.lit !== undefined && o.litEvery !== undefined && i % o.litEvery === 1;
      fillPoly(g, faceQuad(f, u0, v0, u1, v1), lit ? (o.lit ?? color) : color, { width: 1.5, color: INK });
    }
  }
}

/** 门：面上第一列底部 */
export function drawDoor(g: Graphics, f: FaceFrame, floors: number, cols: number, color: number): void {
  const du = 1 / Math.max(1, cols);
  const dv = 1 / Math.max(1, floors);
  fillPoly(g, faceQuad(f, du * 0.22, 0, du * 0.78, dv * 0.72), color, { width: 2, color: INK });
}
