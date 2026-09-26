import { buildTestMapAllKinds } from '@rich4/shared/data';
import { describe, expect, it } from 'vitest';
import { BoardGeometry } from '../board/BoardGeometry';
import { miniMapLayout, miniToWorld, worldToMini } from '../minimap/MiniMapPainter';
import { PickIndex } from './picking';
import { gridScreenBounds, ROTATIONS } from './projection';

const def = buildTestMapAllKinds();

describe('PickIndex', () => {
  const idx = new PickIndex(def);

  it('按格查到游戏格、地块、企业、地标、连接格', () => {
    expect(idx.at({ x: 5, y: 2 })).toMatchObject({ tile: 4, lot: null, road: false, inGrid: true, terrain: 'g' });
    expect(idx.at({ x: 6, y: 1 })).toMatchObject({ tile: null, lot: 'L1' });
    expect(idx.at({ x: 4, y: 4 })).toMatchObject({ lot: 'F1' });
    expect(idx.at({ x: 15, y: 5 })).toMatchObject({ lot: 'C3' });
    expect(idx.at({ x: 3, y: 7 })).toMatchObject({ landmark: '1' });
    expect(idx.at({ x: 11, y: 3 })).toMatchObject({ road: true, tile: null });
    expect(idx.at({ x: 6, y: 3 })).toMatchObject({ terrain: 'w' });
    expect(idx.at({ x: -1, y: 0 })).toMatchObject({ inGrid: false, terrain: null });
  });

  it('屏幕坐标拾取在 4 个旋转方向下都命中格中心所在的格', () => {
    const geo = new BoardGeometry(def);
    for (const r of ROTATIONS) {
      geo.setRotation(r);
      for (const t of def.tiles) {
        const p = geo.tileScreenPos(t.id);
        expect(idx.pickScreen(p.x, p.y, r).tile).toBe(t.id);
        expect(idx.pickScreen(p.x + 30, p.y + 5, r).tile).toBe(t.id);
      }
    }
  });
});

describe('BoardGeometry', () => {
  it('bounds 覆盖全部格，含顶部余量', () => {
    const geo = new BoardGeometry(def);
    for (const r of ROTATIONS) {
      geo.setRotation(r);
      const b = geo.bounds(100);
      const g = gridScreenBounds(def.grid, r);
      expect(b.y).toBe(g.y - 100);
      for (const t of def.tiles) {
        const p = geo.tileScreenPos(t.id);
        expect(p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h).toBe(true);
      }
    }
  });

  it('linkCells 对无 via 的相邻格就是两点；反向 via 自动倒序', () => {
    const geo = new BoardGeometry(def);
    expect(geo.linkCells(1, 2)).toEqual([
      { x: 2, y: 2 },
      { x: 3, y: 2 },
    ]);
    expect(geo.linkCells(23, 22).map((c) => c.x)).toEqual([13, 12, 11, 10]);
  });
});

describe('小地图布局', () => {
  it('整张图等比装入画布，换算可往返', () => {
    for (const r of ROTATIONS) {
      const l = miniMapLayout(def.grid, r, 220, 150, 6);
      const b = gridScreenBounds(def.grid, r);
      const tl = worldToMini(l, { x: b.x, y: b.y });
      const br = worldToMini(l, { x: b.x + b.w, y: b.y + b.h });
      expect(tl.x).toBeGreaterThanOrEqual(6 - 1e-9);
      expect(tl.y).toBeGreaterThanOrEqual(6 - 1e-9);
      expect(br.x).toBeLessThanOrEqual(214 + 1e-9);
      expect(br.y).toBeLessThanOrEqual(144 + 1e-9);
      const w = { x: 123, y: 45 };
      const back = miniToWorld(l, worldToMini(l, w));
      expect(back.x).toBeCloseTo(w.x, 9);
      expect(back.y).toBeCloseTo(w.y, 9);
    }
  });
});
