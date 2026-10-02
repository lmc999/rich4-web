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
 * 放宽只针对拥挤的地块：严格候选为空的地块直接放宽为全部空闲 N4；严格指派不可行时，逐轮只放宽没分到格的地块
 * （它们已放宽时再放宽与之争格的地块），仍不可行才全部放宽；最终仍无解报 E_LOT_NO_CELL。
 * I_LAND_FAR 只列最终落点距期望格超过 2 的地块（放宽了但仍落在 2 格内的不算）。
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

  /** widen 中的地块不用严格候选；返回指派与本次实际放宽的地块 */
  const solve = (widen: ReadonlySet<string>): { assign: (Cell | null)[]; cand: Cell[][]; relaxed: Set<string> } => {
    const relaxed = new Set<string>();
    const cand = todo.map((it) => {
      const fronts = frontsOf(it);
      let cs = widen.has(it.id) ? [] : candidatesFor(it, fronts, ctx, true);
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
    return {
      assign: res.map((j, i) => (j >= 0 && j < cols.length && cost[i]![j]! < INFEASIBLE ? cols[j]! : null)),
      cand,
      relaxed,
    };
  };

  const widen = new Set<string>();
  let res = solve(widen);
  if (res.assign.some((a) => a === null)) {
    ctx.issues.add('I_LANDS_RELAXED', 'info', '住宅地严格候选下指派不可行，只对拥挤的地块放宽为全部空闲 N4 后重解');
    for (let round = 0; round < todo.length && res.assign.some((a) => a === null); round++) {
      const stuck = todo.filter((_, i) => res.assign[i] === null);
      let add = stuck.filter((it) => !widen.has(it.id));
      if (add.length === 0) {
        // 没分到格的都已放宽：再放宽与它们争同一批格的地块
        const contested = new Set(stuck.flatMap((it) => res.cand[todo.indexOf(it)]!.map(ck)));
        add = todo.filter((it, i) => !widen.has(it.id) && res.cand[i]!.some((c) => contested.has(ck(c))));
      }
      if (add.length === 0) break;
      for (const it of add) widen.add(it.id);
      res = solve(widen);
    }
    if (res.assign.some((a) => a === null)) res = solve(new Set(todo.map((it) => it.id)));
  }
  const { assign } = res;
  const far: string[] = [];
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
    if (manhattan(c, wantCellOf(it.want)) > 2) far.push(it.id);
  });
  const byNum = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1));
  const relaxedList = [...res.relaxed].sort(byNum);
  if (far.length > 0) {
    ctx.issues.add('I_LAND_FAR', 'info', `住宅地 ${far.sort(byNum).join(',')} 距期望格超过 2 格（候选已放宽）`);
  }
  return { rects, facing, relaxed: relaxedList };
}
