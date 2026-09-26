import { applyTransform, type LatticeResult } from './lattice';
import { type Cell, ck, type GeoIssues, roundHalfUp } from './types';

type LatticeParams = Pick<LatticeResult, 'tile' | 'origin' | 'transform'>;

/** 世界坐标 → 格点坐标的整数格：先按 (p−o)/T 四舍五入，再做 transform。 */
export function quantizeCell(p: { x: number; y: number }, lat: LatticeParams): Cell {
  const c = {
    x: roundHalfUp((p.x - lat.origin[0]) / lat.tile),
    y: roundHalfUp((p.y - lat.origin[1]) / lat.tile),
  };
  const t = applyTransform(c, lat.transform);
  return { x: t.x === 0 ? 0 : t.x, y: t.y === 0 ? 0 : t.y };
}

export interface QuantizeInput {
  id: number;
  world: { x: number; y: number };
}

/**
 * 放置路格（§8.2 第 1 步）。nodeCell override 直接指定格点坐标。
 * 两个节点落在同一格时报 E_CELL_COLLIDE（error，需要 nodeCell override）。
 */
export function quantizeTiles(
  tiles: readonly QuantizeInput[],
  lat: LatticeParams,
  nodeCell: Readonly<Record<string, readonly [number, number]>>,
  issues: GeoIssues,
): Map<number, Cell> {
  const cells = new Map<number, Cell>();
  const owner = new Map<string, number>();
  for (const t of tiles) {
    const o = nodeCell[String(t.id)];
    const c = o ? { x: o[0], y: o[1] } : quantizeCell(t.world, lat);
    cells.set(t.id, c);
    const k = ck(c);
    const prev = owner.get(k);
    if (prev !== undefined) {
      issues.add('E_CELL_COLLIDE', 'error', `节点 ${t.id} 与节点 ${prev} 量化到同一格 (${k})，需要 nodeCell override`, {
        tiles: [prev, t.id],
        cells: [c],
      });
    } else owner.set(k, t.id);
  }
  return cells;
}
