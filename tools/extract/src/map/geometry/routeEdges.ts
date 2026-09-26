import { type Cell, ck, compareCells, DIRS4, type GeoIssues, type Occupancy } from './types';

/**
 * 连边（data-pipeline.md §8.2 第 2 步）：
 * - 单位轴向：直接相连；
 * - 长直边：内部格作为 via 连接格；
 * - 对角或其他：两种 L 形折线，取途经格全部空闲、软约束权重和最小的一种，平手按肘点 (x,y) 字典序；
 * - 以上都被占用时，在局部窗口内绕行（最短路，途经目标格加罚），并记 warn；
 * - 处理顺序：单位边、长直边、单位对角边、其他边，同类按 (a,b) 升序；
 * - override edgeRoute 直接指定折线。
 * via 不是游戏格，只用于画路与行走插值；统一记入 roadCells。
 */

export type EdgeRouteKind = 'unit' | 'straight' | 'L' | 'detour' | 'override';

export interface RouteStats {
  edges: number;
  unit: number;
  straight: number;
  lShape: number;
  detour: number;
  override: number;
  /** 量化后为单位对角 (±1,±1) 的边 */
  diagonal: number;
  viaEdges: number;
  viaCells: number;
  maxVia: number;
}

export interface RouteResult {
  /** 键 "a-b"（a<b），via 从 a 走向 b，不含两端 */
  vias: Map<string, Cell[]>;
  kinds: Map<string, EdgeRouteKind>;
  roadCells: Cell[];
  stats: RouteStats;
}

export interface RouteInput {
  edges: readonly (readonly [number, number])[];
  cells: ReadonlyMap<number, Cell>;
  occ: Occupancy;
  /** 软约束：尽量不占用的格 → 权重（地块目标格、地块侧、设施候选矩形） */
  avoid: ReadonlyMap<string, number>;
  overrides: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  issues: GeoIssues;
}

export const edgeKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);

function lPath(a: Cell, b: Cell, horizontalFirst: boolean): Cell[] {
  const sx = Math.sign(b.x - a.x);
  const sy = Math.sign(b.y - a.y);
  const out: Cell[] = [];
  if (horizontalFirst) {
    for (let x = a.x + sx; x !== b.x + sx && sx !== 0; x += sx) out.push({ x, y: a.y });
    for (let y = a.y + sy; y !== b.y + sy && sy !== 0; y += sy) out.push({ x: b.x, y });
  } else {
    for (let y = a.y + sy; y !== b.y + sy && sy !== 0; y += sy) out.push({ x: a.x, y });
    for (let x = a.x + sx; x !== b.x + sx && sx !== 0; x += sx) out.push({ x, y: b.y });
  }
  out.pop(); // 去掉终点 b
  return out;
}

function isChain(cells: readonly Cell[]): boolean {
  for (let i = 1; i < cells.length; i++) {
    if (Math.abs(cells[i]!.x - cells[i - 1]!.x) + Math.abs(cells[i]!.y - cells[i - 1]!.y) !== 1) return false;
  }
  return true;
}

const AVOID_PENALTY = 3;
const DETOUR_PAD = 4;

/** 局部窗口内的最短绕行（Dijkstra，邻居顺序 N/E/S/W，平手取先入队者），找不到返回 null。 */
function detour(a: Cell, b: Cell, occ: Occupancy, avoid: ReadonlyMap<string, number>): Cell[] | null {
  const x0 = Math.min(a.x, b.x) - DETOUR_PAD;
  const x1 = Math.max(a.x, b.x) + DETOUR_PAD;
  const y0 = Math.min(a.y, b.y) - DETOUR_PAD;
  const y1 = Math.max(a.y, b.y) + DETOUR_PAD;
  const w = x1 - x0 + 1;
  const idx = (c: Cell) => (c.y - y0) * w + (c.x - x0);
  const n = w * (y1 - y0 + 1);
  const dist = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  const order = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  let seq = 0;
  const start = idx(a);
  const goal = idx(b);
  dist[start] = 0;
  order[start] = seq++;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) {
      if (done[i] || dist[i] === Number.POSITIVE_INFINITY) continue;
      if (u === -1 || dist[i]! < dist[u]! || (dist[i] === dist[u] && order[i]! < order[u]!)) u = i;
    }
    if (u === -1) return null;
    if (u === goal) break;
    done[u] = true;
    const uc = { x: (u % w) + x0, y: Math.floor(u / w) + y0 };
    for (const d of DIRS4) {
      const v = { x: uc.x + d.x, y: uc.y + d.y };
      if (v.x < x0 || v.x > x1 || v.y < y0 || v.y > y1) continue;
      const vi = idx(v);
      if (done[vi]) continue;
      if (vi !== goal && !occ.isFree(v)) continue;
      const cost = dist[u]! + 1 + (avoid.get(ck(v)) ?? 0) * AVOID_PENALTY;
      if (cost < dist[vi]!) {
        dist[vi] = cost;
        prev[vi] = u;
        order[vi] = seq++;
      }
    }
  }
  const path: Cell[] = [];
  for (let v = prev[goal]!; v !== start && v !== -1; v = prev[v]!) {
    path.push({ x: (v % w) + x0, y: Math.floor(v / w) + y0 });
  }
  return path.reverse();
}

export function routeEdges(input: RouteInput): RouteResult {
  const { edges, cells, occ, avoid, overrides, issues } = input;
  const vias = new Map<string, Cell[]>();
  const kinds = new Map<string, EdgeRouteKind>();
  const stats: RouteStats = {
    edges: edges.length,
    unit: 0,
    straight: 0,
    lShape: 0,
    detour: 0,
    override: 0,
    diagonal: 0,
    viaEdges: 0,
    viaCells: 0,
    maxVia: 0,
  };
  const road: Cell[] = [];

  const commit = (key: string, kind: EdgeRouteKind, via: Cell[]) => {
    for (const c of via) {
      occ.claim(c, { kind: 'road', id: key });
      road.push(c);
    }
    vias.set(key, via);
    kinds.set(key, kind);
    if (via.length > 0) stats.viaEdges++;
    stats.viaCells += via.length;
    stats.maxVia = Math.max(stats.maxVia, via.length);
  };

  // 先连只有一种走法的边（单位、长直），再连有 L 形选择的对角边与其他边，避免后者抢走前者唯一的途经格
  const rank = (e: readonly [number, number]): number => {
    const a = cells.get(e[0]);
    const b = cells.get(e[1]);
    if (!a || !b) return 0;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    if (dx === 0 || dy === 0) return dx + dy <= 1 ? 0 : 1;
    return dx === 1 && dy === 1 ? 2 : 3;
  };
  const ordered = [...edges].sort((p, q) => rank(p) - rank(q) || p[0] - q[0] || p[1] - q[1]);

  for (const [ia, ib] of ordered) {
    const a = cells.get(ia);
    const b = cells.get(ib);
    if (!a || !b) continue;
    const key = edgeKey(ia, ib);
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    if (dx === 1 && dy === 1) stats.diagonal++;

    const ov = overrides[key];
    if (ov) {
      const via = ov.map(([x, y]) => ({ x, y }));
      const busy = via.filter((c) => !occ.isFree(c));
      if (!isChain([a, ...via, b]) || busy.length > 0) {
        issues.add('E_ROUTE_OVERRIDE', 'error', `edgeRoute ${key} 不连续或途经格已被占用`, {
          tiles: [ia, ib],
          cells: busy.length > 0 ? busy : via,
        });
        vias.set(key, []);
        kinds.set(key, 'override');
        continue;
      }
      stats.override++;
      commit(key, 'override', via);
      continue;
    }

    if (dx + dy === 1) {
      stats.unit++;
      commit(key, 'unit', []);
      continue;
    }
    if (dx + dy === 0) {
      issues.add('E_CELL_COLLIDE', 'error', `边 ${key} 两端落在同一格`, { tiles: [ia, ib], cells: [a] });
      vias.set(key, []);
      kinds.set(key, 'unit');
      continue;
    }

    const cands: { via: Cell[]; elbow: Cell | null }[] =
      dx === 0 || dy === 0
        ? [{ via: lPath(a, b, true), elbow: null }]
        : [
            { via: lPath(a, b, true), elbow: { x: b.x, y: a.y } },
            { via: lPath(a, b, false), elbow: { x: a.x, y: b.y } },
          ];
    const ok = cands
      .filter((c) => c.via.every((v) => occ.isFree(v)))
      .map((c) => ({ ...c, cost: c.via.reduce((s, v) => s + (avoid.get(ck(v)) ?? 0), 0) }))
      .sort((p, q) => p.cost - q.cost || (p.elbow && q.elbow ? p.elbow.x - q.elbow.x || p.elbow.y - q.elbow.y : 0));
    const pick = ok[0];
    if (pick) {
      if (dx === 0 || dy === 0) stats.straight++;
      else stats.lShape++;
      commit(key, dx === 0 || dy === 0 ? 'straight' : 'L', pick.via);
      continue;
    }
    const alt = detour(a, b, occ, avoid);
    if (alt && isChain([a, ...alt, b])) {
      stats.detour++;
      issues.add('W_ROUTE_DETOUR', 'warn', `边 ${key} 的直线/L 形途经格被占用，改为绕行（${alt.length} 个连接格）`, {
        tiles: [ia, ib],
        cells: alt,
      });
      commit(key, 'detour', alt);
      continue;
    }
    issues.add(
      'E_ROUTE_BLOCKED',
      'error',
      `边 ${key} 无法连通（周围格全被占用），需要 edgeRoute 或 nodeCell override`,
      {
        tiles: [ia, ib],
        cells: [a, b],
      },
    );
    vias.set(key, []);
    kinds.set(key, 'unit');
  }

  return { vias, kinds, roadCells: [...road].sort(compareCells), stats };
}

/** 从 from 出发沿边的 via（反向时倒序）。 */
export function viaFrom(vias: ReadonlyMap<string, Cell[]>, from: number, to: number): Cell[] {
  const v = vias.get(edgeKey(from, to)) ?? [];
  return from < to ? v.map((c) => ({ ...c })) : [...v].reverse().map((c) => ({ ...c }));
}
