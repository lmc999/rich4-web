// 原版棋盘的投影（original-skin.md §5 A6；design-draft §3.2；render.md §1.2、§1.4、§2.1）。纯函数，不引入 Pixi。
//
// 原版世界坐标 = 2304×2304 正射底图的像素坐标（MapDef.tiles[].world 即是；fixture 为 cell×32）。
// 每个视角一个仿射（地图皮肤 projection.views，约定同 Pixi Matrix）：
//   棋盘坐标 x' = a·x + c·y + tx，y' = b·x + d·y + ty（单位：源像素；view+1 画面顺时针转 45°）。
// 「棋盘坐标」就是 world 容器的本地坐标：镜头（Camera）以源像素为单位缩放与平移，1:1 时一个源像素 = 一个 CSS 像素。
// 地面切块放在同一个容器里套这个仿射（连续变换）；精灵、角色的落点按源像素取整（projectPx），
// 所以「精灵锚点相对它脚下底图」的误差不超过取整的 0.71 px（original-skin.md §3 审查修正：相对误差 ≤ 2 px）。
//
// 另附原版逐格精确表模型（OrigExactModel，地图皮肤 projection.exact）：测试用它度量原版自身的相对误差，
// 日后「精确模式」（29×29 顶点 Mesh）也从这里取值。
import type { Affine, ExactTables } from '@rich4/shared/assets';
import { EXACT_TABLE_SPAN, rotateView, VIEW_COUNT } from '@rich4/shared/assets';
import type { WorldRect } from '../camera/Camera';
import type { Pt } from '../iso/projection';

/** 一个视角的仿射（地图皮肤 AffineSchema 去掉 maxErrPx） */
export type ViewAffine = Pick<Affine, 'a' | 'b' | 'c' | 'd' | 'tx' | 'ty'>;

/** 地图皮肤里投影需要的部分 */
export interface ProjectionSource {
  world: { w: number; h: number };
  projection: { views: readonly ViewAffine[]; initialView: number };
}

export function normView(v: number): number {
  return rotateView(Math.trunc(v), 0);
}

export class OrigProjection {
  private v: number;

  constructor(
    readonly views: readonly ViewAffine[],
    readonly world: { w: number; h: number },
    initialView = 0,
  ) {
    if (views.length !== VIEW_COUNT)
      throw new RangeError(`OrigProjection 需要 ${VIEW_COUNT} 个视角，得到 ${views.length}`);
    for (const [i, m] of views.entries()) {
      if (!(Math.abs(m.a * m.d - m.b * m.c) > 1e-9)) throw new RangeError(`视角 ${i} 的仿射不可逆`);
    }
    this.v = normView(initialView);
  }

  static fromSkin(s: ProjectionSource): OrigProjection {
    return new OrigProjection(s.projection.views, s.world, s.projection.initialView);
  }

  /** 当前视角 0..7 */
  get view(): number {
    return this.v;
  }

  set view(v: number) {
    this.v = normView(v);
  }

  /** 旋转 step 档（每档 45°）；返回新视角 */
  rotate(step: number): number {
    this.v = rotateView(this.v, Math.trunc(step));
    return this.v;
  }

  affine(view = this.v): ViewAffine {
    return this.views[normView(view)]!;
  }

  /** 世界 → 棋盘坐标（浮点） */
  project(w: Pt, view = this.v): Pt {
    const m = this.affine(view);
    return { x: m.a * w.x + m.c * w.y + m.tx, y: m.b * w.x + m.d * w.y + m.ty };
  }

  /** 世界 → 棋盘坐标，按源像素取整（精灵、角色的落点） */
  projectPx(w: Pt, view = this.v): Pt {
    const p = this.project(w, view);
    return { x: snapPx(p.x), y: snapPx(p.y) };
  }

  /** 世界位移 → 棋盘位移（不含常数项） */
  projectDelta(dx: number, dy: number, view = this.v): Pt {
    const m = this.affine(view);
    return { x: m.a * dx + m.c * dy, y: m.b * dx + m.d * dy };
  }

  /** 棋盘坐标 → 世界（拾取、镜头换视角时保持对准同一个世界点） */
  unproject(p: Pt, view = this.v): Pt {
    const m = this.affine(view);
    const x = p.x - m.tx;
    const y = p.y - m.ty;
    const det = m.a * m.d - m.b * m.c;
    return { x: (m.d * x - m.c * y) / det, y: (-m.b * x + m.a * y) / det };
  }

  /** 世界矩形（缺省整张地图）四角投影后的包围盒（棋盘坐标） */
  bounds(rect: WorldRect = { x: 0, y: 0, w: this.world.w, h: this.world.h }, view = this.v): WorldRect {
    const pts = [
      this.project({ x: rect.x, y: rect.y }, view),
      this.project({ x: rect.x + rect.w, y: rect.y }, view),
      this.project({ x: rect.x + rect.w, y: rect.y + rect.h }, view),
      this.project({ x: rect.x, y: rect.y + rect.h }, view),
    ];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  /** 世界矩形（四角）投影后的四边形（棋盘坐标，顺序 左上 右上 右下 左下 的世界角） */
  quad(rect: WorldRect, view = this.v): Pt[] {
    return [
      this.project({ x: rect.x, y: rect.y }, view),
      this.project({ x: rect.x + rect.w, y: rect.y }, view),
      this.project({ x: rect.x + rect.w, y: rect.y + rect.h }, view),
      this.project({ x: rect.x, y: rect.y + rect.h }, view),
    ];
  }
}

/** 源像素取整（-0 归一为 0） */
export function snapPx(v: number): number {
  const r = Math.round(v);
  return r === 0 ? 0 : r;
}

// ───────────────────────── 原版逐格精确表（render.md §1.2、§2.1） ─────────────────────────

const HALF_SPAN = (EXACT_TABLE_SPAN - 1) / 2;

/**
 * 原版的精确投影模型：棋盘视窗内屏幕 = (220,260) + o(镜头) − o(物体) + T[view][dy][dx]，
 * T 为 (sy, sx)、dy 在外层；o 为亚格偏移（fx=x&31、fy=y&31，每个乘积各自算术右移 5 位）。
 * 地面：每格四角 T(dx,dy)…T(dx,dy+1) 加基准点，纹理坐标 0..31 按扫描线线性插值（这里取双线性近似）。
 */
export class OrigExactModel {
  constructor(
    private readonly exact: Pick<ExactTables, 'cellScreen' | 'subcell'>,
    readonly origin: Pt = { x: 220, y: 260 },
  ) {}

  /** T[view][dy][dx]；格差超出 ±14 返回 null */
  cell(view: number, dx: number, dy: number): Pt | null {
    if (Math.abs(dx) > HALF_SPAN || Math.abs(dy) > HALF_SPAN) return null;
    const i = ((normView(view) * EXACT_TABLE_SPAN + (dy + HALF_SPAN)) * EXACT_TABLE_SPAN + (dx + HALF_SPAN)) * 2;
    return { x: this.exact.cellScreen[i + 1]!, y: this.exact.cellScreen[i]! };
  }

  /** 亚格偏移 (o1, o2)：原版在物体一侧做减法、镜头一侧做加法 */
  subcell(view: number, w: Pt): Pt {
    const k = normView(view) * 4;
    const m = this.exact.subcell;
    const fx = Math.trunc(w.x) & 31;
    const fy = Math.trunc(w.y) & 31;
    const o1 = ((m[k]! * fx) >> 5) + ((m[k + 2]! * fy) >> 5);
    const o2 = ((m[k + 1]! * fx) >> 5) + ((m[k + 3]! * fy) >> 5);
    return { x: o1, y: o2 };
  }

  private base(view: number, cam: Pt): Pt {
    const o = this.subcell(view, cam);
    return { x: this.origin.x + o.x, y: this.origin.y + o.y };
  }

  /** 物体（精灵锚点）的屏幕位置；超出 ±14 格返回 null */
  objectScreen(view: number, cam: Pt, obj: Pt): Pt | null {
    const dx = (Math.trunc(obj.x) >> 5) - (Math.trunc(cam.x) >> 5);
    const dy = (Math.trunc(obj.y) >> 5) - (Math.trunc(cam.y) >> 5);
    const t = this.cell(view, dx, dy);
    if (!t) return null;
    const b = this.base(view, cam);
    const o = this.subcell(view, obj);
    return { x: b.x + t.x - o.x, y: b.y + t.y - o.y };
  }

  /** 底图上世界点 w（纹素）的屏幕位置：所在格四角按 (fx/31, fy/31) 双线性插值；超出范围返回 null */
  groundScreen(view: number, cam: Pt, w: Pt): Pt | null {
    const dx = (Math.trunc(w.x) >> 5) - (Math.trunc(cam.x) >> 5);
    const dy = (Math.trunc(w.y) >> 5) - (Math.trunc(cam.y) >> 5);
    const p0 = this.cell(view, dx, dy);
    const p1 = this.cell(view, dx + 1, dy);
    const p2 = this.cell(view, dx + 1, dy + 1);
    const p3 = this.cell(view, dx, dy + 1);
    if (!p0 || !p1 || !p2 || !p3) return null;
    const u = (Math.trunc(w.x) & 31) / 31;
    const v = (Math.trunc(w.y) & 31) / 31;
    const b = this.base(view, cam);
    const top = { x: p0.x + (p1.x - p0.x) * u, y: p0.y + (p1.y - p0.y) * u };
    const bot = { x: p3.x + (p2.x - p3.x) * u, y: p3.y + (p2.y - p3.y) * u };
    return { x: b.x + top.x + (bot.x - top.x) * v, y: b.y + top.y + (bot.y - top.y) * v };
  }
}

/** 仿射模型下「精灵锚点相对它脚下底图」的误差：取整落点 − 连续仿射（本渲染器的相对误差） */
export function affineRelativeError(proj: OrigProjection, w: Pt, view = proj.view): number {
  const cont = proj.project(w, view);
  const px = proj.projectPx(w, view);
  return Math.hypot(px.x - cont.x, px.y - cont.y);
}
