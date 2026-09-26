/**
 * 匈牙利算法（Kuhn–Munkres，势函数版，O(n²·m)），求 n×m（n ≤ m）代价矩阵的最小总代价指派。
 * 返回每行分到的列下标。代价应为有限数；不可行的格用一个很大的有限数表示，由调用方识别。
 * 输入相同则输出相同（只依赖遍历顺序，无随机）。
 */
export function hungarian(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  const m = cost[0]!.length;
  if (m < n) throw new Error(`hungarian: 列数 ${m} 少于行数 ${n}`);
  for (const row of cost) {
    if (row.length !== m) throw new Error('hungarian: 代价矩阵不是矩形');
    for (const v of row) if (!Number.isFinite(v)) throw new Error('hungarian: 代价必须是有限数');
  }
  const INF = Number.POSITIVE_INFINITY;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else minv[j] = minv[j]! - delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const ans = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]! !== 0) ans[p[j]! - 1] = j - 1;
  return ans;
}

/** 指派的总代价。 */
export function assignmentCost(cost: readonly (readonly number[])[], assign: readonly number[]): number {
  return assign.reduce((s, j, i) => s + cost[i]![j]!, 0);
}
