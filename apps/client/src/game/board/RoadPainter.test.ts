import { buildTestMap, buildTestMapAllKinds, cellKey } from '@rich4/shared/data';
import { describe, expect, it } from 'vitest';
import { ROTATIONS } from '../iso/projection';
import {
  buildRoadGraph,
  DIR_E,
  DIR_N,
  DIR_S,
  DIR_W,
  dirBit,
  linkChain,
  ROAD_PIECE_BASE,
  type RoadPieceKind,
  roadPieceFor,
  rotateMask,
} from './RoadPainter';

describe('16 种拼接', () => {
  it('每个掩码唯一对应一种拼接，且 rotateMask(base, turns) 还原掩码', () => {
    const counts: Record<RoadPieceKind, number> = { isolated: 0, end: 0, straight: 0, corner: 0, tee: 0, cross: 0 };
    for (let m = 0; m < 16; m++) {
      const p = roadPieceFor(m);
      counts[p.kind]++;
      expect(rotateMask(ROAD_PIECE_BASE[p.kind], p.turns)).toBe(m);
    }
    expect(counts).toEqual({ isolated: 1, end: 4, straight: 2, corner: 4, tee: 4, cross: 1 });
  });

  it('典型掩码', () => {
    expect(roadPieceFor(DIR_E | DIR_W)).toMatchObject({ kind: 'straight', turns: 1 });
    expect(roadPieceFor(DIR_S | DIR_W)).toMatchObject({ kind: 'corner', turns: 2 });
    expect(roadPieceFor(DIR_N | DIR_E | DIR_W)).toMatchObject({ kind: 'tee', turns: 3 });
    expect(roadPieceFor(DIR_W)).toMatchObject({ kind: 'end', turns: 3 });
    expect(roadPieceFor(15).kind).toBe('cross');
    expect(roadPieceFor(0).kind).toBe('isolated');
  });

  it('rotateMask：N→E→S→W，转 4 次恒等', () => {
    expect(rotateMask(DIR_N, 1)).toBe(DIR_E);
    expect(rotateMask(DIR_W, 1)).toBe(DIR_N);
    expect(rotateMask(DIR_N | DIR_E, 2)).toBe(DIR_S | DIR_W);
    for (let m = 0; m < 16; m++) {
      let x = m;
      for (let i = 0; i < 4; i++) x = rotateMask(x, 1);
      expect(x).toBe(m);
      for (const r of ROTATIONS) expect(roadPieceFor(rotateMask(m, r)).kind).toBe(roadPieceFor(m).kind);
    }
  });

  it('dirBit 只接受单位轴向步', () => {
    expect(dirBit(0, -1)).toBe(DIR_N);
    expect(dirBit(1, 0)).toBe(DIR_E);
    expect(dirBit(1, 1)).toBe(0);
    expect(dirBit(2, 0)).toBe(0);
  });
});

describe('buildRoadGraph（fixture）', () => {
  it('test 图：拐角、T 字（含被封岔路 04→19 仍画路）、无断链', () => {
    const def = buildTestMap();
    const g = buildRoadGraph(def);
    expect(g.brokenSteps).toBe(0);
    const at = (x: number, y: number) => roadPieceFor(g.masks.get(`${x},${y}`) ?? 0);
    // 01 在 (2,2)：东连 02、南连 18
    expect(g.masks.get('2,2')).toBe(DIR_E | DIR_S);
    expect(at(2, 2).kind).toBe('corner');
    // 04 在 (5,2)：东 05、南 19（封路）、西 03
    expect(at(5, 2).kind).toBe('tee');
    // 13 在 (5,5)：随机岔路（北 20、东 12、西 14）
    expect(at(5, 5).kind).toBe('tee');
    // 02 直路
    expect(at(3, 2)).toMatchObject({ kind: 'straight' });
    expect(g.cells).toHaveLength(def.tiles.length);
    expect(g.viaCells.size).toBe(0);
  });

  it('test-allkinds：via 连接格为直路，死路尽头为 end', () => {
    const def = buildTestMapAllKinds();
    const g = buildRoadGraph(def);
    expect(g.brokenSteps).toBe(0);
    expect(g.viaCells).toEqual(new Set(['11,3', '12,3']));
    expect(g.masks.get('11,3')).toBe(DIR_E | DIR_W);
    expect(g.masks.get('12,3')).toBe(DIR_E | DIR_W);
    // 22 (10,3)：西 21、东经 via 到 23
    expect(g.masks.get('10,3')).toBe(DIR_E | DIR_W);
    // 26 (16,3)：死路
    expect(roadPieceFor(g.masks.get('16,3') ?? 0).kind).toBe('end');
    // 每个游戏格都至少连通一个方向
    for (const t of def.tiles) expect(g.masks.get(cellKey(t.cell))).toBeGreaterThan(0);
  });

  it('linkChain 带出 via（双向）', () => {
    const def = buildTestMapAllKinds();
    expect(linkChain(def, 22, 23)).toEqual([
      { x: 10, y: 3 },
      { x: 11, y: 3 },
      { x: 12, y: 3 },
      { x: 13, y: 3 },
    ]);
    expect(linkChain(def, 23, 22)).toEqual([
      { x: 13, y: 3 },
      { x: 12, y: 3 },
      { x: 11, y: 3 },
      { x: 10, y: 3 },
    ]);
  });
});
