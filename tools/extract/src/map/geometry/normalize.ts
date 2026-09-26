import { countOverrides, type MapOverrides, toRect } from '../overrides';
import { type MapSemantic, semanticEdges } from '../semantic';
import { compactGrid } from './compact';
import { detectLattice, type LatticeResult, toLatticeVec } from './lattice';
import { placeCompanies } from './placeCompanies';
import { type PlaceCtx, placeFacilities } from './placeFacilities';
import { placeHoldLandmarks, placeScenery } from './placeLandmarks';
import { type FacingStats, facingDirs, facingStats, placeLands, wantCellOf } from './placeLands';
import { quantizeTiles } from './quantize';
import { rectsAround } from './rects';
import { flipCorners } from './refine';
import { type EdgeRouteKind, type RouteStats, routeEdges } from './routeEdges';
import { buildTerrain, computeBounds, DEFAULT_MARGIN, type TerrainChar } from './terrain';
import {
  type Cell,
  ck,
  compareCells,
  DIRS4,
  dirIndex,
  type GeoIssue,
  GeoIssues,
  manhattan,
  neighbors4,
  Occupancy,
  type Rect,
  rectCells,
  type Vec,
} from './types';

/**
 * 几何归一化总流程（data-pipeline.md §8.2）：世界坐标 → MapDef 网格。
 * 所有放置都在「格点坐标」中进行，最后（可选紧凑后）平移到原点。每一步的决定与问题写入 GeometryReport。
 */

export interface GeometryReport {
  schema: 'rich4.geometry-report/1';
  mapKey: string;
  source: MapSemantic['source'];
  lattice: LatticeResult;
  routes: RouteStats;
  edgeKinds: Record<EdgeRouteKind, number>;
  facing: FacingStats;
  landsRelaxed: string[];
  /** 放在 facing 所指一侧之外的住宅地 */
  landsOffSide: string[];
  cornerFlips: number[];
  /** 网格上 4-相邻却没有边相连的路格对（视觉上容易误认为相连） */
  unlinkedAdjacent: [number, number][];
  compact: { enabled: boolean; removedCols: number[]; removedRows: number[] };
  bounds: { margin: number; shift: Cell; w: number; h: number };
  terrain: Record<TerrainChar, number>;
  overrides: number;
  hiddenLandmarks: string[];
  issues: GeoIssue[];
}

export interface GeometryResult {
  lattice: LatticeResult;
  /** 以下均为最终网格坐标 */
  tileCells: Map<number, Cell>;
  vias: Map<string, Cell[]>;
  roadCells: Cell[];
  lotRects: Map<string, Rect>;
  landmarkRects: Map<string, Rect>;
  grid: { w: number; h: number };
  terrain: string[];
  /** 格点坐标 → 最终网格坐标 */
  toGrid(c: Cell): Cell;
  /** 世界坐标 → 格点坐标（浮点） */
  toLattice(p: { x: number; y: number }): Vec;
  report: GeometryReport;
}

export function normalizeGeometry(sem: MapSemantic, ov: MapOverrides): GeometryResult {
  const issues = new GeoIssues();
  const edges = semanticEdges(sem);
  const lattice = detectLattice(
    sem.tiles.map((t) => ({ id: t.id, x: t.world.x, y: t.world.y })),
    edges,
    ov.lattice,
  );
  if (lattice.mode === 'fitted' && !lattice.overridden.tile) {
    issues.add(
      'I_LATTICE_FITTED',
      'info',
      `T=32 覆盖率 ${(lattice.probe32.coverage * 100).toFixed(1)}%、单位轴向边 ${lattice.probe32.steps.unitAxial}/${edges.length}，` +
        `改用拟合格点 T=${lattice.tile}、原点 (${lattice.origin.join(',')})，请人工确认并写入 overrides.lattice`,
    );
  }
  const toLattice = (p: { x: number; y: number }): Vec => toLatticeVec(p, lattice);

  // 1. 路格
  const cells = quantizeTiles(sem.tiles, lattice, ov.nodeCell, issues);

  // 1b. 拐角翻转：腾出住宅地一侧
  const landWant = new Map(sem.lands.map((l) => [l.id, toLattice(l.world)]));
  const landItems = sem.lands.map((l) => ({
    id: l.id,
    fronts: l.frontTiles,
    want: landWant.get(l.id)!,
    facing: l.facing,
  }));
  const facingPre = facingStats(landItems, cells, lattice.transform);
  const sideDirs = new Map<number, number[]>();
  for (const it of landItems) {
    const front = it.fronts[0];
    const fc = front === undefined ? undefined : cells.get(front);
    if (!fc || it.fronts.length !== 1) continue;
    const dirs = facingPre.enabled ? facingDirs(it.facing, lattice.transform) : towardDirs(fc, wantCellOf(it.want));
    sideDirs.set(
      front!,
      [...new Set([...(sideDirs.get(front!) ?? []), ...dirs])].sort((a, b) => a - b),
    );
  }
  const adjacency = new Map<number, number[]>();
  for (const [a, b] of edges) {
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  const pinned = new Set(Object.keys(ov.nodeCell).map(Number));
  const flips = flipCorners({ cells, adjacency, sideDirs, pinned, issues });
  const occ = new Occupancy();
  for (const t of sem.tiles) {
    const c = cells.get(t.id)!;
    if (occ.isFree(c)) occ.claim(c, { kind: 'tile', id: String(t.id) });
  }

  // 2. 连边：软约束避开住宅地目标格（1）、地块侧的格（2）、设施两侧的 2×2 候选（2）
  const avoidRoute = new Map<string, number>();
  const bump = (c: Cell, w: number) => avoidRoute.set(ck(c), (avoidRoute.get(ck(c)) ?? 0) + w);
  for (const v of landWant.values()) bump(wantCellOf(v), 1);
  for (const [id, dirs] of sideDirs) {
    const c = cells.get(id)!;
    for (const d of dirs) bump({ x: c.x + DIRS4[d]!.x, y: c.y + DIRS4[d]!.y }, 2);
  }
  for (const f of sem.facilities) {
    const fronts = f.frontTiles.map((id) => cells.get(id)).filter((c): c is Cell => c !== undefined);
    for (const r of rectsAround(fronts, 2, 2)) for (const c of rectCells(r)) bump(c, 2);
  }
  const routes = routeEdges({ edges, cells, occ, avoid: avoidRoute, overrides: ov.edgeRoute, issues });

  // 住宅地候选格：矩形类放置尽量不要压住
  const landSpots = new Set<string>();
  for (const l of sem.lands) {
    const want = wantCellOf(landWant.get(l.id)!);
    for (const f of l.frontTiles) {
      const fc = cells.get(f);
      if (!fc) continue;
      for (const n of neighbors4(fc)) if (occ.isFree(n) && manhattan(n, want) <= 2) landSpots.add(ck(n));
    }
  }
  const ctx: PlaceCtx = { cells, occ, avoid: landSpots, issues };

  // 3–5. 设施、企业、关押地标
  const lotRects = new Map<string, Rect>();
  const fac = placeFacilities(
    sem.facilities.map((f) => ({ id: f.id, fronts: f.frontTiles, want: toLattice(f.world) })),
    ov.lot,
    ctx,
  );
  const com = placeCompanies(
    sem.companies.map((c) => ({ id: c.id, fronts: c.frontTiles, want: toLattice(c.world) })),
    ov.lot,
    ctx,
  );
  const hidden = sem.landmarks.filter((m) => ov.landmark[m.id]?.hidden === true && m.holdTile === undefined);
  const visible = sem.landmarks.filter((m) => !hidden.includes(m));
  const lmItems = visible.map((m) => ({ id: m.id, want: toLattice(m.world), holdTile: m.holdTile }));
  const holds = placeHoldLandmarks(lmItems, ov.landmark, ctx);

  // 6. 住宅地（匈牙利）
  const lands = placeLands(landItems, ov.lot, { ...ctx, avoid: new Set() }, lattice.transform);

  // 7. 风景地标
  const scenery = placeScenery(lmItems, ov.landmark, { ...ctx, avoid: new Set() });

  for (const [k, r] of [...fac, ...com, ...lands.rects]) lotRects.set(k, r);
  const landmarkRects = new Map<string, Rect>([...holds, ...scenery]);

  // 8. 紧凑；9. 边界与地形
  const occupied = occ.cells();
  const compact = ov.compact ? compactGrid(occupied) : null;
  const afterCompact = (c: Cell): Cell => (compact ? compact.mapCell(c) : { x: c.x, y: c.y });
  const margin = ov.terrain.margin ?? DEFAULT_MARGIN;
  const bounds = computeBounds(occupied.map(afterCompact), margin);
  const toGrid = (c: Cell): Cell => {
    const m = afterCompact(c);
    return { x: m.x + bounds.shift.x, y: m.y + bounds.shift.y };
  };
  const mapRect = (r: Rect): Rect => {
    const a = toGrid({ x: r.x, y: r.y });
    const b = toGrid({ x: r.x + r.w - 1, y: r.y + r.h - 1 });
    return { x: a.x, y: a.y, w: b.x - a.x + 1, h: b.y - a.y + 1 };
  };
  const paint = (ov.terrain.paint ?? []).map((p) => ({ rect: mapRect(toRect(p.rect)), t: p.t }));
  const terrain = buildTerrain(occupied.map(toGrid), bounds.w, bounds.h, paint);

  const tileCells = new Map<number, Cell>();
  for (const t of sem.tiles) tileCells.set(t.id, toGrid(cells.get(t.id)!));
  const vias = new Map<string, Cell[]>();
  for (const [k, v] of routes.vias) vias.set(k, v.map(toGrid));
  const finalLots = new Map<string, Rect>();
  for (const [k, r] of lotRects) finalLots.set(k, mapRect(r));
  const finalLandmarks = new Map<string, Rect>();
  for (const [k, r] of landmarkRects) finalLandmarks.set(k, mapRect(r));

  const offSide: string[] = [];
  if (lands.facing.enabled) {
    for (const it of landItems) {
      const r = lands.rects.get(it.id);
      const fc = cells.get(it.fronts[0] ?? -1);
      if (!r || !fc || r.w !== 1 || r.h !== 1) continue;
      if (!facingDirs(it.facing, lattice.transform).includes(dirIndex(fc, { x: r.x, y: r.y }))) offSide.push(it.id);
    }
  }

  const edgeKinds: Record<EdgeRouteKind, number> = { unit: 0, straight: 0, L: 0, detour: 0, override: 0 };
  for (const k of routes.kinds.values()) edgeKinds[k]++;

  const linked = new Set(edges.map(([a, b]) => `${a}-${b}`));
  const tileAt = new Map<string, number>();
  for (const [id, c] of tileCells) tileAt.set(ck(c), id);
  const unlinkedAdjacent: [number, number][] = [];
  for (const [id, c] of [...tileCells].sort((p, q) => p[0] - q[0])) {
    for (const d of [DIRS4[1]!, DIRS4[2]!]) {
      const other = tileAt.get(ck({ x: c.x + d.x, y: c.y + d.y }));
      if (other === undefined) continue;
      const [a, b] = id < other ? [id, other] : [other, id];
      if (!linked.has(`${a}-${b}`)) unlinkedAdjacent.push([a, b]);
    }
  }
  unlinkedAdjacent.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  for (const [a, b] of unlinkedAdjacent) {
    issues.add('W_TILES_TOUCH', 'warn', `路格 ${a} 与 ${b} 在网格上相邻但没有边相连`, { tiles: [a, b] });
  }

  const finalIssues = issues.list.map((i) => (i.cells ? { ...i, cells: i.cells.map(toGrid) } : { ...i }));
  return {
    lattice,
    tileCells,
    vias,
    roadCells: routes.roadCells.map(toGrid).sort(compareCells),
    lotRects: finalLots,
    landmarkRects: finalLandmarks,
    grid: { w: bounds.w, h: bounds.h },
    terrain: terrain.rows,
    toGrid,
    toLattice,
    report: {
      schema: 'rich4.geometry-report/1',
      mapKey: sem.mapKey,
      source: sem.source,
      lattice,
      routes: routes.stats,
      edgeKinds,
      facing: lands.facing,
      landsRelaxed: lands.relaxed,
      landsOffSide: offSide,
      cornerFlips: flips.flipped,
      unlinkedAdjacent,
      compact: {
        enabled: ov.compact,
        removedCols: compact?.removedCols ?? [],
        removedRows: compact?.removedRows ?? [],
      },
      bounds: { margin, shift: bounds.shift, w: bounds.w, h: bounds.h },
      terrain: terrain.counts,
      overrides: countOverrides(ov),
      hiddenLandmarks: hidden.map((m) => m.id),
      issues: finalIssues,
    },
  };
}

export function geometryErrors(g: GeometryResult): GeoIssue[] {
  return g.report.issues.filter((i) => i.severity === 'error');
}

/** 从 from 指向 to 的 4-邻方向下标（x、y 分量各取一个）。 */
function towardDirs(from: Cell, to: Cell): number[] {
  const out: number[] = [];
  if (to.y < from.y) out.push(0);
  if (to.x > from.x) out.push(1);
  if (to.y > from.y) out.push(2);
  if (to.x < from.x) out.push(3);
  return out;
}
