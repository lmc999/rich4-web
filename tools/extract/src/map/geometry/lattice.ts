import { roundHalfUp, type Transform, type Vec } from './types';

/**
 * 格点检测（data-pipeline.md §8.1）。
 * 1) 先按 T=32（exe 绘制时的 >>5）统计残差众数与覆盖率、边的步长分类；覆盖率 ≥95% 且单位轴向边 ≥90% → mode 'tile'。
 * 2) 否则 mode 'fitted'：T' = 轴向边长直方图的众数吸附到候选 16/32/48/64；原点在 [0,T')² 中搜索，
 *    依次最小化「节点同格数、零长边数、需要的连接格总数、量化残差平方和」，再按 (ox, oy) 字典序定序。
 * override 给出 tile/origin 时直接采用（仍输出统计）。
 */

export const PROBE_TILE = 32;
export const FIT_CANDIDATES: readonly number[] = [16, 32, 48, 64];
/** 方向判定：|短轴| ≤ tan(22.5°)·|长轴| 视为轴向 */
const AXIAL_TAN = 0.4142;

export interface LatticePoint {
  id: number;
  x: number;
  y: number;
}

export interface StepClasses {
  unitAxial: number;
  unitDiagonal: number;
  longStraight: number;
  other: number;
  zero: number;
}

export interface LatticeScore {
  collisions: number;
  zeroEdges: number;
  viaCells: number;
  residual: number;
}

export interface LatticeResult {
  mode: 'tile' | 'fitted';
  tile: number;
  origin: [number, number];
  transform: Transform;
  overridden: { tile: boolean; origin: boolean; transform: boolean };
  probe32: {
    residualX: Record<string, number>;
    residualY: Record<string, number>;
    modeResidual: [number, number];
    coverage: number;
    steps: StepClasses;
  };
  /** 世界坐标下边的方向分类与长度直方图（长度取整） */
  edgeDirections: { axial: number; diagonal: number };
  axialLengths: Record<string, number>;
  diagonalLengths: Record<string, number>;
  steps: StepClasses;
  score: LatticeScore;
}

export interface LatticeOptions {
  tile?: number | undefined;
  origin?: readonly [number, number] | undefined;
  transform?: Transform | undefined;
}

function hist(values: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of [...values].sort((a, b) => a - b)) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

function modeOf(h: Record<string, number>): number {
  let best = 0;
  let bestN = -1;
  for (const [k, n] of Object.entries(h)) {
    const v = Number(k);
    if (n > bestN || (n === bestN && v < best)) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

const mod = (v: number, m: number): number => ((v % m) + m) % m;

function circDist(a: number, b: number, m: number): number {
  const d = mod(a - b, m);
  return Math.min(d, m - d);
}

function cellOf(p: { x: number; y: number }, tile: number, ox: number, oy: number): [number, number] {
  return [roundHalfUp((p.x - ox) / tile), roundHalfUp((p.y - oy) / tile)];
}

export function classifySteps(
  pts: ReadonlyMap<number, [number, number]>,
  edges: readonly (readonly [number, number])[],
): StepClasses {
  const s: StepClasses = { unitAxial: 0, unitDiagonal: 0, longStraight: 0, other: 0, zero: 0 };
  for (const [a, b] of edges) {
    const ca = pts.get(a);
    const cb = pts.get(b);
    if (!ca || !cb) continue;
    const dx = Math.abs(ca[0] - cb[0]);
    const dy = Math.abs(ca[1] - cb[1]);
    if (dx + dy === 0) s.zero++;
    else if (dx + dy === 1) s.unitAxial++;
    else if (dx === 1 && dy === 1) s.unitDiagonal++;
    else if (dx === 0 || dy === 0) s.longStraight++;
    else s.other++;
  }
  return s;
}

function scoreOf(
  points: readonly LatticePoint[],
  edges: readonly (readonly [number, number])[],
  tile: number,
  ox: number,
  oy: number,
): { score: LatticeScore; cells: Map<number, [number, number]> } {
  const cells = new Map<number, [number, number]>();
  const seen = new Set<string>();
  let collisions = 0;
  let residual = 0;
  for (const p of points) {
    const c = cellOf(p, tile, ox, oy);
    cells.set(p.id, c);
    const k = `${c[0]},${c[1]}`;
    if (seen.has(k)) collisions++;
    else seen.add(k);
    const rx = (p.x - ox) / tile - c[0];
    const ry = (p.y - oy) / tile - c[1];
    residual += rx * rx + ry * ry;
  }
  let zeroEdges = 0;
  let viaCells = 0;
  for (const [a, b] of edges) {
    const ca = cells.get(a);
    const cb = cells.get(b);
    if (!ca || !cb) continue;
    const d = Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]);
    if (d === 0) zeroEdges++;
    viaCells += Math.max(0, d - 1);
  }
  return { score: { collisions, zeroEdges, viaCells, residual }, cells };
}

function better(a: LatticeScore, b: LatticeScore): boolean {
  if (a.collisions !== b.collisions) return a.collisions < b.collisions;
  if (a.zeroEdges !== b.zeroEdges) return a.zeroEdges < b.zeroEdges;
  if (a.viaCells !== b.viaCells) return a.viaCells < b.viaCells;
  return a.residual < b.residual - 1e-9;
}

export function detectLattice(
  points: readonly LatticePoint[],
  edges: readonly (readonly [number, number])[],
  opts: LatticeOptions = {},
): LatticeResult {
  const byId = new Map(points.map((p) => [p.id, p]));

  // T=32 探测
  const rx = points.map((p) => mod(p.x, PROBE_TILE));
  const ry = points.map((p) => mod(p.y, PROBE_TILE));
  const residualX = hist(rx);
  const residualY = hist(ry);
  const mx = modeOf(residualX);
  const my = modeOf(residualY);
  const covered = points.filter(
    (p) => circDist(mod(p.x, PROBE_TILE), mx, PROBE_TILE) <= 1 && circDist(mod(p.y, PROBE_TILE), my, PROBE_TILE) <= 1,
  ).length;
  const coverage = points.length === 0 ? 1 : covered / points.length;
  const probeCells = new Map(points.map((p) => [p.id, cellOf(p, PROBE_TILE, mx, my)] as const));
  const probeSteps = classifySteps(probeCells, edges);

  // 世界坐标下的边方向与长度
  const axialLens: number[] = [];
  const diagLens: number[] = [];
  for (const [a, b] of edges) {
    const pa = byId.get(a);
    const pb = byId.get(b);
    if (!pa || !pb) continue;
    const dx = Math.abs(pb.x - pa.x);
    const dy = Math.abs(pb.y - pa.y);
    if (dy <= AXIAL_TAN * dx || dx <= AXIAL_TAN * dy) axialLens.push(Math.max(dx, dy));
    else diagLens.push(roundHalfUp(Math.sqrt(dx * dx + dy * dy)));
  }
  const axialLengths = hist(axialLens);
  const diagonalLengths = hist(diagLens);

  const unitAxialFrac = edges.length === 0 ? 1 : probeSteps.unitAxial / edges.length;
  let mode: LatticeResult['mode'];
  let tile: number;
  if (opts.tile !== undefined) {
    tile = opts.tile;
    mode = tile === PROBE_TILE && coverage >= 0.95 && unitAxialFrac >= 0.9 ? 'tile' : 'fitted';
  } else if (coverage >= 0.95 && unitAxialFrac >= 0.9) {
    mode = 'tile';
    tile = PROBE_TILE;
  } else {
    mode = 'fitted';
    const m = axialLens.length > 0 ? modeOf(axialLengths) : PROBE_TILE;
    tile = FIT_CANDIDATES.reduce((best, c) => (Math.abs(c - m) < Math.abs(best - m) ? c : best));
  }

  let origin: [number, number];
  let best: { score: LatticeScore; cells: Map<number, [number, number]> };
  if (opts.origin !== undefined) {
    origin = [opts.origin[0], opts.origin[1]];
    best = scoreOf(points, edges, tile, origin[0], origin[1]);
  } else if (mode === 'tile') {
    origin = [mx, my];
    best = scoreOf(points, edges, tile, mx, my);
  } else {
    origin = [0, 0];
    best = scoreOf(points, edges, tile, 0, 0);
    for (let ox = 0; ox < tile; ox++) {
      for (let oy = 0; oy < tile; oy++) {
        const cand = scoreOf(points, edges, tile, ox, oy);
        if (better(cand.score, best.score)) {
          best = cand;
          origin = [ox, oy];
        }
      }
    }
  }

  return {
    mode,
    tile,
    origin,
    transform: opts.transform ?? 'identity',
    overridden: {
      tile: opts.tile !== undefined,
      origin: opts.origin !== undefined,
      transform: opts.transform !== undefined,
    },
    probe32: { residualX, residualY, modeResidual: [mx, my], coverage, steps: probeSteps },
    edgeDirections: { axial: axialLens.length, diagonal: diagLens.length },
    axialLengths,
    diagonalLengths,
    steps: classifySteps(best.cells, edges),
    score: { ...best.score, residual: Math.round(best.score.residual * 1000) / 1000 },
  };
}

/** 格点坐标（浮点，已做 transform）。 */
export function toLatticeVec(
  p: { x: number; y: number },
  lat: Pick<LatticeResult, 'tile' | 'origin' | 'transform'>,
): Vec {
  const v = { x: (p.x - lat.origin[0]) / lat.tile, y: (p.y - lat.origin[1]) / lat.tile };
  return applyTransform(v, lat.transform);
}

export function applyTransform(v: Vec, t: Transform): Vec {
  switch (t) {
    case 'identity':
      return { x: v.x, y: v.y };
    case 'rot90':
      return { x: -v.y, y: v.x };
    case 'rot180':
      return { x: -v.x, y: -v.y };
    case 'rot270':
      return { x: v.y, y: -v.x };
    case 'flipX':
      return { x: -v.x, y: v.y };
    case 'flipY':
      return { x: v.x, y: -v.y };
  }
}
