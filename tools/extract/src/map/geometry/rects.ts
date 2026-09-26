import { isAdjacentToRect } from '@rich4/shared/data';
import { type Cell, ck, dist2, type Occupancy, type Rect, rectCells, rectCenter, type Vec } from './types';

/** 所有尺寸为 w×h、与 fronts 中至少 minAdj 个格 4-相邻、且不压住任何 front 的矩形（未检查占用）。 */
export function rectsAround(fronts: readonly Cell[], w: number, h: number, minAdj = fronts.length): Rect[] {
  if (fronts.length === 0) return [];
  const xs = fronts.map((c) => c.x);
  const ys = fronts.map((c) => c.y);
  const out: Rect[] = [];
  for (let y = Math.min(...ys) - h; y <= Math.max(...ys) + 1; y++) {
    for (let x = Math.min(...xs) - w; x <= Math.max(...xs) + 1; x++) {
      const r = { x, y, w, h };
      if (adjacentCount(fronts, r) >= minAdj) out.push(r);
    }
  }
  return out;
}

export function adjacentCount(fronts: readonly Cell[], r: Rect): number {
  return fronts.filter((c) => isAdjacentToRect(c, r)).length;
}

export interface RectScoreOptions {
  want: Vec;
  /** 软约束：矩形压到这些格时每格加罚 */
  avoid: ReadonlySet<string>;
  avoidWeight?: number;
  /** 面积偏离 prefArea 的罚分系数 */
  areaWeight?: number;
  prefArea?: number;
}

export function rectCost(r: Rect, o: RectScoreOptions): number {
  const d = Math.sqrt(dist2(rectCenter(r), o.want));
  const hits = rectCells(r).filter((c) => o.avoid.has(ck(c))).length;
  const area = r.w * r.h;
  return d + hits * (o.avoidWeight ?? 2) + Math.abs(area - (o.prefArea ?? area)) * (o.areaWeight ?? 0);
}

/** 取代价最小的空闲矩形；平手按 (y, x, h, w) 定序。 */
export function pickRect(cands: readonly Rect[], occ: Occupancy, o: RectScoreOptions): Rect | null {
  let best: Rect | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const r of cands) {
    if (!occ.rectFree(r)) continue;
    const c = rectCost(r, o);
    if (
      best === null ||
      c < bestCost - 1e-9 ||
      (Math.abs(c - bestCost) <= 1e-9 && (r.y - best.y || r.x - best.x || r.h - best.h || r.w - best.w) < 0)
    ) {
      best = r;
      bestCost = c;
    }
  }
  return best;
}

export function rectToTuple(r: Rect): [number, number, number, number] {
  return [r.x, r.y, r.w, r.h];
}
