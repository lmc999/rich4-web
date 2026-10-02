import { describe, expect, it } from 'vitest';
import { DataError } from '../errors';
import { buildTestMap, buildTestMapAllKinds, buildTestMapIndustries } from './fixtures/testMap';
import { buildMapIndex } from './mapIndex';
import type { MapDef } from './types';

/**
 * 手算的前进候选表：键 `at<prev`，值为按槽号（N=0,E=1,S=2,W=3）去掉来路与 blocked 后的候选。
 * prev=0 表示没有来路（开局或传送后）。
 */
const TEST_FORWARD: Record<string, number[]> = {
  '1<2': [18],
  '1<18': [2],
  '2<1': [3],
  '2<3': [1],
  '3<2': [4],
  '3<4': [2],
  // 04：E→05、S→19（封）、W→03
  '4<3': [5],
  '4<5': [3],
  '4<19': [5, 3],
  '5<4': [6],
  '5<6': [4],
  '6<5': [7],
  '6<7': [5],
  '7<6': [8],
  '7<8': [6],
  '8<7': [9],
  '8<9': [7],
  '9<8': [10],
  '9<10': [8],
  '10<9': [11],
  '10<11': [9],
  '11<10': [12],
  '11<12': [10],
  '12<11': [13],
  '12<13': [11],
  // 13：N→20、E→12、W→14，随机岔路
  '13<12': [20, 14],
  '13<14': [20, 12],
  '13<20': [12, 14],
  '14<13': [15],
  '14<15': [13],
  '15<14': [16],
  '15<16': [14],
  '16<15': [17],
  '16<17': [15],
  '17<16': [18],
  '17<18': [16],
  '18<17': [1],
  '18<1': [17],
  '19<4': [20],
  '19<20': [4],
  '20<19': [13],
  '20<13': [19],
};

/** allkinds 在 test 基础上改动与新增的项：08 多出 E→21，21..26 为死路支线，22–23 为 via 长边 */
const ALLKINDS_FORWARD: Record<string, number[]> = {
  ...TEST_FORWARD,
  '8<7': [21, 9],
  '8<9': [7, 21],
  '8<21': [7, 9],
  '21<8': [22],
  '21<22': [8],
  '22<21': [23],
  '22<23': [21],
  '23<22': [24],
  '23<24': [22],
  '24<23': [25],
  '24<25': [23],
  '25<24': [26],
  '25<26': [24],
  '26<25': [],
};

const NO_PREV: Record<string, number[]> = {
  '4<0': [5, 3],
  '13<0': [20, 12, 14],
  '1<0': [2, 18],
  '19<0': [4, 20],
};

function checkTable(def: MapDef, table: Record<string, number[]>) {
  const ix = buildMapIndex(def);
  const seen = new Set<string>();
  for (const t of def.tiles) {
    for (const l of t.links) {
      const key = `${t.id}<${l.to}`;
      seen.add(key);
      expect(table[key], `table is missing ${key}`).toBeDefined();
      expect(ix.forwardCandidates(t.id, l.to), key).toEqual(table[key]);
    }
  }
  // 表中每一项都对应真实的（格, 来向）
  expect(Object.keys(table).sort()).toEqual([...seen].sort());
}

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof DataError ? e.code : 'OTHER_ERROR';
  }
  return 'NO_THROW';
}

describe('MapIndex.forwardCandidates', () => {
  it('test：每个格、每个来向都与手算表一致（含被封的 04→19）', () => {
    checkTable(buildTestMap(), TEST_FORWARD);
  });

  it('test-allkinds：含死路返回空数组与 via 长边', () => {
    checkTable(buildTestMapAllKinds(), ALLKINDS_FORWARD);
  });

  it('没有来路时按槽序给出全部未封出边', () => {
    const ix = buildMapIndex(buildTestMap());
    for (const [key, want] of Object.entries(NO_PREV)) {
      const at = Number(key.split('<')[0]);
      expect(ix.forwardCandidates(at, 0), key).toEqual(want);
    }
  });

  it('04 出发永远到不了 19，19 只能从 13 经 20 进入', () => {
    const ix = buildMapIndex(buildTestMap());
    for (const prev of [0, 3, 5]) expect(ix.forwardCandidates(4, prev)).not.toContain(19);
    expect(ix.forwardCandidates(20, 13)).toEqual([19]);
    expect(ix.forwardCandidates(19, 20)).toEqual([4]);
  });

  it('返回新数组，修改不影响索引', () => {
    const ix = buildMapIndex(buildTestMap());
    const a = ix.forwardCandidates(13, 12);
    a.push(999);
    expect(ix.forwardCandidates(13, 12)).toEqual([20, 14]);
  });
});

describe('MapIndex 其余查询', () => {
  it('按 MapDef 引用缓存', () => {
    const def = buildTestMap();
    expect(buildMapIndex(def)).toBe(buildMapIndex(def));
    expect(buildMapIndex(buildTestMap())).not.toBe(buildMapIndex(def));
  });

  it('tile / lot 查询与不存在时的错误', () => {
    const ix = buildMapIndex(buildTestMap());
    expect(ix.tile(4).kind).toBe('card');
    expect(ix.tile(20).kind).toBe('xicong');
    expect(ix.lot('C2').kind).toBe('company');
    expect(ix.lot('F1').kind).toBe('facility');
    expect(() => ix.tile(99)).toThrow(DataError);
    expect(() => ix.forwardCandidates(99, 0)).toThrow(DataError);
    expect(errCode(() => ix.lot('L9'))).toBe('LOT_NOT_FOUND');
    expect(errCode(() => ix.tile(0))).toBe('TILE_NOT_FOUND');
  });

  it('streetLots', () => {
    const ix = buildMapIndex(buildTestMap());
    expect(ix.streetLots('S01')).toEqual(['L1', 'L2', 'L3']);
    expect(ix.streetLots('S02')).toEqual(['L4', 'L5']);
    expect(() => ix.streetLots('S99')).toThrow(DataError);
  });

  it('关押：落点码 4/5 的格与地标 holdTile', () => {
    for (const def of [buildTestMap(), buildTestMapAllKinds()]) {
      const ix = buildMapIndex(def);
      expect(ix.jailGate).toBe(14);
      expect(ix.hospitalGate).toBe(15);
      expect(ix.jailHold).toBe(14);
      expect(ix.hospitalHold).toBe(15);
    }
  });

  it('关押结构（原版另外 3 张图）：环路式关押格 = 保释格；台湾式关押格在封死支线尽头', () => {
    const ix = buildMapIndex(buildTestMapIndustries());
    // 环路式医院：同大陆 63、日本 55、美国 85（美国监狱 118 也是）
    expect(ix.hospitalGate).toBe(20);
    expect(ix.hospitalHold).toBe(20);
    expect(ix.forwardCandidates(20, 19)).toEqual([21]);
    expect(ix.forwardCandidates(20, 21)).toEqual([19]);
    // 台湾式监狱：同台湾 12/1、大陆 28/144、日本 78/84；保释格进支线的方向被封，从支线出来可以回到保释格
    expect(ix.jailGate).toBe(16);
    expect(ix.jailHold).toBe(26);
    expect(ix.jailGate).not.toBe(ix.jailHold);
    for (const prev of [0, 15, 17]) expect(ix.forwardCandidates(16, prev)).not.toContain(25);
    expect(ix.forwardCandidates(25, 26)).toEqual([16]);
    expect(ix.forwardCandidates(26, 25)).toEqual([]);
  });

  it('placeableTiles 对两种关押结构（⚑V-M7 待核实：原版可能只看 bit31，锁定现状）', () => {
    const p = buildMapIndex(buildTestMapIndustries()).placeableTiles();
    // 关押格（holdFor）一律排除：环路上的医院 20 因此不能放物件、不作跳伞落点；支线尽头 26 另有 noItems
    expect(p).not.toContain(20);
    expect(p).not.toContain(26);
    // 保释格 16 与支线 25 没有 holdFor / noItems，照常可放（台湾同样如此）
    expect(p).toContain(16);
    expect(p).toContain(25);
    expect(p).toEqual(Array.from({ length: 26 }, (_, i) => i + 1).filter((t) => t !== 20 && t !== 26));
  });

  it('placeableTiles 排除 noItems 与关押格', () => {
    expect(buildMapIndex(buildTestMap()).placeableTiles()).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20,
    ]);
    const all = buildMapIndex(buildTestMapAllKinds()).placeableTiles();
    expect(all).not.toContain(1);
    expect(all).not.toContain(14);
    expect(all).not.toContain(15);
    expect(all).toContain(26);
    expect(all.length).toBe(23);
  });

  it('lotsInWindow 用世界坐标半开方窗', () => {
    const ix = buildMapIndex(buildTestMapAllKinds());
    // L1 的锚点 = (6,1)×32 = (192,32)
    expect(ix.lotsInWindow({ x: 192, y: 32 }, 1)).toEqual(['L1']);
    // d = p - c：c=193 时 d=-1=-half（含），c=191 时 d=+1=half（不含）
    expect(ix.lotsInWindow({ x: 192 + 1, y: 32 }, 1)).toEqual(['L1']);
    expect(ix.lotsInWindow({ x: 192 - 1, y: 32 }, 1)).toEqual([]);
    // 足够大的窗口包含全部 5 住宅 + 1 设施 + 3 企业，顺序为 lots 再 companies
    expect(ix.lotsInWindow({ x: 300, y: 150 }, 1000)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'F1', 'C1', 'C2', 'C3']);
    // 2×2 地块的锚点是矩形中心：F1 = (3,3,2,2) → (112,112)
    expect(ix.lot('F1').world).toEqual({ x: 112, y: 112 });
  });
});
