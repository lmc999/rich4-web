import { toRect } from '../overrides';
import { adjacentCount, pickRect, rectsAround } from './rects';
import type { Cell, GeoIssues, Occupancy, Rect, Vec } from './types';

/**
 * 设施 2×2（data-pipeline.md §8.2 第 3 步）：两个前沿格应 4-相邻且共线；在共线段两侧各有一个 2×2 候选，
 * 选中心离设施世界坐标最近且全部空闲的一侧。side override：横向一对 a=上侧(−y)、b=下侧；纵向一对 a=左侧(−x)、b=右侧。
 * 2×2 都不行时依次退到 2×1、1×2、1×1（warn）；仍不行报 E_LOT_NO_CELL（error）。
 */

export interface RectItem {
  id: string;
  fronts: number[];
  want: Vec;
}

export interface RectOverride {
  side?: 'a' | 'b' | undefined;
  rect?: readonly [number, number, number, number] | undefined;
}

export interface PlaceCtx {
  cells: ReadonlyMap<number, Cell>;
  occ: Occupancy;
  avoid: ReadonlySet<string>;
  issues: GeoIssues;
}

export const FACILITY_SIZES: readonly (readonly [number, number])[] = [
  [2, 2],
  [2, 1],
  [1, 2],
  [1, 1],
];

function sideOf(fronts: readonly Cell[], r: Rect): 'a' | 'b' | null {
  if (fronts.length !== 2) return null;
  const [p, q] = fronts as [Cell, Cell];
  if (p.y === q.y) return r.y + r.h - 1 < p.y ? 'a' : r.y > p.y ? 'b' : null;
  if (p.x === q.x) return r.x + r.w - 1 < p.x ? 'a' : r.x > p.x ? 'b' : null;
  return null;
}

/** 用 override 的 rect：必须空闲且与全部前沿格相邻，否则报 error。 */
export function applyRectOverride(
  id: string,
  rect: Rect,
  fronts: readonly Cell[],
  ctx: PlaceCtx,
  need: number,
): boolean {
  if (!ctx.occ.rectFree(rect) || adjacentCount(fronts, rect) < need) {
    ctx.issues.add('E_OVERRIDE_RECT', 'error', `${id} 的 override rect 被占用或不与前沿格相邻`, {
      cells: [{ x: rect.x, y: rect.y }],
    });
    return false;
  }
  return true;
}

export function placeFacilities(
  items: readonly RectItem[],
  overrides: Readonly<Record<string, RectOverride>>,
  ctx: PlaceCtx,
): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const it of items) {
    const fronts = it.fronts.map((id) => ctx.cells.get(id)).filter((c): c is Cell => c !== undefined);
    const ov = overrides[it.id];
    if (ov?.rect) {
      const r = toRect(ov.rect);
      if (applyRectOverride(it.id, r, fronts, ctx, fronts.length)) {
        ctx.occ.claimRect(r, { kind: 'lot', id: it.id });
        out.set(it.id, r);
      }
      continue;
    }
    const collinear =
      fronts.length === 2 && Math.abs(fronts[0]!.x - fronts[1]!.x) + Math.abs(fronts[0]!.y - fronts[1]!.y) === 1;
    if (!collinear) {
      ctx.issues.add('I_FACILITY_FRONTS', 'info', `设施 ${it.id} 的前沿格不是一对 4-相邻格，按一般矩形搜索`, {
        tiles: it.fronts,
      });
    }
    let placed: Rect | null = null;
    for (const [w, h] of FACILITY_SIZES) {
      let cands = rectsAround(fronts, w, h);
      if (ov?.side) cands = cands.filter((r) => sideOf(fronts, r) === ov.side);
      placed = pickRect(cands, ctx.occ, { want: it.want, avoid: ctx.avoid });
      if (placed) {
        if (w * h < 4) {
          ctx.issues.add('W_LOT_SHRUNK', 'warn', `设施 ${it.id} 放不下 2×2，退为 ${w}×${h}`, { tiles: it.fronts });
        }
        break;
      }
    }
    if (!placed) {
      ctx.issues.add(
        'E_LOT_NO_CELL',
        'error',
        `设施 ${it.id} 找不到与前沿格相邻的空闲矩形，需要 lot.${it.id} override`,
        {
          tiles: it.fronts,
        },
      );
      continue;
    }
    ctx.occ.claimRect(placed, { kind: 'lot', id: it.id });
    out.set(it.id, placed);
  }
  return out;
}
