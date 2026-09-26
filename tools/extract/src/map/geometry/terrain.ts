import type { Cell, Rect } from './types';

/**
 * 边界与地形（data-pipeline.md §8.2 第 9 步）：包围盒四周留 margin 格并平移到原点；地形按到最近占用格的
 * Chebyshev 距离 d 决定：与网格边界连通（经 d ≥ 3 的格）的「外海」中 d ≥ 4 为水 w、d = 3 为沙 s；
 * 被路网围住的内陆里 d ≥ 4 为山 m（规格原文把所有 d ≥ 4 都当水，会在岛内生成湖，这里改为山）；其余为草 g。
 * terrain.paint override 最后局部涂改。结果只取决于占用格集合，确定。
 */

export const DEFAULT_MARGIN = 2;
export type TerrainChar = 'g' | 'w' | 's' | 'p' | 'm';

export interface Bounds {
  /** 格点坐标 + shift = 最终网格坐标 */
  shift: Cell;
  w: number;
  h: number;
}

export function computeBounds(occupied: readonly Cell[], margin: number): Bounds {
  if (occupied.length === 0) return { shift: { x: margin, y: margin }, w: 2 * margin + 1, h: 2 * margin + 1 };
  const xs = occupied.map((c) => c.x);
  const ys = occupied.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    shift: { x: margin - minX, y: margin - minY },
    w: Math.max(...xs) - minX + 1 + 2 * margin,
    h: Math.max(...ys) - minY + 1 + 2 * margin,
  };
}

/** 到最近占用格的 Chebyshev 距离（8-邻 BFS）。 */
export function chebyshevField(occupied: readonly Cell[], w: number, h: number): number[] {
  const d = new Array<number>(w * h).fill(-1);
  let queue: number[] = [];
  for (const c of occupied) {
    if (c.x < 0 || c.y < 0 || c.x >= w || c.y >= h) continue;
    const i = c.y * w + c.x;
    if (d[i] === -1) {
      d[i] = 0;
      queue.push(i);
    }
  }
  if (queue.length === 0) return d.map(() => w + h);
  let level = 0;
  while (queue.length > 0) {
    const next: number[] = [];
    level++;
    for (const i of queue) {
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (d[j] !== -1) continue;
          d[j] = level;
          next.push(j);
        }
      }
    }
    queue = next;
  }
  return d;
}

export interface TerrainResult {
  rows: string[];
  counts: Record<TerrainChar, number>;
}

export function buildTerrain(
  occupied: readonly Cell[],
  w: number,
  h: number,
  paint: readonly { rect: Rect; t: TerrainChar }[] = [],
): TerrainResult {
  const d = chebyshevField(occupied, w, h);
  // 外海：从边界出发、经 d ≥ 3 的格 4-连通
  const sea = new Array<boolean>(w * h).fill(false);
  const stack: number[] = [];
  const seed = (x: number, y: number) => {
    const i = y * w + x;
    if (!sea[i] && d[i]! >= 3) {
      sea[i] = true;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x, 0);
    seed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    seed(0, y);
    seed(w - 1, y);
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }
  const grid: TerrainChar[] = d.map((v, i) => {
    if (sea[i]) return v >= 4 ? 'w' : 's';
    return v >= 4 ? 'm' : 'g';
  });
  for (const p of paint) {
    for (let y = Math.max(0, p.rect.y); y < Math.min(h, p.rect.y + p.rect.h); y++) {
      for (let x = Math.max(0, p.rect.x); x < Math.min(w, p.rect.x + p.rect.w); x++) grid[y * w + x] = p.t;
    }
  }
  const counts: Record<TerrainChar, number> = { g: 0, w: 0, s: 0, p: 0, m: 0 };
  for (const t of grid) counts[t]++;
  const rows: string[] = [];
  for (let y = 0; y < h; y++) rows.push(grid.slice(y * w, (y + 1) * w).join(''));
  return { rows, counts };
}
