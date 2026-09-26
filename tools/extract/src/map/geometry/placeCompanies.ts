import { toRect } from '../overrides';
import { applyRectOverride, type PlaceCtx, type RectItem, type RectOverride } from './placeFacilities';
import { adjacentCount, rectCost, rectsAround } from './rects';
import type { Cell, Rect } from './types';

/**
 * 企业（data-pipeline.md §8.2 第 4 步）：候选尺寸 2×2、3×2、2×3、3×3、1×1，要求与每个前沿格 4-相邻且全部空闲，
 * 取「与世界坐标的距离 + 面积惩罚」最小者。
 * 前沿格彼此相距太远、无法同时相邻时（台湾的大宇百貨：两个百貨公司格分处南北），改为与尽量多的前沿格相邻，
 * 其余前沿格记 W_COMPANY_REMOTE_FRONT（MapDef 契约的已知缺口，见报告）。
 */

export const COMPANY_SIZES: readonly (readonly [number, number])[] = [
  [2, 2],
  [3, 2],
  [2, 3],
  [3, 3],
  [1, 1],
];
const AREA_WEIGHT = 0.25;

export function placeCompanies(
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
      if (applyRectOverride(it.id, r, fronts, ctx, 1)) {
        ctx.occ.claimRect(r, { kind: 'lot', id: it.id });
        out.set(it.id, r);
        reportRemote(it, fronts, r, ctx);
      }
      continue;
    }
    let best: { r: Rect; adj: number; cost: number } | null = null;
    for (let need = fronts.length; need >= 1 && best === null; need--) {
      for (const [w, h] of COMPANY_SIZES) {
        for (const r of rectsAround(fronts, w, h, need)) {
          if (!ctx.occ.rectFree(r)) continue;
          const cost = rectCost(r, { want: it.want, avoid: ctx.avoid, areaWeight: AREA_WEIGHT, prefArea: 4 });
          const adj = adjacentCount(fronts, r);
          if (
            best === null ||
            adj > best.adj ||
            (adj === best.adj &&
              (cost < best.cost - 1e-9 ||
                (Math.abs(cost - best.cost) <= 1e-9 && (r.y - best.r.y || r.x - best.r.x || r.h - best.r.h) < 0)))
          ) {
            best = { r, adj, cost };
          }
        }
      }
    }
    if (!best) {
      ctx.issues.add(
        'E_LOT_NO_CELL',
        'error',
        `企业 ${it.id} 找不到与前沿格相邻的空闲矩形，需要 lot.${it.id} override`,
        {
          tiles: it.fronts,
        },
      );
      continue;
    }
    ctx.occ.claimRect(best.r, { kind: 'lot', id: it.id });
    out.set(it.id, best.r);
    reportRemote(it, fronts, best.r, ctx);
  }
  return out;
}

function reportRemote(it: RectItem, fronts: readonly Cell[], r: Rect, ctx: PlaceCtx): void {
  const far = it.fronts.filter((_, i) => fronts[i] && adjacentCount([fronts[i]!], r) === 0);
  if (far.length > 0) {
    ctx.issues.add(
      'W_COMPANY_REMOTE_FRONT',
      'warn',
      `企业 ${it.id} 的前沿格 ${far.join(',')} 与建筑不相邻（原版同一企业的多个落点格相距过远）`,
      { tiles: far },
    );
  }
}
