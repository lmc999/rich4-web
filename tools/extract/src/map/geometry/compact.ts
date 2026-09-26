import type { Cell } from './types';

/**
 * 可选紧凑（data-pipeline.md §8.2 第 8 步，override compact 开启）：删除包围盒内没有任何元素的整列、整行。
 * 路格、连接格、矩形都占格，所以「边或矩形跨越」的列必然非空；另外若删除后会让左右（上下）两侧原本不相邻的
 * 占用格变成相邻，就保留该列（行），保证所有相邻关系不变。
 */

export interface AxisMap {
  removed: number[];
  map(v: number): number;
}

function compactAxis(occupied: readonly Cell[], axis: 'x' | 'y'): AxisMap {
  const other = axis === 'x' ? 'y' : 'x';
  if (occupied.length === 0) return { removed: [], map: (v) => v };
  const lines = new Map<number, Set<number>>();
  for (const c of occupied) {
    const set = lines.get(c[axis]) ?? new Set<number>();
    set.add(c[other]);
    lines.set(c[axis], set);
  }
  const vals = occupied.map((c) => c[axis]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const removed: number[] = [];
  let last = lo;
  for (let v = lo + 1; v < hi; v++) {
    if (lines.has(v)) {
      last = v;
      continue;
    }
    const left = lines.get(last);
    const right = lines.get(v + 1);
    const clash = left && right ? [...left].some((o) => right.has(o)) : false;
    if (clash) last = v;
    else removed.push(v);
  }
  const map = (v: number): number => {
    let k = 0;
    while (k < removed.length && removed[k]! < v) k++;
    return v - k;
  };
  return { removed, map };
}

export interface CompactResult {
  removedCols: number[];
  removedRows: number[];
  mapCell(c: Cell): Cell;
}

export function compactGrid(occupied: readonly Cell[]): CompactResult {
  const xs = compactAxis(occupied, 'x');
  // 行的判定基于删列之后的坐标
  const afterX = occupied.map((c) => ({ x: xs.map(c.x), y: c.y }));
  const ys = compactAxis(afterX, 'y');
  return {
    removedCols: xs.removed,
    removedRows: ys.removed,
    mapCell: (c) => ({ x: xs.map(c.x), y: ys.map(c.y) }),
  };
}
