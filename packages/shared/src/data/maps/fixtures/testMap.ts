import type { MapDef, Rent6 } from '../types';
import { type AsciiArea, type AsciiMapSpec, type AsciiStockSpec, type AsciiTileSpec, buildAsciiMap } from './ascii';

/**
 * 手绘测试地图（与原版无关，全部数值虚构；布局见 design/data-pipeline.md §11）。
 * 槽号固定 N=0、E=1、S=2、W=3；落点码 8 的格 kind='xicong'。
 * 改动这里后运行 `npm run fixtures` 重新生成 test-map.json / test-map-allkinds.json / test-map-industries.json。
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

/**
 * 行业与关押结构测试图（只给测试用，不进 buildFixtureMaps，所以服务器的 /api/maps 与 E2E 不受影响）。
 * 覆盖原版另外 3 张图第一次走到的结构（.cache 调研：大陆 gm1、日本 gm2、美国 gm3）：
 * - 企业：航空 C1(1)、电子 C2(3)、汽车 C3(5)、石油 C4(6)、建设 C5(11)，前沿格都是落点码 0 + lot 引用；
 * - 环路式医院：关押格 = 保释格 20（落点码 5、holdFor hospital），在主环路上，同大陆 63 / 日本 55 / 美国 85；
 * - 台湾式监狱：保释格 16（落点码 4）在环路上，16→25 静态封路，支线 25（得 10 点）→ 26（关押格，死路尽头），
 *   同台湾 12→76…1、大陆 28→136…144、日本 78→79…84。
 * 布局：主环路 1..24 顺时针（上边 1–9、右边 10–12、下边 13–21 自东向西、左边 22–24 自南向北）。
 */
const INDUSTRIES_LAYOUT = [
  // x: 0   1   2   3   4   5   6   7   8   9  10  11  12
  '    .   .   .   .   .   .   .   .   .   .   .   .   .', // y=0
  '    .   .   .  a1  a2  a3   .  A1  A1   .   .   .   .', // y=1
  '    .   .  01  02  03  04  05  06  07  08  09   .   .', // y=2
  '    .   .  24   .   .   .   .   .   .   .  10  E1   .', // y=3
  '    .  K1  23   .   ~   ~   ~   .   .   .  11  E1   .', // y=4
  '    .  K1  22   .   .   .   .   .   .   .  12   .   .', // y=5
  '    .   .  21  20  19  18  17  16  15  14  13   .   .', // y=6
  '    .   .   H   H  b1  O1  O1  25  V1  V1   .   .   .', // y=7
  '    .   .   H   H   .   .   J  26   .   .   .   .   .', // y=8
  '    .   .   .   .   .   .   J   .   .   .   .   .   .', // y=9
];

const INDUSTRIES_TILES: AsciiTileSpec[] = [
  { id: 1, code: 3 }, // 命运
  { id: 2, code: 0, lot: 'L1' },
  { id: 3, code: 0, lot: 'L2' },
  { id: 4, code: 0, lot: 'L3' },
  { id: 5, code: 13 }, // 卡片
  { id: 6, code: 0, lot: 'C1' }, // 航空
  { id: 7, code: 0, lot: 'C1' },
  { id: 8, code: 2 }, // 新闻
  { id: 9, code: 11 }, // 得 30 点
  { id: 10, code: 0, lot: 'C2' }, // 电子
  { id: 11, code: 0, lot: 'C2' },
  { id: 12, code: 1 }, // 公园
  { id: 13, code: 3 }, // 命运
  { id: 14, code: 0, lot: 'C3' }, // 汽车
  { id: 15, code: 0, lot: 'C3' },
  { id: 16, code: 4 }, // 监狱保释格；16→25 封路
  { id: 17, code: 0, lot: 'C4' }, // 石油
  { id: 18, code: 0, lot: 'C4' },
  { id: 19, code: 0, lot: 'L4' },
  { id: 20, code: 5, landmark: '1', holdFor: 'hospital' }, // 医院：保释格兼关押格（环路式）
  { id: 21, code: 2 }, // 新闻
  { id: 22, code: 0, lot: 'C5' }, // 建设
  { id: 23, code: 0, lot: 'C5' },
  { id: 24, code: 10 }, // 得 50 点
  { id: 25, code: 12 }, // 得 10 点（监狱支线）
  { id: 26, code: 0, landmark: '2', holdFor: 'jail', noItems: true }, // 监狱关押格（支线尽头，台湾式）
];

const RENT_C: Rent6 = [300, 750, 1900, 4500, 9000, 18000];

const INDUSTRIES_AREAS: AsciiArea[] = [
  { symbol: 'a1', kind: 'land', id: 'L1', streetId: 'S01', landPrice: 1500, housePrice: 400, rent: RENT_C },
  { symbol: 'a2', kind: 'land', id: 'L2', streetId: 'S01', landPrice: 1500, housePrice: 400, rent: RENT_C },
  { symbol: 'a3', kind: 'land', id: 'L3', streetId: 'S01', landPrice: 1500, housePrice: 400, rent: RENT_C },
  { symbol: 'b1', kind: 'land', id: 'L4', streetId: 'S02', landPrice: 1200, housePrice: 300, rent: RENT_B },
  {
    symbol: 'A1',
    kind: 'company',
    id: 'C1',
    industry: 1,
    stockIndex: 0,
    tollBase: 500,
    assetValue: 600000,
    name: { 'zh-TW': '示例航空', 'zh-CN': '示例航空' },
  },
  {
    symbol: 'E1',
    kind: 'company',
    id: 'C2',
    industry: 3,
    stockIndex: 1,
    tollBase: 300,
    assetValue: 500000,
    name: { 'zh-TW': '示例電子', 'zh-CN': '示例电子' },
  },
  {
    symbol: 'V1',
    kind: 'company',
    id: 'C3',
    industry: 5,
    stockIndex: 2,
    tollBase: 400,
    assetValue: 700000,
    name: { 'zh-TW': '示例汽車', 'zh-CN': '示例汽车' },
  },
  {
    symbol: 'O1',
    kind: 'company',
    id: 'C4',
    industry: 6,
    stockIndex: 3,
    tollBase: 400,
    assetValue: 650000,
    name: { 'zh-TW': '示例石油', 'zh-CN': '示例石油' },
  },
  {
    symbol: 'K1',
    kind: 'company',
    id: 'C5',
    industry: 11,
    stockIndex: 4,
    tollBase: 5000,
    assetValue: 550000,
    name: { 'zh-TW': '示例建設', 'zh-CN': '示例建设' },
  },
  {
    symbol: 'H',
    kind: 'landmark',
    id: '1',
    landmarkKind: 'hospital',
    name: { 'zh-TW': '示例醫院', 'zh-CN': '示例医院' },
  },
  { symbol: 'J', kind: 'landmark', id: '2', landmarkKind: 'jail', name: { 'zh-TW': '示例監獄', 'zh-CN': '示例监狱' } },
];

const INDUSTRIES_STREETS = [
  { id: 'S01', name: { 'zh-TW': '示例大道', 'zh-CN': '示例大道' } },
  { id: 'S02', name: { 'zh-TW': '示例小巷', 'zh-CN': '示例小巷' } },
];

/** 前 5 支对应 5 家企业，其余 7 支没有企业：[繁, 简, 流通股, 初始价(分), 波动系数] */
const INDUSTRIES_STOCK_ROWS: readonly [string, string, number, number, number][] = [
  ['示例航空', '示例航空', 8000, 6000, 1.2],
  ['示例電子', '示例电子', 8000, 12000, 1.7],
  ['示例汽車', '示例汽车', 9000, 5500, 1.5],
  ['示例石油', '示例石油', 0, 9000, 1],
  ['示例建設', '示例建设', 7000, 4000, 1.1],
  ['示例塑膠', '示例塑胶', 10000, 4500, 1.2],
  ['示例紡織', '示例纺织', 7000, 2000, 0.8],
  ['示例超商', '示例超商', 10000, 24000, 0.6],
  ['示例商行', '示例商行', 5000, 6500, 1],
  ['示例便利', '示例便利', 6000, 15000, 1.25],
  ['示例日報', '示例日报', 8000, 21000, 0.75],
  ['示例資訊', '示例资讯', 6000, 7500, 0.9],
];

export const TEST_MAP_INDUSTRIES_SPEC: AsciiMapSpec = {
  id: 'test-industries',
  name: { 'zh-TW': '測試地圖（行業）', 'zh-CN': '测试地图（行业）' },
  layout: INDUSTRIES_LAYOUT,
  tiles: INDUSTRIES_TILES,
  areas: INDUSTRIES_AREAS,
  streets: INDUSTRIES_STREETS,
  blocked: [[16, 25]],
  stocks: INDUSTRIES_STOCK_ROWS.map(([tw, cn, float, initPriceCents, volatility], i) => ({
    name: { 'zh-TW': tw, 'zh-CN': cn },
    hasCompany: i < 5,
    float,
    initPriceCents,
    volatility,
  })),
  holidays: HOLIDAYS,
  decorations: [
    { kind: 'tree', cell: { x: 0, y: 0 }, variant: 0 },
    { kind: 'flower', cell: { x: 4, y: 3 }, variant: 0 },
    { kind: 'rock', cell: { x: 12, y: 9 }, variant: 0 },
  ],
};

export const TEST_MAP_ID = 'test';
export const TEST_MAP_ALLKINDS_ID = 'test-allkinds';
export const TEST_MAP_INDUSTRIES_ID = 'test-industries';

/** 每次调用都返回新对象，测试可以放心修改 */
export function buildTestMap(): MapDef {
  return buildAsciiMap(TEST_MAP_SPEC);
}

export function buildTestMapAllKinds(): MapDef {
  return buildAsciiMap(TEST_MAP_ALLKINDS_SPEC);
}

export function buildTestMapIndustries(): MapDef {
  return buildAsciiMap(TEST_MAP_INDUSTRIES_SPEC);
}

/** 服务器、自对弈与 E2E 注册的 fixture 地图（/api/maps 可见） */
export function buildFixtureMaps(): MapDef[] {
  return [buildTestMap(), buildTestMapAllKinds()];
}

/** 只给测试用的 fixture 地图（不注册进服务器；由 npm run fixtures 一并写出 JSON） */
export function buildTestOnlyFixtureMaps(): MapDef[] {
  return [buildTestMapIndustries()];
}

/** fixture 地图 id → 入库 JSON 文件名（与本文件同目录） */
export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  [TEST_MAP_ID]: 'test-map.json',
  [TEST_MAP_ALLKINDS_ID]: 'test-map-allkinds.json',
  [TEST_MAP_INDUSTRIES_ID]: 'test-map-industries.json',
};

/** 入库 JSON 的字节格式：2 空格缩进 + 结尾换行；键顺序由生成器固定 */
export function fixtureJson(def: MapDef): string {
  return `${JSON.stringify(def, null, 2)}\n`;
}
