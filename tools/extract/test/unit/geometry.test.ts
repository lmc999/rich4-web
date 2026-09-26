import { describe, expect, it } from 'vitest';
import { compactGrid } from '../../src/map/geometry/compact';
import { assignmentCost, hungarian } from '../../src/map/geometry/hungarian';
import { applyTransform, detectLattice } from '../../src/map/geometry/lattice';
import { placeCompanies } from '../../src/map/geometry/placeCompanies';
import { placeFacilities } from '../../src/map/geometry/placeFacilities';
import { placeHoldLandmarks, placeScenery } from '../../src/map/geometry/placeLandmarks';
import { facingDirs, placeLands } from '../../src/map/geometry/placeLands';
import { quantizeCell, quantizeTiles } from '../../src/map/geometry/quantize';
import { flipCorners } from '../../src/map/geometry/refine';
import { routeEdges, viaFrom } from '../../src/map/geometry/routeEdges';
import { buildTerrain, chebyshevField, computeBounds } from '../../src/map/geometry/terrain';
import { type Cell, ck, GeoIssues, Occupancy } from '../../src/map/geometry/types';
import { perimeter } from '../helpers/syntheticMap';

/** 确定性伪随机（仅测试用） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function ringPoints(w: number, h: number, step: number, ox: number, oy: number) {
  const per = perimeter(w, h);
  const points = per.map((p, i) => ({ id: i + 1, x: ox + p.x * step, y: oy + p.y * step }));
  const edges = per.map((_, i) => {
    const a = i + 1;
    const b = ((i + 1) % per.length) + 1;
    return [Math.min(a, b), Math.max(a, b)] as [number, number];
  });
  return { points, edges };
}

describe('lattice 格点检测', () => {
  it('32 格点上的轴向环 → mode tile，原点取残差众数', () => {
    const { points, edges } = ringPoints(6, 5, 32, 7, 20);
    const lat = detectLattice(points, edges);
    expect(lat.mode).toBe('tile');
    expect(lat.tile).toBe(32);
    expect(lat.origin).toEqual([7, 20]);
    expect(lat.steps.unitAxial).toBe(edges.length);
    expect(lat.probe32.coverage).toBe(1);
  });

  it('48 步长、带斜向边 → mode fitted，T=48 且没有节点同格', () => {
    const pts = [
      { id: 1, x: 100, y: 100 },
      { id: 2, x: 148, y: 100 },
      { id: 3, x: 196, y: 100 },
      { id: 4, x: 229, y: 133 },
      { id: 5, x: 262, y: 166 },
      { id: 6, x: 262, y: 214 },
      { id: 7, x: 214, y: 214 },
      { id: 8, x: 166, y: 214 },
      { id: 9, x: 118, y: 214 },
      { id: 10, x: 100, y: 166 },
    ];
    const edges = pts.map((_, i) => [i + 1, ((i + 1) % pts.length) + 1].sort((a, b) => a - b) as [number, number]);
    const lat = detectLattice(pts, edges);
    expect(lat.mode).toBe('fitted');
    expect(lat.tile).toBe(48);
    expect(lat.score.collisions).toBe(0);
    expect(lat.edgeDirections.diagonal).toBe(2);
  });

  it('override 的 tile/origin/transform 直接采用', () => {
    const { points, edges } = ringPoints(6, 5, 32, 7, 20);
    const lat = detectLattice(points, edges, { tile: 16, origin: [1, 2], transform: 'rot90' });
    expect([lat.tile, lat.origin, lat.transform, lat.mode]).toEqual([16, [1, 2], 'rot90', 'fitted']);
    expect(lat.overridden).toEqual({ tile: true, origin: true, transform: true });
  });

  it('transform：rot90 等为整数格上的双射', () => {
    const v = { x: 3, y: -2 };
    expect(applyTransform(v, 'rot90')).toEqual({ x: 2, y: 3 });
    expect(applyTransform(applyTransform(v, 'rot90'), 'rot270')).toEqual(v);
    expect(applyTransform(v, 'flipX')).toEqual({ x: -3, y: -2 });
    expect(quantizeCell({ x: 55, y: 30 }, { tile: 32, origin: [0, 0], transform: 'rot180' })).toEqual({ x: -2, y: -1 });
  });
});

describe('quantize 与碰撞', () => {
  it('两个节点落在同一格 → E_CELL_COLLIDE；nodeCell override 可消解', () => {
    const lat = { tile: 32, origin: [0, 0] as [number, number], transform: 'identity' as const };
    const tiles = [
      { id: 1, world: { x: 0, y: 0 } },
      { id: 2, world: { x: 10, y: 5 } },
    ];
    const issues = new GeoIssues();
    quantizeTiles(tiles, lat, {}, issues);
    expect(issues.errors.map((i) => i.code)).toEqual(['E_CELL_COLLIDE']);
    const ok = new GeoIssues();
    const cells = quantizeTiles(tiles, lat, { '2': [1, 0] }, ok);
    expect(ok.errors).toEqual([]);
    expect(cells.get(2)).toEqual({ x: 1, y: 0 });
  });
});

describe('routeEdges 连边', () => {
  const setup = (pos: Record<number, [number, number]>) => {
    const cells = new Map(Object.entries(pos).map(([k, v]) => [Number(k), { x: v[0], y: v[1] }]));
    const occ = new Occupancy();
    for (const [id, c] of cells) occ.claim(c, { kind: 'tile', id: String(id) });
    return { cells, occ, issues: new GeoIssues() };
  };

  it('单位边直连；长直边内部格为 via；对角边取 L 形并避开软约束格', () => {
    const { cells, occ, issues } = setup({ 1: [0, 0], 2: [1, 0], 3: [4, 0], 4: [5, 1] });
    const avoid = new Map([[ck({ x: 5, y: 0 }), 2]]);
    const r = routeEdges({
      edges: [
        [1, 2],
        [2, 3],
        [3, 4],
      ],
      cells,
      occ,
      avoid,
      overrides: {},
      issues,
    });
    expect(r.vias.get('1-2')).toEqual([]);
    expect(r.vias.get('2-3')).toEqual([
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
    expect(r.vias.get('3-4')).toEqual([{ x: 4, y: 1 }]);
    expect(r.stats).toMatchObject({ unit: 1, straight: 1, lShape: 1, diagonal: 1, viaCells: 3 });
    expect(viaFrom(r.vias, 4, 3)).toEqual([{ x: 4, y: 1 }]);
    expect(r.roadCells).toHaveLength(3);
  });

  it('平手时按肘点 (x,y) 字典序', () => {
    const { cells, occ, issues } = setup({ 1: [0, 0], 2: [1, 1] });
    const r = routeEdges({ edges: [[1, 2]], cells, occ, avoid: new Map(), overrides: {}, issues });
    expect(r.vias.get('1-2')).toEqual([{ x: 0, y: 1 }]);
  });

  it('长直与 L 形都被占 → 绕行（warn）；完全封死 → E_ROUTE_BLOCKED', () => {
    const { cells, occ, issues } = setup({ 1: [0, 0], 2: [2, 0], 3: [1, 0] });
    const r = routeEdges({ edges: [[1, 2]], cells, occ, avoid: new Map(), overrides: {}, issues });
    expect(r.kinds.get('1-2')).toBe('detour');
    expect(r.vias.get('1-2')).toHaveLength(3);
    expect(issues.list.map((i) => i.code)).toEqual(['W_ROUTE_DETOUR']);

    const b = setup({ 1: [0, 0], 2: [2, 0] });
    for (let x = -5; x <= 7; x++)
      for (let y = -5; y <= 5; y++) if (b.occ.isFree({ x, y })) b.occ.claim({ x, y }, { kind: 'lot', id: 'X' });
    routeEdges({ edges: [[1, 2]], cells: b.cells, occ: b.occ, avoid: new Map(), overrides: {}, issues: b.issues });
    expect(b.issues.errors.map((i) => i.code)).toEqual(['E_ROUTE_BLOCKED']);
  });

  it('edgeRoute override 生效；不连续时报错', () => {
    const { cells, occ, issues } = setup({ 1: [0, 0], 2: [1, 1] });
    const r = routeEdges({ edges: [[1, 2]], cells, occ, avoid: new Map(), overrides: { '1-2': [[1, 0]] }, issues });
    expect(r.vias.get('1-2')).toEqual([{ x: 1, y: 0 }]);
    expect(r.kinds.get('1-2')).toBe('override');
    const bad = setup({ 1: [0, 0], 2: [1, 1] });
    routeEdges({ edges: [[1, 2]], ...bad, avoid: new Map(), overrides: { '1-2': [[3, 3]] } });
    expect(bad.issues.errors.map((i) => i.code)).toEqual(['E_ROUTE_OVERRIDE']);
  });

  it('长直边先于 L 形边处理，避免抢走唯一的途经格', () => {
    // 13(23,35)–14(24,37) 是 L 形，36(22,37)–14 是长直：长直必须拿到 (23,37)
    const { cells, occ, issues } = setup({ 13: [23, 35], 14: [24, 37], 36: [22, 37] });
    const r = routeEdges({
      edges: [
        [13, 14],
        [14, 36],
      ],
      cells,
      occ,
      avoid: new Map(),
      overrides: {},
      issues,
    });
    expect(r.kinds.get('14-36')).toBe('straight');
    expect(r.kinds.get('13-14')).toBe('L');
    expect(issues.list).toEqual([]);
  });
});

describe('hungarian 指派', () => {
  const brute = (cost: number[][]): number => {
    const n = cost.length;
    const m = cost[0]!.length;
    let best = Number.POSITIVE_INFINITY;
    const used = new Array<boolean>(m).fill(false);
    const rec = (i: number, acc: number) => {
      if (i === n) {
        best = Math.min(best, acc);
        return;
      }
      for (let j = 0; j < m; j++) {
        if (used[j]) continue;
        used[j] = true;
        rec(i + 1, acc + cost[i]![j]!);
        used[j] = false;
      }
    };
    rec(0, 0);
    return best;
  };

  it('与穷举一致（随机 n≤m≤6，200 组）', () => {
    const rnd = lcg(42);
    for (let k = 0; k < 200; k++) {
      const n = 1 + Math.floor(rnd() * 5);
      const m = n + Math.floor(rnd() * 2);
      const cost = Array.from({ length: n }, () => Array.from({ length: m }, () => Math.floor(rnd() * 50)));
      const a = hungarian(cost);
      expect(new Set(a).size).toBe(n);
      expect(assignmentCost(cost, a)).toBe(brute(cost));
    }
  });

  it('输入相同输出相同；列数少于行数时报错', () => {
    const cost = [
      [1, 1, 1],
      [1, 1, 1],
    ];
    expect(hungarian(cost)).toEqual(hungarian(cost));
    expect(() => hungarian([[1], [2]])).toThrow();
    expect(hungarian([])).toEqual([]);
  });
});

describe('地块放置', () => {
  const ctxOf = (pos: Record<number, [number, number]>) => {
    const cells = new Map(Object.entries(pos).map(([k, v]) => [Number(k), { x: v[0], y: v[1] }]));
    const occ = new Occupancy();
    for (const [id, c] of cells) occ.claim(c, { kind: 'tile', id: String(id) });
    return { cells, occ, avoid: new Set<string>(), issues: new GeoIssues() };
  };

  it('设施 2×2 选离世界坐标近的一侧；side override 强制另一侧', () => {
    const ctx = ctxOf({ 1: [0, 0], 2: [1, 0] });
    const r = placeFacilities([{ id: 'F1', fronts: [1, 2], want: { x: 0.5, y: 1.5 } }], {}, ctx);
    expect(r.get('F1')).toEqual({ x: 0, y: 1, w: 2, h: 2 });
    const ctx2 = ctxOf({ 1: [0, 0], 2: [1, 0] });
    const r2 = placeFacilities([{ id: 'F1', fronts: [1, 2], want: { x: 0.5, y: 1.5 } }], { F1: { side: 'a' } }, ctx2);
    expect(r2.get('F1')).toEqual({ x: 0, y: -2, w: 2, h: 2 });
  });

  it('企业前沿格相距过远：与尽量多的前沿格相邻，其余记 W_COMPANY_REMOTE_FRONT', () => {
    const ctx = ctxOf({ 1: [0, 0], 2: [20, 0] });
    const r = placeCompanies([{ id: 'C1', fronts: [1, 2], want: { x: 0.5, y: 1.5 } }], {}, ctx);
    expect(r.get('C1')).toEqual({ x: 0, y: 1, w: 2, h: 2 });
    expect(ctx.issues.list.find((i) => i.code === 'W_COMPANY_REMOTE_FRONT')?.tiles).toEqual([2]);
  });

  it('关押地标 2×2 与关押格相邻；风景地标螺旋找空位', () => {
    const ctx = ctxOf({ 1: [0, 0] });
    const holds = placeHoldLandmarks([{ id: '1', want: { x: 1.5, y: 0.5 }, holdTile: 1 }], {}, ctx);
    expect(holds.get('1')).toEqual({ x: 1, y: 0, w: 2, h: 2 });
    const sc = placeScenery([{ id: '3', want: { x: 1.5, y: 0.5 } }], {}, ctx);
    const r = sc.get('3')!;
    expect(ctx.occ.owner({ x: r.x, y: r.y })?.id).toBe('3');
    expect([r.w, r.h]).toEqual([2, 2]);
  });

  it('住宅地匈牙利指派：冲突由全局最优解开，facing 统计达 90% 时启用', () => {
    // 一条横街 1..4，住宅地都想要北侧；第 5 块地的期望格与第 1 块相同
    const ctx = ctxOf({ 1: [0, 0], 2: [1, 0], 3: [2, 0], 4: [3, 0] });
    const lands = [1, 2, 3, 4].map((id) => ({ id: `L${id}`, fronts: [id], want: { x: id - 1, y: -1 }, facing: 0 }));
    lands.push({ id: 'L5', fronts: [1], want: { x: 0, y: -1 }, facing: 0 });
    const r = placeLands(lands, {}, ctx, 'identity');
    expect(r.facing.enabled).toBe(true);
    expect(r.rects.get('L2')).toEqual({ x: 1, y: -1, w: 1, h: 1 });
    const l1 = r.rects.get('L1')!;
    const l5 = r.rects.get('L5')!;
    expect(ck(l1)).not.toBe(ck(l5));
    expect([l1, l5].some((c) => c.y === -1 && c.x === 0)).toBe(true);
  });

  it('facingDirs：8 方位 → 兼容的 4-邻方向，随 transform 旋转', () => {
    expect(facingDirs(0, 'identity')).toEqual([0]);
    expect(facingDirs(1, 'identity')).toEqual([0, 1]);
    expect(facingDirs(7, 'identity')).toEqual([0, 3]);
    expect(facingDirs(0, 'rot90')).toEqual([1]);
    expect(facingDirs(9, 'identity')).toEqual([]);
  });
});

describe('拐角翻转', () => {
  it('地块侧被路径两邻格堵住的拐角 → 翻到对角', () => {
    // 44(1,0) ↓ 45(1,1) ← 46(0,1)... 45 的住宅地要 N 或 W，均被占
    const cells = new Map<number, Cell>([
      [44, { x: 1, y: 0 }],
      [45, { x: 1, y: 1 }],
      [46, { x: 0, y: 1 }],
    ]);
    const adjacency = new Map([
      [44, [45]],
      [45, [44, 46]],
      [46, [45]],
    ]);
    const issues = new GeoIssues();
    const r = flipCorners({ cells, adjacency, sideDirs: new Map([[45, [0, 3]]]), pinned: new Set(), issues });
    expect(r.flipped).toEqual([45]);
    expect(cells.get(45)).toEqual({ x: 0, y: 0 });
    const pinned = new Map(cells);
    pinned.set(45, { x: 1, y: 1 });
    expect(
      flipCorners({ cells: pinned, adjacency, sideDirs: new Map([[45, [0, 3]]]), pinned: new Set([45]), issues })
        .flipped,
    ).toEqual([]);
  });
});

describe('紧凑、边界与地形', () => {
  it('删除空列空行，但不让原本不相邻的格变相邻', () => {
    const occ: Cell[] = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 5 },
      { x: 6, y: 5 },
    ];
    const c = compactGrid(occ);
    // 列 1、2 之间：删掉 1 与 2 中的一个后 0 与 3 会相邻（同一行 y=0），所以只能删一个
    expect(c.removedCols).toEqual([1, 4]);
    expect(c.mapCell({ x: 3, y: 0 })).toEqual({ x: 2, y: 0 });
    expect(c.removedRows).toEqual([1, 2, 3]);
  });

  it('边界留白并平移；外海 w/s、内陆远处为 m、其余 g', () => {
    const ring: Cell[] = perimeter(12, 12).map((p) => ({ x: p.x + 10, y: p.y + 10 }));
    const b = computeBounds(ring, 5);
    expect(b).toEqual({ shift: { x: -5, y: -5 }, w: 22, h: 22 });
    const shifted = ring.map((c) => ({ x: c.x + b.shift.x, y: c.y + b.shift.y }));
    const t = buildTerrain(shifted, b.w, b.h, [{ rect: { x: 0, y: 0, w: 1, h: 1 }, t: 'p' }]);
    expect(t.rows).toHaveLength(22);
    expect(t.rows.every((r) => r.length === 22)).toBe(true);
    expect(t.rows[0]![0]).toBe('p');
    expect(t.rows[0]![5]).toBe('w');
    expect(t.rows[2]![5]).toBe('s');
    expect(t.rows[10]![10]).toBe('m');
    expect(t.rows[5]![5]).toBe('g');
    expect(chebyshevField([{ x: 1, y: 1 }], 3, 3)).toEqual([1, 1, 1, 1, 0, 1, 1, 1, 1]);
  });
});
