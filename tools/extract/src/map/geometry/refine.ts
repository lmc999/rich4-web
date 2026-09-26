import { type Cell, ck, DIRS4, dirIndex, type GeoIssues, manhattan } from './types';

/**
 * 拐角翻转（规格外的局部修整，在量化之后、连边之前）：
 * 斜向街道量化成阶梯时，会出现「路径在住宅地一侧拐弯」的拐角格 T——它的两个邻格 A、B 恰好占住了
 * 住宅地想去的两个方向，地块只能放到路的另一侧。把 T 移到 A+B−T（同一个单位正方形的对角）后，
 * A–T、T–B 仍是单位轴向边，而 T 的地块侧空了出来。只在以下条件都满足时翻转：
 * T 度数为 2、两条边都是单位轴向且互相垂直、T 没有 nodeCell override、目标格空闲且只与 A、B 相邻、
 * 局部「地块侧全被堵」的格数严格下降。按节点号顺序反复扫描直到不再变化。
 */

export interface FlipInput {
  cells: Map<number, Cell>;
  /** 节点的无向邻居 */
  adjacency: ReadonlyMap<number, readonly number[]>;
  /** 有住宅地的前沿格 → 地块希望所在的 4-邻方向下标 */
  sideDirs: ReadonlyMap<number, readonly number[]>;
  pinned: ReadonlySet<number>;
  issues: GeoIssues;
  maxPasses?: number;
}

export interface FlipResult {
  flipped: number[];
}

export function flipCorners(input: FlipInput): FlipResult {
  const { cells, adjacency, sideDirs, pinned } = input;
  const owner = new Map<string, number>();
  for (const [id, c] of cells) owner.set(ck(c), id);

  const blocked = (id: number): boolean => {
    const dirs = sideDirs.get(id);
    const c = cells.get(id);
    if (!dirs || dirs.length === 0 || !c) return false;
    return dirs.every((d) => owner.has(ck({ x: c.x + DIRS4[d]!.x, y: c.y + DIRS4[d]!.y })));
  };
  const near = (c: Cell): number[] => {
    const out: number[] = [];
    for (const [id, p] of cells) if (manhattan(p, c) <= 1) out.push(id);
    return out;
  };

  const flipped: number[] = [];
  const ids = [...sideDirs.keys()].sort((a, b) => a - b);
  for (let pass = 0; pass < (input.maxPasses ?? 4); pass++) {
    let changed = false;
    for (const id of ids) {
      if (pinned.has(id) || !blocked(id)) continue;
      const nb = adjacency.get(id) ?? [];
      if (nb.length !== 2) continue;
      const t = cells.get(id)!;
      const a = cells.get(nb[0]!);
      const b = cells.get(nb[1]!);
      if (!a || !b) continue;
      const da = dirIndex(t, a);
      const db = dirIndex(t, b);
      if (da < 0 || db < 0 || da % 2 === db % 2) continue;
      const target = { x: a.x + b.x - t.x, y: a.y + b.y - t.y };
      if (owner.has(ck(target))) continue;
      const touching = near(target).filter((n) => n !== nb[0] && n !== nb[1]);
      if (touching.some((n) => n !== id)) continue;
      const scope = [...new Set([id, nb[0]!, nb[1]!, ...near(t), ...near(target)])];
      const before = scope.filter(blocked).length;
      owner.delete(ck(t));
      owner.set(ck(target), id);
      cells.set(id, target);
      const after = scope.filter(blocked).length;
      if (after < before) {
        flipped.push(id);
        changed = true;
        input.issues.add(
          'I_CORNER_FLIP',
          'info',
          `节点 ${id} 从 (${t.x},${t.y}) 翻到 (${target.x},${target.y})，腾出地块侧`,
          {
            tiles: [id],
          },
        );
      } else {
        owner.delete(ck(target));
        owner.set(ck(t), id);
        cells.set(id, t);
      }
    }
    if (!changed) break;
  }
  return { flipped: flipped.sort((a, b) => a - b) };
}
