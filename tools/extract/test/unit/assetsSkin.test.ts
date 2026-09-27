/**
 * 原版皮肤 A2：地图皮肤（投影拟合的轴序、精确表展平、原版/合成皮肤与 MapDef 的绑定）。只用合成数据。
 */
import {
  checkMapSkinBinding,
  EXACT_TABLE_SPAN,
  mapSkinBindingOf,
  projectWorld,
  unprojectScreen,
} from '@rich4/shared/assets';
import { buildFixtureMaps, type MapDef } from '@rich4/shared/data';
import { describe, expect, it } from 'vitest';
import {
  buildOriginalSkin,
  buildSyntheticSkin,
  exactTables,
  fitViewAffines,
  syntheticViews,
  type ViewTablesInput,
} from '../../src/assets/skin';
import { ExtractError } from '../../src/context';
import type { MapDataRaw } from '../../src/map/rawTypes';

const HALF = (EXACT_TABLE_SPAN - 1) / 2;

/** 按 [view][dy+14][dx+14] → (sy, sx) 生成视角表（与 exe 表同一轴序） */
function table(coef: (v: number) => [number, number, number, number, number, number]): ViewTablesInput {
  const data: [number, number][][] = [];
  for (let v = 0; v < 8; v++) {
    const [ax, bx, cx, ay, by, cy] = coef(v);
    const t: [number, number][] = [];
    for (let dy = -HALF; dy <= HALF; dy++) {
      for (let dx = -HALF; dx <= HALF; dx++) t.push([ay * dx + by * dy + cy, ax * dx + bx * dy + cx]);
    }
    data.push(t);
  }
  return {
    cellScreen: { va: '0xtest', data },
    subcell: { va: '0xtest', data: Array.from({ length: 8 }, (_, v) => [v, -v, 2 * v, -2 * v]) },
  };
}

describe('视角表拟合', () => {
  it('轴序：表项为 (sy, sx)、dy 在外层；sx 只随 dx 变化时 a=1、c=0', () => {
    const fits = fitViewAffines(table(() => [32, 0, 0, 0, 16, 0]));
    expect(fits[0]!.affine).toEqual({ a: 1, b: 0, c: 0, d: 0.5, tx: 0, ty: 0, maxErrPx: 0 });
  });

  it('精确恢复整数系数（按世界像素 = 格差系数 / 32）', () => {
    const fits = fitViewAffines(table((v) => [36, 15, -2 + v, -10, 25, 1]));
    expect(fits[3]!.sx).toEqual([36, 15, 1]);
    expect(fits[3]!.sy).toEqual([-10, 25, 1]);
    expect(fits[3]!.affine).toEqual({ a: 1.125, b: -0.3125, c: 0.46875, d: 0.78125, tx: 1, ty: 1, maxErrPx: 0 });
  });

  it('带取整噪声时最大误差不超过 1px 级别，形状不对时报错', () => {
    const exact = table(() => [36.012, 14.864, -1.6, -10.527, 25.524, -1.1]);
    const noisy: ViewTablesInput = {
      cellScreen: { data: exact.cellScreen.data.map((t) => t.map(([sy, sx]) => [Math.round(sy), Math.round(sx)])) },
      subcell: exact.subcell,
    };
    const fits = fitViewAffines(noisy);
    expect(fits[0]!.affine.maxErrPx).toBeLessThan(1);
    expect(Math.abs(fits[0]!.affine.a - 36.012 / 32)).toBeLessThan(1e-3);
    expect(() => fitViewAffines({ cellScreen: { data: [] }, subcell: { data: [] } })).toThrow(ExtractError);
  });

  it('精确表按 [view][dy][dx] → (sy, sx) 展平', () => {
    const t = table((v) => [36, 15, v, -10, 25, -v]);
    const ex = exactTables(t, ['x']);
    expect(ex.cellScreen).toHaveLength(8 * 29 * 29 * 2);
    expect(ex.cellScreen.slice(0, 2)).toEqual(t.cellScreen.data[0]![0]);
    expect(ex.subcell).toHaveLength(32);
  });
});

// ───────────────────────── 原版皮肤（合成 raw + MapDef） ─────────────────────────

const RES_SHA = 'a'.repeat(64);

function miniMap(): { def: MapDef; raw: MapDataRaw } {
  const def = {
    id: 'mini',
    meta: { source: { id: 'v206-mapdat', fileSha256: 'b'.repeat(64), resourceSha256: RES_SHA } },
    tiles: [
      { id: 1, world: { x: 100, y: 100 } },
      { id: 2, world: { x: 200, y: 100 } },
      { id: 3, world: { x: 300, y: 100 } },
    ],
    lots: [
      { id: 'L1', kind: 'land', world: { x: 150, y: 150 }, facing: 2 },
      { id: 'F1', kind: 'facility', world: { x: 250, y: 150 }, facing: 7 },
    ],
    companies: [{ id: 'C1', world: { x: 350, y: 150 }, facing: 1 }],
    landmarks: [{ id: '1', kind: 'hospital' }],
  } as unknown as MapDef;
  const raw = {
    source: { resourceSha256: RES_SHA, file: 'Game/MapDat.MKF', resource: 0 },
    nodes: [
      { id: 1, x: 100, y: 100, decor: 5, flags: 0x80000000 },
      { id: 2, x: 200, y: 100, decor: 0, flags: 0 },
      { id: 3, x: 300, y: 100, decor: 17, flags: 0x80000002 },
    ],
    lands: [{ id: 1, x: 150, y: 150, facing: 2 }],
    facilities: [{ id: 1, x: 250, y: 150, facing: 7 }],
    companies: [{ id: 1, x: 350, y: 150, facing: 1, spriteRes: 49 }],
    landscapes: [
      { id: 1, x: 50, y: 60, facing: 7, spriteRes: 61 },
      { id: 2, x: 70, y: 80, facing: 3, spriteRes: 118 },
    ],
  } as unknown as MapDataRaw;
  return { def, raw };
}

function originalInput(def: MapDef, raw: MapDataRaw) {
  return {
    mapDef: def,
    raw,
    view: table((v) => [36, 15, v, -10, 25, 0]),
    world: { w: 512, h: 512 },
    ground: { chunks: [{ file: 'ground/mini/0_0.png', x: 0, y: 0, w: 512, h: 512 }], overlap: 0 },
    decorFrames: 17,
    keys: {
      minimap: null,
      decor: 'board.decor',
      houses: [1, 2, 3, 4, 5].map((L) => `map.mini.house.${L}`),
      chain: 'board.chain',
      ownerMark: 'board.ownerMark',
      lotHighlight: 'board.lotHighlight',
    },
    src: ['test'],
    expectSprites: { companies: [75], scenery: [87, 144] },
  };
}

describe('原版地图皮肤', () => {
  it('装饰帧 = decor−1、快艇节点 = flags bit31、景观/企业精灵 = spriteRes+26，绑定 resourceSha256 + 几何摘要', () => {
    const { def, raw } = miniMap();
    const skin = buildOriginalSkin(originalInput(def, raw));
    expect(skin.decor.nodes).toEqual([
      { tile: 1, frame: 4 },
      { tile: 3, frame: 16 },
    ]);
    expect(skin.boatTiles).toEqual([1, 3]);
    expect(skin.scenery.map((s) => [s.id, s.sprite, s.facing, s.landmark])).toEqual([
      ['S1', 'board.landmark.87', 7, '1'],
      ['S2', 'board.landmark.144', 3, null],
    ]);
    expect(skin.buildings.companies).toEqual([{ lot: 'C1', sprite: 'board.landmark.75', spriteId: 49 }]);
    expect(skin.binding).toEqual(mapSkinBindingOf(def));
    expect(skin.binding.resourceSha256).toBe(RES_SHA);
    expect(checkMapSkinBinding(skin, def)).toEqual([]);
    expect(skin.projection.origin).toEqual({ x: 220, y: 260 });
    expect(skin.projection.cameraClamp?.confidence).toBe('guess');
    expect(skin.projection.exact?.cellScreen).toHaveLength(8 * 29 * 29 * 2);
  });

  it('raw 与 MapDef 不同源或几何不一致时失败', () => {
    const a = miniMap();
    (a.raw.source as { resourceSha256: string }).resourceSha256 = 'c'.repeat(64);
    expect(() => buildOriginalSkin(originalInput(a.def, a.raw))).toThrow(/E_SKIN_MISMATCH/);
    const b = miniMap();
    (b.raw.nodes[1] as { x: number }).x = 201;
    expect(() => buildOriginalSkin(originalInput(b.def, b.raw))).toThrow(/节点 2/);
    const c = miniMap();
    (c.raw.lands[0] as { facing: number }).facing = 3;
    expect(() => buildOriginalSkin(originalInput(c.def, c.raw))).toThrow(/地块 L1/);
    const d = miniMap();
    expect(() =>
      buildOriginalSkin({ ...originalInput(d.def, d.raw), expectSprites: { companies: [80], scenery: [87, 144] } }),
    ).toThrow(/资源目录不符/);
  });
});

describe('合成皮肤（fixture 地图）', () => {
  it('两张 fixture 地图都能生成合契约的皮肤，绑定 fixture 身份，投影可逆', () => {
    for (const def of buildFixtureMaps()) {
      const skin = buildSyntheticSkin({
        mapDef: def,
        ground: {
          chunks: [{ file: `ground/${def.id}/0_0.png`, x: 0, y: 0, w: def.grid.w * 32, h: def.grid.h * 32 }],
          overlap: 0,
        },
        keys: {
          decor: 'board.decor',
          houses: [1, 2, 3, 4, 5].map((L) => `map.${def.id}.house.${L}`),
          chain: 'board.chain',
          ownerMark: 'board.ownerMark',
          lotHighlight: 'board.lotHighlight',
        },
        companySprites: ['c'],
        landmarkSprites: { hospital: 'h', jail: 'j', scenery: 's' },
      });
      expect(skin.binding.resourceSha256).toBeNull();
      expect(checkMapSkinBinding(skin, def)).toEqual([]);
      expect(skin.buildings.companies).toHaveLength(def.companies.length);
      expect(skin.decor.nodes.every((n) => n.frame >= 0 && n.frame < 16)).toBe(true);
      const cam = { x: 64, y: 64 };
      for (const v of skin.projection.views) {
        const s = projectWorld(v, skin.projection.origin, cam, { x: 100, y: 40 });
        const w = unprojectScreen(v, skin.projection.origin, cam, s);
        expect(Math.abs(w.x - 100) + Math.abs(w.y - 40)).toBeLessThan(1e-6);
      }
    }
  });

  it('合成投影与原版同形（视角 0 约为 1.125/0.465/−0.33/0.797），每步 45°', () => {
    const v = syntheticViews();
    expect(v[0]!.a).toBeCloseTo(1.1245, 3);
    expect(v[0]!.c).toBeCloseTo(0.4658, 3);
    expect(v[0]!.b).toBeCloseTo(-0.3301, 3);
    expect(v[0]!.d).toBeCloseTo(0.7968, 3);
    expect(v[4]!.a).toBeCloseTo(-v[0]!.a, 6);
  });
});
