/**
 * MapDef：唯一的地图契约（architecture §5.1，schemaVersion 1；细则见 design/data-pipeline.md §9）。
 * 引擎、前端、服务器、提取工具都以此为准。
 */

/** 原版节点号，1 基；fixture 同样 1 基 */
export type TileId = number;
/** 住宅地 / 设施 / 企业，沿用原版 1 基编号 */
export type LotId = `L${number}` | `F${number}` | `C${number}`;

/** 渲染网格：+x 为等角屏幕的 SE，+y 为 SW */
export interface Cell {
  x: number;
  y: number;
}

/** 原版世界坐标；fixture 取 cell×32。引擎的范围判定只用它 */
export interface World {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TileKind =
  | 'property'
  | 'plain'
  | 'park'
  | 'news'
  | 'fate'
  | 'jail'
  | 'hospital'
  | 'penguin'
  | 'balloon'
  | 'xicong'
  | 'lottery'
  | 'points50'
  | 'points30'
  | 'points10'
  | 'card'
  | 'bank'
  | 'shop'
  | 'magic';

/** 槽号：原版邻接槽下标；fixture 固定 N=0、E=1、S=2、W=3 */
export type Slot = 0 | 1 | 2 | 3;

/** blocked 表示从本格经这个槽出发被禁止；via 是非游戏格的连接格（只用于画路和行走插值） */
export interface TileLink {
  to: TileId;
  slot: Slot;
  blocked: boolean;
  via?: Cell[];
}

export interface TileDef {
  id: TileId;
  cell: Cell;
  world: World;
  kind: TileKind;
  /** 保留 0..16 原值 */
  landingCode: number;
  ref?: { lot?: LotId; landmark?: string };
  /** 按原版槽号升序，只含非 0 槽。岔路候选 = 此顺序去掉来路和 blocked 后的结果，再取 rand15()%n */
  links: TileLink[];
  /** 原版 flags bit31：不能随机放物件、神明、礼物，也不能作为开局落点 */
  noItems: boolean;
  holdFor?: 'hospital' | 'jail';
  nameKey?: string;
  src?: { flags: number };
}

export interface LotBase {
  id: LotId;
  world: World;
  rect: Rect;
  frontTiles: TileId[];
  facing?: number;
  nameKey: string;
}

export type Rent6 = [number, number, number, number, number, number];

export interface LandLot extends LotBase {
  kind: 'land';
  streetId: string;
  landPrice: number;
  housePrice: number;
  rent: Rent6;
}

/** rateWindow[0] = housePrice，[1..5] = 各级费率（与原版 +0x24 + level×2 寻址一致） */
export interface FacilityLot extends LotBase {
  kind: 'facility';
  landPrice: number;
  housePrice: number;
  rateWindow: Rent6;
}

export type IndustryKey =
  | 'airline'
  | 'hotel'
  | 'electronics'
  | 'insurance'
  | 'auto'
  | 'oil'
  | 'bank'
  | 'dept'
  | 'construction'
  | 'sect'
  | 'unknown';

export interface CompanyDef extends LotBase {
  kind: 'company';
  industry: number;
  industryKey: IndustryKey;
  stockIndex: number;
  tollBase: number;
  assetValue: number;
}

export interface LandmarkDef {
  id: string;
  kind: 'hospital' | 'jail' | 'scenery';
  rect: Rect;
  nameKey: string;
  holdTile?: TileId;
}

/** 按原版名称字节完全相等分组 */
export interface StreetDef {
  id: string;
  nameKey: string;
  lots: LotId[];
}

export interface StockDef {
  index: number;
  nameKey: string;
  hasCompany: boolean;
  float: number;
  initPriceCents: number;
  volatility: number;
  /** f32 位型的 8 位小写 hex */
  volatilityF32: string;
}

export interface HolidayDef {
  slot: number;
  month: number;
  /** kind 0/1 为日；kind 2 为「第 n 个」（1..5） */
  day: number;
  /** 0 公历、1 农历、2 该月第 day 个星期 weekday */
  kind: number;
  /** kind 2 的星期（0 = 星期日 … 6）；其他 kind 不带（VERIFY V-E5） */
  weekday?: number;
  flagsRaw: number;
  closed?: boolean;
  giveCard?: boolean;
  bgm?: boolean;
  lunar?: boolean;
}

export interface MapCounts {
  nodes: number;
  lands: number;
  facilities: number;
  companies: number;
  landscapes: number;
}

export type Decoration = { kind: 'tree' | 'rock' | 'flower'; cell: Cell; variant: number };

export type MapLocale = 'zh-TW' | 'zh-CN';

export type MapSource = { id: string; fileSha256: string; resourceSha256: string } | { fixture: true };

export interface MapDef {
  schemaVersion: 1;
  id: string;
  globalMapId: number | null;
  nameKey: string;
  grid: { w: number; h: number };
  /** h 行、每行 w 个字符：g 草 / w 水 / s 沙 / p / m */
  terrain: string[];
  tiles: TileDef[];
  roadCells: Cell[];
  lots: (LandLot | FacilityLot)[];
  companies: CompanyDef[];
  landmarks: LandmarkDef[];
  streets: StreetDef[];
  stocks: StockDef[];
  holidays: HolidayDef[];
  decorations: Decoration[];
  /** zh-TW 为原文，zh-CN 由 opencc 转换 */
  strings: Record<MapLocale, Record<string, string>>;
  meta: {
    source: MapSource;
    counts: MapCounts;
    /** 排除 meta.dataHash 后的规范化 JSON 的 sha256 */
    dataHash: string;
    generator: string;
  };
}

export type AnyLot = LandLot | FacilityLot | CompanyDef;
