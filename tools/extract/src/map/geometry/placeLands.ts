import { isAdjacentToRect } from '@rich4/shared/data';
import { toRect } from '../overrides';
import { hungarian } from './hungarian';
import { applyTransform } from './lattice';
import type { PlaceCtx } from './placeFacilities';
import {
  type Cell,
  ck,
  compareCells,
  DIRS4,
  dirIndex,
  manhattan,
  neighbors4,
  type Rect,
  roundHalfUp,
  type Transform,
  type Vec,
} from './types';

/**
 * 住宅地 1×1（data-pipeline.md §8.2 第 6 步），匈牙利算法指派：
 *   候选(i) = { c ∈ N4(前沿格) : c 空闲 ∧ manhattan(c, want_i) ≤ 2 }，want_i = 住宅地世界坐标所在格
 *   cost(i,c) = 10·manhattan(c, want_i) + facingPenalty(i,c) + ε·order(c)
 * facingPenalty：在「want_i 本身与前沿格 4-相邻」的样本上检验假设「facing 0..7 = 从前沿格看地块的
 * 方位 N、NE、E、SE、S、SW、W、NW」，一致性 ≥ 90% 才启用（方向不符罚 3），否则为 0；统计写入报告。
 * 某块地没有候选时放宽为全部空闲 N4；指派仍不可行时报 E_LOT_NO_CELL。
 */

export interface LandItem {
  id: string;
  fronts: number[];
  want: Vec;
  facing: number;
}

export interface LandOverride {
  cell?: readonly [number, number] | undefined;
  rect?: readonly [number, number, number, number] | undefined;
}

export interface FacingStats {
  hypothesis: string;
  samples: number;
  consistent: number;
  consistency: number;
  enabled: boolean;
  /** facing → 实际方向(N/E/S/W) → 次数 */
  table: Record<string, Record<string, number>>;
}

export interface PlaceLandsResult {
  rects: Map<string, Rect>;
  facing: FacingStats;
  relaxed: string[];
}

const DIR_NAMES = ['N', 'E', 'S', 'W'];
/** 世界坐标下的 8 方位（facing 0..7，顺时针自北） */
const FACING_VEC: readonly Vec[] = [
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
];
const FACING_PENALTY = 3;
const INFEASIBLE = 10_000_000;

/** facing 在格点坐标下兼容的 4-邻方向下标。 */
export function facingDirs(facing: number, transform: Transform): number[] {
  const v0 = FACING_VEC[facing];
  if (!v0) return [];
  const v = applyTransform(v0, transform);
  const out: number[] = [];
  if (v.x !== 0) out.push(dirIndex({ x: 0, y: 0 }, { x: Math.sign(v.x), y: 0 }));
  if (v.y !== 0) out.push(dirIndex({ x: 0, y: 0 }, { x: 0, y: Math.sign(v.y) }));
  return out.sort((a, b) => a - b);
}

export function wantCellOf(v: Vec): Cell {
  return { x: roundHalfUp(v.x), y: roundHalfUp(v.y) };
}

export function facingStats(items: readonly LandItem[], cells: ReadonlyMap<number, Cell>, t: Transform): FacingStats {
  const table: Record<string, Record<string, number>> = {};
  let samples = 0;
  let consistent = 0;
  for (const it of items) {
    const front = cells.get(it.fronts[0] ?? -1);
    if (!front || it.facing < 0 || it.facing > 7) continue;
    const d = dirIndex(front, wantCellOf(it.want));
    if (d < 0) continue;
    samples++;
    const row = table[String(it.facing)] ?? {};
    row[DIR_NAMES[d]!] = (row[DIR_NAMES[d]!] ?? 0) + 1;
    table[String(it.facing)] = row;
    if (facingDirs(it.facing, t).includes(d)) consistent++;
  }
  const consistency = samples === 0 ? 0 : consistent / samples;
  return {
    hypothesis: 'facing 0..7 = 从前沿格看地块的方位 N,NE,E,SE,S,SW,W,NW（世界坐标，随 transform 旋转）',
    samples,
    consistent,
    consistency: Math.round(consistency * 1000) / 1000,
    enabled: samples >= 5 && consistency >= 0.9,
    table,
  };
}

function candidatesFor(it: LandItem, fronts: readonly Cell[], ctx: PlaceCtx, strict: boolean): Cell[] {
  const first = fronts[0];
  if (!first) return [];
  const want = wantCellOf(it.want);
  return neighbors4(first).filter(
    (c) =>
      ctx.occ.isFree(c) &&
      fronts.every((f) => isAdjacentToRect(f, { x: c.x, y: c.y, w: 1, h: 1 })) &&
      (!strict || manhattan(c, want) <= 2),
  );
}

export function placeLands(
  items: readonly LandItem[],
  overrides: Readonly<Record<string, LandOverride>>,
  ctx: PlaceCtx,
  transform: Transform,
): PlaceLandsResult {
  const rects = new Map<string, Rect>();
  const facing = facingStats(items, ctx.cells, transform);
  const frontsOf = (it: LandItem) => it.fronts.map((id) => ctx.cells.get(id)).filter((c): c is Cell => c !== undefined);

  // override 先占位
  const todo: LandItem[] = [];
  for (const it of items) {
    const ov = overrides[it.id];
    const r = ov?.rect ? toRect(ov.rect) : ov?.cell ? { x: ov.cell[0], y: ov.cell[1], w: 1, h: 1 } : null;
    if (!r) {
      todo.push(it);
      continue;
    }
    const fronts = frontsOf(it);
    if (!ctx.occ.rectFree(r) || !fronts.every((f) => isAdjacentToRect(f, r))) {
      ctx.issues.add('E_OVERRIDE_RECT', 'error', `lot.${it.id} 的 override 格被占用或不与前沿格相邻`, {
        tiles: it.fronts,
        cells: [{ x: r.x, y: r.y }],
      });
      continue;
    }
    ctx.occ.claimRect(r, { kind: 'lot', id: it.id });
    rects.set(it.id, r);
  }

  const relaxed = new Set<string>();
  const solve = (relaxAll: boolean): { assign: (Cell | null)[] } => {
    const cand = todo.map((it) => {
      const fronts = frontsOf(it);
      let cs = relaxAll ? [] : candidatesFor(it, fronts, ctx, true);
      if (cs.length === 0) {
        cs = candidatesFor(it, fronts, ctx, false);
        relaxed.add(it.id);
      }
      return cs;
    });
    const cols: Cell[] = [];
    const colIdx = new Map<string, number>();
    for (const c of cand.flat().sort(compareCells)) {
      if (colIdx.has(ck(c))) continue;
      colIdx.set(ck(c), cols.length);
      cols.push(c);
    }
    const m = Math.max(cols.length, todo.length);
    const cost = todo.map((it, i) => {
      const row = new Array<number>(m).fill(INFEASIBLE);
      const front = frontsOf(it)[0]!;
      const want = wantCellOf(it.want);
      const ok = facing.enabled ? facingDirs(it.facing, transform) : [];
      for (const c of cand[i]!) {
        const d = dirIndex(front, c);
        const fp = facing.enabled && ok.length > 0 && !ok.includes(d) ? FACING_PENALTY : 0;
        row[colIdx.get(ck(c))!] = (10 * manhattan(c, want) + fp) * DIRS4.length + d;
      }
      return row;
    });
    const res = hungarian(cost);
    return { assign: res.map((j, i) => (j >= 0 && j < cols.length && cost[i]![j]! < INFEASIBLE ? cols[j]! : null)) };
  };

  let { assign } = solve(false);
  if (assign.some((a) => a === null)) {
    ctx.issues.add('I_LANDS_RELAXED', 'info', '住宅地严格候选下指派不可行，放宽为全部空闲 N4 后重解');
    assign = solve(true).assign;
  }
  todo.forEach((it, i) => {
    const c = assign[i];
    if (!c) {
      ctx.issues.add('E_LOT_NO_CELL', 'error', `住宅地 ${it.id} 的前沿格周围没有空闲格，需要 lot.${it.id} override`, {
        tiles: it.fronts,
      });
      return;
    }
    const r = { x: c.x, y: c.y, w: 1, h: 1 };
    ctx.occ.claimRect(r, { kind: 'lot', id: it.id });
    rects.set(it.id, r);
  });
  const relaxedList = [...relaxed].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  if (relaxedList.length > 0) {
    ctx.issues.add('I_LAND_FAR', 'info', `住宅地 ${relaxedList.join(',')} 在期望格 2 格内没有候选，已放宽`);
  }
  return { rects, facing, relaxed: relaxedList };
}
