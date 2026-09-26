import { toRect } from '../overrides';
import { applyRectOverride, type PlaceCtx } from './placeFacilities';
import { pickRect, rectsAround } from './rects';
import { type Cell, dist2, type Rect, rectCenter, roundHalfUp, type Vec } from './types';

/**
 * 地标（data-pipeline.md §8.2 第 5、7 步）。
 * - 关押地标（医院、监狱）2×2，必须与 holdTile 4-相邻；放不下退为 1×1（warn）。
 * - 风景地标默认 2×2，从世界坐标所在格出发按 Chebyshev 环螺旋搜索空闲矩形，找不到就降为 1×1。
 */

export interface LandmarkItem {
  id: string;
  want: Vec;
  holdTile?: number | undefined;
}

export interface LandmarkOverride {
  rect?: readonly [number, number, number, number] | undefined;
}

export const SCENERY_SEARCH_RADIUS = 12;

export function placeHoldLandmarks(
  items: readonly LandmarkItem[],
  overrides: Readonly<Record<string, LandmarkOverride>>,
  ctx: PlaceCtx,
): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const it of items) {
    if (it.holdTile === undefined) continue;
    const hold = ctx.cells.get(it.holdTile);
    if (!hold) continue;
    const ov = overrides[it.id];
    if (ov?.rect) {
      const r = toRect(ov.rect);
      if (applyRectOverride(`landmark ${it.id}`, r, [hold], ctx, 1)) {
        ctx.occ.claimRect(r, { kind: 'landmark', id: it.id });
        out.set(it.id, r);
      }
      continue;
    }
    let placed: Rect | null = null;
    for (const [w, h] of [
      [2, 2],
      [1, 1],
    ] as const) {
      placed = pickRect(rectsAround([hold], w, h), ctx.occ, { want: it.want, avoid: ctx.avoid });
      if (placed) {
        if (w === 1) {
          ctx.issues.add('W_LOT_SHRUNK', 'warn', `关押地标 ${it.id} 放不下 2×2，退为 1×1`, { tiles: [it.holdTile] });
        }
        break;
      }
    }
    if (!placed) {
      ctx.issues.add('E_LOT_NO_CELL', 'error', `关押地标 ${it.id} 无法与关押格 ${it.holdTile} 相邻，需要 override`, {
        tiles: [it.holdTile],
      });
      continue;
    }
    ctx.occ.claimRect(placed, { kind: 'landmark', id: it.id });
    out.set(it.id, placed);
  }
  return out;
}

/** 以 want 为中心、Chebyshev 半径 r 的环上的矩形原点（按 y、x 升序）。 */
function ring(center: Cell, r: number): Cell[] {
  const out: Cell[] = [];
  for (let y = center.y - r; y <= center.y + r; y++) {
    for (let x = center.x - r; x <= center.x + r; x++) {
      if (Math.max(Math.abs(x - center.x), Math.abs(y - center.y)) === r) out.push({ x, y });
    }
  }
  return out;
}

export function placeScenery(
  items: readonly LandmarkItem[],
  overrides: Readonly<Record<string, LandmarkOverride>>,
  ctx: PlaceCtx,
): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const it of items) {
    if (it.holdTile !== undefined) continue;
    const ov = overrides[it.id];
    if (ov?.rect) {
      const r = toRect(ov.rect);
      if (ctx.occ.rectFree(r)) {
        ctx.occ.claimRect(r, { kind: 'landmark', id: it.id });
        out.set(it.id, r);
      } else {
        ctx.issues.add('E_OVERRIDE_RECT', 'error', `landmark ${it.id} 的 override rect 被占用`, {
          cells: [{ x: r.x, y: r.y }],
        });
      }
      continue;
    }
    let placed: Rect | null = null;
    for (const [w, h] of [
      [2, 2],
      [1, 1],
    ] as const) {
      const origin = { x: roundHalfUp(it.want.x - (w - 1) / 2), y: roundHalfUp(it.want.y - (h - 1) / 2) };
      for (let r = 0; r <= SCENERY_SEARCH_RADIUS && !placed; r++) {
        let best: Rect | null = null;
        let bestD = Number.POSITIVE_INFINITY;
        for (const o of ring(origin, r)) {
          const rect = { x: o.x, y: o.y, w, h };
          if (!ctx.occ.rectFree(rect)) continue;
          const d = dist2(rectCenter(rect), it.want);
          if (d < bestD - 1e-9) {
            best = rect;
            bestD = d;
          }
        }
        placed = best;
      }
      if (placed) {
        if (w === 1) ctx.issues.add('I_SCENERY_1X1', 'info', `风景地标 ${it.id} 附近放不下 2×2，降为 1×1`);
        break;
      }
    }
    if (!placed) {
      ctx.issues.add('E_LOT_NO_CELL', 'error', `风景地标 ${it.id} 在半径 ${SCENERY_SEARCH_RADIUS} 内找不到空位`);
      continue;
    }
    ctx.occ.claimRect(placed, { kind: 'landmark', id: it.id });
    out.set(it.id, placed);
  }
  return out;
}
