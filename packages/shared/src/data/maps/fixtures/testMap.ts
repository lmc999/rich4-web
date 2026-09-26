import type { MapDef, Rent6 } from '../types';
import { type AsciiArea, type AsciiMapSpec, type AsciiStockSpec, type AsciiTileSpec, buildAsciiMap } from './ascii';

/**
 * 手绘测试地图（与原版无关，全部数值虚构；布局见 design/data-pipeline.md §11）。
 * 槽号固定 N=0、E=1、S=2、W=3；落点码 8 的格 kind='xicong'。
 * 改动这里后运行 `npm run fixtures` 重新生成 test-map.json / test-map-allkinds.json。
 */

const TEST_LAYOUT = [
  // x: 0   1   2   3   4   5   6   7   8   9  10  11
  '    .   .   .   .   .   .   .   .   .   .   .   .', // y=0
  '    B   B   .   .   .   .  a1  a2  a3   .   .   .', // y=1
  '    B   B  01  02  03  04  05  06  07   .   .   .', // y=2
  '    .   .  18   F   F  19   ~   ~  08   .   .   .', // y=3
  '    .   .  17   F   F  20   ~   ~  09   .   .   .', // y=4
  '    .   .  16  15  14  13  12  11  10   D   D   .', // y=5
  '    .   .   H   H   J   J  b2  b1   .   D   D   .', // y=6
  '    .   .   H   H   J   J   .   .   .   .   .   .', // y=7
  '    .   .   .   .   .   .   .   .   .   .   .   .', // y=8
];

/** 在主图基础上向右加一条死路支线（公园 / 得 50 点 / via 长边 / 得 10 点 / 保险企业 C3 的两个入口 / plain） */
const ALLKINDS_LAYOUT = [
  // x: 0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17
  '    .   .   .   .   .   .   .   .   .   .   .   .   .   .   .   .   .   .', // y=0
  '    B   B   .   .   .   .  a1  a2  a3   .   .   .   .   .   .   .   .   .', // y=1
  '    B   B  01  02  03  04  05  06  07   .   .   .   .   .   .   .   .   .', // y=2
  '    .   .  18   F   F  19   ~   ~  08  21  22   =   =  23  24  25  26   .', // y=3
  '    .   .  17   F   F  20   ~   ~  09   .   .   .   .   .   I   I   .   .', // y=4
  '    .   .  16  15  14  13  12  11  10   D   D   .   .   .   I   I   .   .', // y=5
  '    .   .   H   H   J   J  b2  b1   .   D   D   .   .   .   .   .   .   .', // y=6
  '    .   .   H   H   J   J   .   .   .   .   .   .   .   .   .   .   .   .', // y=7
  '    .   .   .   .   .   .   .   .   .   .   .   .   .   .   .   .   .   .', // y=8
];

const RENT_A: Rent6 = [400, 1000, 2500, 6000, 12000, 24000];
const RENT_B: Rent6 = [240, 600, 1500, 3600, 7200, 12000];

const BASE_TILES: AsciiTileSpec[] = [
  { id: 1, code: 14, lot: 'C1', noItems: true }, // 银行，兼企业 C1 入口
  { id: 2, code: 2 }, // 新闻
  { id: 3, code: 3 }, // 命运
  { id: 4, code: 13 }, // 卡片；岔路，04→19 静态封路
  { id: 5, code: 0, lot: 'L1' },
  { id: 6, code: 0, lot: 'L2' },
  { id: 7, code: 0, lot: 'L3' },
  { id: 8, code: 9 }, // 乐透
  { id: 9, code: 16 }, // 魔法屋
  { id: 10, code: 15, lot: 'C2' }, // 百货公司，兼企业 C2 入口
  { id: 11, code: 0, lot: 'L4' },
  { id: 12, code: 0, lot: 'L5' },
  { id: 13, code: 11 }, // 得 30 点；随机岔路
  { id: 14, code: 4, landmark: '2', holdFor: 'jail', noItems: true }, // 监狱（保释格兼关押格）
  { id: 15, code: 5, landmark: '1', holdFor: 'hospital' }, // 医院
  { id: 16, code: 6 }, // 企鹅挖宝
  { id: 17, code: 0, lot: 'F1' },
  { id: 18, code: 0, lot: 'F1' },
  { id: 19, code: 7 }, // 七彩气球（捷径，只能从 13 进入）
  { id: 20, code: 8 }, // 喜从天降
];

const ALLKINDS_EXTRA_TILES: AsciiTileSpec[] = [
  { id: 21, code: 1 }, // 公园
  { id: 22, code: 10 }, // 得 50 点
  { id: 23, code: 12 }, // 得 10 点
  { id: 24, code: 0, lot: 'C3' },
  { id: 25, code: 0, lot: 'C3' },
  { id: 26, code: 0 }, // plain，死路尽头
];

const BASE_AREAS: AsciiArea[] = [
  { symbol: 'a1', kind: 'land', id: 'L1', streetId: 'S01', landPrice: 2000, housePrice: 500, rent: RENT_A },
  { symbol: 'a2', kind: 'land', id: 'L2', streetId: 'S01', landPrice: 2000, housePrice: 500, rent: RENT_A },
  { symbol: 'a3', kind: 'land', id: 'L3', streetId: 'S01', landPrice: 2000, housePrice: 500, rent: RENT_A },
  { symbol: 'b1', kind: 'land', id: 'L4', streetId: 'S02', landPrice: 1200, housePrice: 300, rent: RENT_B },
  // 故意与同街不一致，复现「同街房价不一致」这类原版瑕疵
  { symbol: 'b2', kind: 'land', id: 'L5', streetId: 'S02', landPrice: 1200, housePrice: 350, rent: RENT_B },
  {
    symbol: 'F',
    kind: 'facility',
    id: 'F1',
    landPrice: 4000,
    housePrice: 800,
    rateWindow: [800, 600, 1500, 3500, 7000, 13000],
    name: { 'zh-TW': '湖畔廣場', 'zh-CN': '湖畔广场' },
  },
  {
    symbol: 'B',
    kind: 'company',
    id: 'C1',
    industry: 7,
    stockIndex: 0,
    tollBase: 500,
    assetValue: 800000,
    name: { 'zh-TW': '測試銀行', 'zh-CN': '测试银行' },
  },
  {
    symbol: 'D',
    kind: 'company',
    id: 'C2',
    industry: 10,
    stockIndex: 2,
    tollBase: 800,
    assetValue: 300000,
    name: { 'zh-TW': '測試百貨', 'zh-CN': '测试百货' },
  },
  {
    symbol: 'H',
    kind: 'landmark',
    id: '1',
    landmarkKind: 'hospital',
    name: { 'zh-TW': '測試醫院', 'zh-CN': '测试医院' },
  },
  { symbol: 'J', kind: 'landmark', id: '2', landmarkKind: 'jail', name: { 'zh-TW': '測試監獄', 'zh-CN': '测试监狱' } },
];

const INSURER_AREA: AsciiArea = {
  symbol: 'I',
  kind: 'company',
  id: 'C3',
  industry: 4,
  stockIndex: 1,
  tollBase: 600,
  assetValue: 500000,
  name: { 'zh-TW': '測試人壽', 'zh-CN': '测试人寿' },
};

const STREETS = [
  { id: 'S01', name: { 'zh-TW': '測試大道', 'zh-CN': '测试大道' } },
  { id: 'S02', name: { 'zh-TW': '樣例街', 'zh-CN': '样例街' } },
];

/** 12 支虚构股票：[繁, 简, 流通股, 初始价(分), 波动系数] */
const STOCK_ROWS: readonly [string, string, number, number, number][] = [
  ['測試銀行', '测试银行', 10000, 8000, 1.1],
  ['測試人壽', '测试人寿', 6000, 5000, 0.5],
  ['測試百貨', '测试百货', 10000, 3000, 1.3],
  ['示例電子', '示例电子', 8000, 12000, 1.7],
  ['示例資訊', '示例资讯', 6000, 7500, 0.9],
  ['示例塑膠', '示例塑胶', 10000, 4500, 1.2],
  ['示例汽車', '示例汽车', 9000, 5500, 1.5],
  ['示例紡織', '示例纺织', 7000, 2000, 0.8],
  ['示例超商', '示例超商', 10000, 24000, 0.6],
  ['示例商行', '示例商行', 5000, 6500, 1],
  ['示例便利', '示例便利', 6000, 15000, 1.25],
  ['示例日報', '示例日报', 8000, 21000, 0.75],
];

function stocks(companyStocks: readonly number[]): AsciiStockSpec[] {
  return STOCK_ROWS.map(([tw, cn, float, initPriceCents, volatility], i) => ({
    name: { 'zh-TW': tw, 'zh-CN': cn },
    hasCompany: companyStocks.includes(i),
    float,
    initPriceCents,
    volatility,
  }));
}

const HOLIDAYS: AsciiMapSpec['holidays'] = [
  { slot: 0, month: 1, day: 1, kind: 0, flagsRaw: 1, closed: true },
  { slot: 1, month: 12, day: 25, kind: 0, flagsRaw: 2, giveCard: true },
];

const BASE_DECORATIONS: AsciiMapSpec['decorations'] = [
  { kind: 'tree', cell: { x: 0, y: 0 }, variant: 0 },
  { kind: 'flower', cell: { x: 9, y: 1 }, variant: 0 },
  { kind: 'tree', cell: { x: 11, y: 0 }, variant: 1 },
  { kind: 'tree', cell: { x: 0, y: 8 }, variant: 2 },
  { kind: 'rock', cell: { x: 11, y: 8 }, variant: 0 },
];

export const TEST_MAP_SPEC: AsciiMapSpec = {
  id: 'test',
  name: { 'zh-TW': '測試地圖', 'zh-CN': '测试地图' },
  layout: TEST_LAYOUT,
  tiles: BASE_TILES,
  areas: BASE_AREAS,
  streets: STREETS,
  blocked: [[4, 19]],
  stocks: stocks([0, 2]),
  holidays: HOLIDAYS,
  decorations: BASE_DECORATIONS,
};

export const TEST_MAP_ALLKINDS_SPEC: AsciiMapSpec = {
  id: 'test-allkinds',
  name: { 'zh-TW': '測試地圖（全類型）', 'zh-CN': '测试地图（全类型）' },
  layout: ALLKINDS_LAYOUT,
  tiles: [...BASE_TILES, ...ALLKINDS_EXTRA_TILES],
  areas: [...BASE_AREAS, INSURER_AREA],
  streets: STREETS,
  blocked: [[4, 19]],
  viaLinks: [
    {
      a: 22,
      b: 23,
      via: [
        { x: 11, y: 3 },
        { x: 12, y: 3 },
      ],
    },
  ],
  stocks: stocks([0, 1, 2]),
  holidays: HOLIDAYS,
  decorations: [...BASE_DECORATIONS, { kind: 'rock', cell: { x: 17, y: 8 }, variant: 1 }],
};

export const TEST_MAP_ID = 'test';
export const TEST_MAP_ALLKINDS_ID = 'test-allkinds';

/** 每次调用都返回新对象，测试可以放心修改 */
export function buildTestMap(): MapDef {
  return buildAsciiMap(TEST_MAP_SPEC);
}

export function buildTestMapAllKinds(): MapDef {
  return buildAsciiMap(TEST_MAP_ALLKINDS_SPEC);
}

export function buildFixtureMaps(): MapDef[] {
  return [buildTestMap(), buildTestMapAllKinds()];
}

/** fixture 地图 id → 入库 JSON 文件名（与本文件同目录） */
export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  [TEST_MAP_ID]: 'test-map.json',
  [TEST_MAP_ALLKINDS_ID]: 'test-map-allkinds.json',
};

/** 入库 JSON 的字节格式：2 空格缩进 + 结尾换行；键顺序由生成器固定 */
export function fixtureJson(def: MapDef): string {
  return `${JSON.stringify(def, null, 2)}\n`;
}
