import { describe, expect, it } from 'vitest';
import { checkMapSkinRefs } from './crossref';
import {
  checkMapSkin,
  checkMapSkinBinding,
  type MapBindingInput,
  type MapSkinV1,
  mapGeometryCanonical,
  mapGeometryDigest,
  mapSkinBindingOf,
  parseMapSkin,
  projectWorld,
  safeParseMapSkin,
  unprojectScreen,
} from './mapskin';
import { syntheticManifest, syntheticMap, syntheticMapSkin } from './testing/synthetic';

const skinIssues = (mutate: (s: MapSkinV1) => void): string[] => {
  const s = structuredClone(syntheticMapSkin());
  mutate(s);
  const r = safeParseMapSkin(s);
  return r.ok ? [] : r.issues;
};

describe('几何摘要与绑定', () => {
  it('摘要与数组顺序无关，覆盖 tiles/lots/companies 的 world 与 facing', () => {
    const map = syntheticMap();
    const shuffled: MapBindingInput = { ...map, tiles: [...map.tiles].reverse(), lots: [...map.lots].reverse() };
    expect(mapGeometryDigest(shuffled)).toBe(mapGeometryDigest(map));
    expect(mapGeometryCanonical(map)).toBe(
      '{"companies":[["C1",96,64,0]],"lots":[["L1",64,64,2]],"tiles":[[1,32,32],[2,64,32],[3,96,32]],"v":1}',
    );
    const moved = structuredClone(map);
    moved.tiles = moved.tiles.map((t) => (t.id === 2 ? { ...t, world: { x: 65, y: 32 } } : t));
    expect(mapGeometryDigest(moved)).not.toBe(mapGeometryDigest(map));
    const turned = structuredClone(map);
    turned.companies = [{ id: 'C1', world: { x: 96, y: 64 }, facing: 1 }];
    expect(mapGeometryDigest(turned)).not.toBe(mapGeometryDigest(map));
    const noFacing = structuredClone(map);
    noFacing.lots = [{ id: 'L1', world: { x: 64, y: 64 } }];
    expect(mapGeometryDigest(noFacing)).not.toBe(mapGeometryDigest(map));
  });

  it('摘要不受 MapDef 其他字段影响（只看几何）', () => {
    const map = syntheticMap();
    const extra = {
      ...map,
      tiles: map.tiles.map((t) => ({ ...t, kind: 'plain', links: [] })),
      nameKey: 'x',
    };
    expect(mapGeometryDigest(extra)).toBe(mapGeometryDigest(map));
  });

  it('fixture 地图绑定 resourceSha256=null；原版地图绑定资源哈希', () => {
    const map = syntheticMap();
    expect(mapSkinBindingOf(map)).toEqual({
      resourceSha256: null,
      geometry: mapGeometryDigest(map),
      counts: { tiles: 3, lots: 1, companies: 1 },
    });
    const orig = {
      ...map,
      meta: { source: { id: 'map0', fileSha256: 'f'.repeat(64), resourceSha256: 'e'.repeat(64) } },
    };
    expect(mapSkinBindingOf(orig).resourceSha256).toBe('e'.repeat(64));
  });

  it('checkMapSkinBinding 给出不匹配原因', () => {
    const skin = syntheticMapSkin();
    const map = syntheticMap();
    expect(checkMapSkinBinding(skin, map)).toEqual([]);
    const orig = { ...map, meta: { source: { resourceSha256: 'e'.repeat(64) } } };
    expect(checkMapSkinBinding(skin, orig)).toEqual([{ code: 'source', expected: null, actual: 'e'.repeat(64) }]);
    const moved = { ...map, tiles: map.tiles.map((t) => ({ ...t, world: { x: t.world.x + 1, y: t.world.y } })) };
    expect(checkMapSkinBinding(skin, moved).map((m) => m.code)).toEqual(['geometry']);
    expect(checkMapSkinBinding(skin, { ...map, id: 'taiwan' }).map((m) => m.code)).toEqual(['map-id']);
  });
});

describe('MapSkinV1', () => {
  it('合成皮肤通过校验并与 manifest 交叉一致', () => {
    const s = syntheticMapSkin();
    expect(checkMapSkin(s)).toEqual([]);
    expect(parseMapSkin(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(checkMapSkinRefs(syntheticManifest(), s)).toEqual([]);
  });

  it('地面切块必须在世界内并完整覆盖（2×2 切块带 1px 重叠可以覆盖）', () => {
    expect(
      skinIssues((s) => {
        s.ground.chunks[0]!.w = 64;
      }),
    ).toEqual(['ground.chunks: 切块没有完整覆盖世界']);
    expect(
      skinIssues((s) => {
        s.ground.chunks[0]!.w = 200;
      }),
    ).toEqual(['ground.chunks.0: 切块超出世界范围']);
    const quad = skinIssues((s) => {
      s.world = { w: 2304, h: 2304 };
      s.ground.overlap = 1;
      s.ground.chunks = [
        { file: 'ground/test/0_0.png', x: 0, y: 0, w: 1153, h: 1153 },
        { file: 'ground/test/0_0.png', x: 1151, y: 0, w: 1153, h: 1153 },
        { file: 'ground/test/0_0.png', x: 0, y: 1151, w: 1153, h: 1153 },
        { file: 'ground/test/0_0.png', x: 1151, y: 1151, w: 1153, h: 1153 },
      ];
    });
    expect(quad).toEqual([]);
  });

  it('视角必须 8 个且可逆；列表唯一且有序', () => {
    expect(skinIssues((s) => s.projection.views.pop()).length).toBeGreaterThan(0);
    expect(
      skinIssues((s) => {
        s.projection.views[3] = { a: 1, b: 2, c: 2, d: 4, tx: 0, ty: 0, maxErrPx: null };
      }),
    ).toEqual(['projection.views.3: 仿射矩阵不可逆']);
    expect(
      skinIssues((s) => {
        s.decor.nodes = [
          { tile: 2, frame: 0 },
          { tile: 1, frame: 0 },
        ];
      }),
    ).toEqual(['decor.nodes: 装饰节点必须按 tile 升序且唯一']);
    expect(
      skinIssues((s) => {
        s.boatTiles = [3, 3];
      }),
    ).toEqual(['boatTiles: boatTiles 必须升序且唯一']);
    expect(
      skinIssues((s) => {
        s.buildings.companies.push({ lot: 'L1', sprite: 'board.house', spriteId: null });
      }),
    ).toEqual([
      'buildings.companies.1.lot: 企业 lot 必须形如 C1',
      'buildings.companies: 企业数量与 binding.counts.companies 不一致',
    ]);
    expect(skinIssues((s) => Object.assign(s, { extra: true })).length).toBeGreaterThan(0);
    expect(skinIssues((s) => Object.assign(s, { schema: 'rich4.mapskin/2' })).length).toBeGreaterThan(0);
  });

  it('checkMapSkinRefs：缺少精灵条目、绑定不一致、切块不在地图组', () => {
    const m = syntheticManifest();
    const s = structuredClone(syntheticMapSkin());
    s.scenery[0]!.sprite = 'nope.sprite';
    s.buildings.ownerMark = 'card.1';
    s.binding = { ...s.binding, geometry: '0'.repeat(64) };
    s.ground.chunks[0]!.file = 'images/data/530.png';
    expect(checkMapSkinRefs(m, s).map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([
      'binding: skin.binding 与 manifest.maps 中的绑定不一致',
      'ground.chunks.0: 切块文件 images/data/530.png 不在组 map.test 中',
      'buildings.ownerMark: 条目 card.1 的类型应为 sprite',
      'scenery.0.sprite: 条目 nope.sprite 不存在',
    ]);
    expect(checkMapSkinRefs(m, { ...s, mapId: 'taiwan' })).toEqual([
      { path: ['maps', 'taiwan'], message: 'manifest.maps 中没有 taiwan' },
    ]);
  });

  it('projectWorld / unprojectScreen 互逆，视角 0 的原版拟合把东向投到右上', () => {
    const v0 = {
      a: 36.012 / 32,
      b: -10.527 / 32,
      c: 14.8641 / 32,
      d: 25.5237 / 32,
      tx: -1.608,
      ty: -1.117,
      maxErrPx: 1.812,
    };
    const origin = { x: 220, y: 260 };
    const cam = { x: 1752, y: 1871 };
    const p = projectWorld(v0, origin, cam, { x: 1752 + 32, y: 1871 });
    expect(p.x).toBeGreaterThan(origin.x);
    expect(p.y).toBeLessThan(origin.y);
    const back = unprojectScreen(v0, origin, cam, p);
    expect(back.x).toBeCloseTo(1784, 9);
    expect(back.y).toBeCloseTo(1871, 9);
    expect(projectWorld(v0, origin, cam, cam)).toEqual({ x: 220 - 1.608, y: 260 - 1.117 });
  });
});
