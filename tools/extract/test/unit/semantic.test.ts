import { describe, expect, it } from 'vitest';
import { blockedBit, parseMapRaw } from '../../src/map/parseRaw';
import type { MapDataRaw, RawSource } from '../../src/map/rawTypes';
import { buildSemantic, semanticEdges } from '../../src/map/semantic';
import { buildMapResource, type MapSpec, smallMapSpec } from '../helpers/buildMapResource';

const SOURCE: Omit<RawSource, 'byteLength' | 'resourceSha256'> = {
  id: 'v206-mapdat',
  edition: 'v206',
  file: 'Game/MapDat.mkf',
  fileSha256: '0'.repeat(64),
  knownFileId: null,
  container: 'MapDat.mkf',
  resource: 0,
  compressed: false,
};
const rawOf = (spec: MapSpec): MapDataRaw => parseMapRaw(buildMapResource(spec), SOURCE, 0);

describe('semantic：节点 → Tile', () => {
  const sem = buildSemantic(rawOf(smallMapSpec()), { mapKey: 'small' });
  const tile = (id: number) => sem.tiles.find((t) => t.id === id)!;

  it('kind 由落点码映射；码 0 时有地块引用为 property，否则 plain', () => {
    expect(tile(1).kind).toBe('property');
    expect(tile(1).ref).toEqual({ lot: 'L1' });
    expect(tile(3).kind).toBe('card');
    expect(tile(4).ref).toEqual({ lot: 'F1' });
    expect(tile(4).kind).toBe('property');
    expect(tile(6).kind).toBe('plain');
    expect(tile(7).kind).toBe('hospital');
  });

  it('银行格同时是企业与落点码 14', () => {
    expect(tile(5)).toMatchObject({ kind: 'bank', landingCode: 14, ref: { lot: 'C1' } });
    expect(sem.companies[0]).toMatchObject({ id: 'C1', frontTiles: [5], industry: 7, industryKey: 'bank' });
  });

  it('links 按槽号顺序，只含非 0 槽；blocked = flags & (0x40000000 >> slot)', () => {
    expect(tile(3).links).toEqual([
      { to: 4, slot: 0, blocked: false },
      { to: 2, slot: 1, blocked: false },
      { to: 7, slot: 2, blocked: true },
    ]);
    expect(tile(8).links).toEqual([{ to: 7, slot: 0, blocked: false }]);
  });

  it('noItems = bit31；flags 保留原值（无符号）', () => {
    expect(tile(6).noItems).toBe(true);
    expect(tile(6).flags).toBe(0x80000000);
    expect(tile(1).noItems).toBe(false);
  });

  it('关押格 8001 → 医院：holdFor、ref.landmark 与 landmark.holdTile 双向', () => {
    expect(tile(8)).toMatchObject({ holdFor: 'hospital', ref: { landmark: '1' }, kind: 'plain' });
    expect(sem.landmarks[0]).toMatchObject({ id: '1', kind: 'hospital', holdTile: 8, refTiles: [8] });
    expect(sem.issues.some((i) => i.code === 'S_HOLD_COUNT' && i.msg.includes('jail'))).toBe(true);
  });

  it('街道按原始名称字节分组，按首次出现编号', () => {
    expect(sem.streets).toHaveLength(1);
    expect(sem.streets[0]).toMatchObject({ id: 'S01', lots: ['L1', 'L2'] });
    expect(sem.lands.map((l) => l.streetId)).toEqual(['S01', 'S01']);
  });

  it('设施 housePrice = rateWindow[0]；stocks/holidays 为空并标为待补', () => {
    expect(sem.facilities[0]).toMatchObject({ housePrice: 800, frontTiles: [4] });
    expect(sem.stocks).toEqual([]);
    expect(sem.holidays).toEqual([]);
    expect(sem.pending).toEqual(['stocks', 'holidays']);
  });

  it('无向边按 (a,b) 升序去重', () => {
    const edges = semanticEdges(sem);
    expect(edges).toContainEqual([3, 7]);
    expect(edges.every(([a, b]) => a < b)).toBe(true);
    expect(new Set(edges.map((e) => e.join('-'))).size).toBe(edges.length);
  });
});

describe('semantic：街道与名称复核', () => {
  it('「台北市」与「臺北市」字节不同 → 两条街；同名三块 → 一条街', () => {
    const spec = smallMapSpec();
    spec.lands = [
      { name: '台北市', landPrice: 1, rent: [1, 2, 3, 4, 5, 6] },
      { name: '臺北市', landPrice: 1, rent: [1, 2, 3, 4, 5, 6] },
      { name: '台北市', landPrice: 1, rent: [1, 2, 3, 4, 5, 6] },
    ];
    spec.nodes![0]!.type = 2001;
    spec.nodes![1]!.type = 2002;
    spec.nodes![5]!.type = 2003;
    const sem = buildSemantic(rawOf(spec), { mapKey: 't' });
    expect(sem.streets.map((s) => s.lots)).toEqual([['L1', 'L3'], ['L2']]);
    expect(sem.streets.map((s) => s.id)).toEqual(['S01', 'S02']);
  });

  it('名称与落点码不符、以及名字像特殊格但码为 0 的节点都会报出', () => {
    const spec = smallMapSpec();
    spec.nodes![2]!.name = '命運'; // 码 13（卡片）
    spec.nodes![5]!.name = '公園'; // 码 0
    const sem = buildSemantic(rawOf(spec), { mapKey: 't' });
    expect(sem.issues.find((i) => i.code === 'S_NAME_CODE')?.tiles).toEqual([3]);
    expect(sem.issues.find((i) => i.code === 'S_NAME_SUGGESTS_CODE')?.tiles).toEqual([6]);
  });

  it('全角数字名称按 NFKC 归一（得５０點 = 码 10）', () => {
    const spec = smallMapSpec();
    spec.nodes![5]!.flags = 10 | 0x80000000;
    spec.nodes![5]!.name = '得５０點';
    const sem = buildSemantic(rawOf(spec), { mapKey: 't' });
    expect(sem.tiles[5]!.kind).toBe('points50');
    expect(sem.issues.filter((i) => i.tiles?.includes(6))).toEqual([]);
  });

  it('没有节点引用的住宅地报 S_LOT_NO_FRONT', () => {
    const spec = smallMapSpec();
    spec.nodes![1]!.type = 0;
    const sem = buildSemantic(rawOf(spec), { mapKey: 't' });
    expect(sem.issues.some((i) => i.code === 'S_LOT_NO_FRONT' && i.severity === 'error')).toBe(true);
    expect(sem.lands[1]!.frontTiles).toEqual([]);
  });

  it('单向邻接报 S_LINK_ASYM（warn）', () => {
    const spec = smallMapSpec();
    spec.nodes![7]!.adj = [7, 1];
    spec.nodes![7]!.flags = blockedBit(3);
    const sem = buildSemantic(rawOf(spec), { mapKey: 't' });
    expect(sem.issues.some((i) => i.code === 'S_LINK_ASYM' && i.tiles?.join() === '8,1')).toBe(true);
  });
});
