// 建筑外观表（主题数据，design/client.md §3.5、§6.1）。只有数据，没有绘制代码。
import type { IndustryKey } from '@rich4/shared/data';

/** 统一描边 */
export const INK = 0x3a2a1a;
export const OUTLINE = 3;
/** 住宅每层楼的像素高度 */
export const FLOOR_PX = 20;

/** 调色板（≤32 色；平涂 + 一阶高光/阴影由 shade 生成） */
export const PALETTE = {
  ink: INK,
  cream: 0xfff6dc,
  white: 0xffffff,
  grass: 0x8fd16a,
  grassDark: 0x6fb850,
  water: 0x5ec8f2,
  sand: 0xf2dc9b,
  plaza: 0xe6d3b3,
  mountain: 0x9c8a6e,
  wallCream: 0xfbe9c8,
  wallBrick: 0xe0906a,
  wallGrey: 0xcfd3dc,
  wallBlue: 0xa9d2ee,
  wallPink: 0xf7c3cc,
  wallMint: 0xbfe8d2,
  roofBrown: 0xa0643c,
  glass: 0x9fd8f5,
  glassDark: 0x5aa9d6,
  windowLit: 0xffe28a,
  door: 0x8a5a3a,
  sun: 0xffd84d,
  red: 0xf2545b,
  green: 0x5cc85a,
  blue: 0x3d8bfd,
  purple: 0x9b6bff,
  orange: 0xff9f43,
  pink: 0xf78fb3,
  steel: 0x8a93a6,
} as const;

/** 玩家色（P1 红●、P2 蓝▲、P3 绿■、P4 黄★） */
export const PLAYER_COLORS: readonly number[] = [0xe8453c, 0x2f80ed, 0x27ae60, 0xf2b705];
export const PLAYER_MARKS: readonly string[] = ['●', '▲', '■', '★'];
/** 无主时的中性屋顶色 */
export const NEUTRAL_ROOF = 0xc98b5a;

export type RoofKind = 'none' | 'gable' | 'flat' | 'dome' | 'tower';

export interface HouseLevelStyle {
  floors: number;
  roof: RoofKind;
  wall: number;
  /** 细节开关：阳台、雨棚、招牌、水塔、天线、夜灯、旗 */
  details: readonly ('door' | 'balcony' | 'awning' | 'sign' | 'waterTower' | 'antenna' | 'lights' | 'flag')[];
  /** 每面窗户列数 */
  cols: number;
}

/** 小地产等级表（0 级为空地：草皮 + 「出售」木牌 / 已购插旗） */
export const HOUSE_LEVELS: readonly HouseLevelStyle[] = [
  { floors: 0, roof: 'none', wall: PALETTE.wallCream, details: [], cols: 0 },
  { floors: 1, roof: 'gable', wall: PALETTE.wallCream, details: ['door'], cols: 2 },
  { floors: 2, roof: 'gable', wall: PALETTE.wallPink, details: ['door', 'balcony', 'awning'], cols: 2 },
  { floors: 3, roof: 'flat', wall: PALETTE.wallMint, details: ['door', 'sign', 'awning'], cols: 2 },
  { floors: 5, roof: 'flat', wall: PALETTE.wallBrick, details: ['door', 'waterTower'], cols: 3 },
  { floors: 8, roof: 'flat', wall: PALETTE.wallBlue, details: ['door', 'antenna', 'lights', 'flag'], cols: 3 },
];
export const MAX_HOUSE_LEVEL = HOUSE_LEVELS.length - 1;

/** 设施（原版编码：0 公园、1 旅馆、2 购物中心、3 加油站、4 研究所；'vacant' 为未建） */
export type FacilityStyle = 'vacant' | 'park' | 'hotel' | 'mall' | 'gas' | 'lab';
export const FACILITY_STYLES: readonly FacilityStyle[] = ['vacant', 'park', 'hotel', 'mall', 'gas', 'lab'];

/** 设施按等级的楼层数（商场、旅馆 1–5 级：2/3/4/6/8） */
export const FACILITY_FLOORS: Readonly<Record<FacilityStyle, readonly number[]>> = {
  vacant: [0],
  park: [0, 0],
  hotel: [0, 2, 3, 4, 6, 8],
  mall: [0, 2, 3, 4, 6, 8],
  gas: [0, 1],
  lab: [0, 2, 2, 3, 3, 4],
};

export const FACILITY_MAX_LEVEL: Readonly<Record<FacilityStyle, number>> = {
  vacant: 0,
  park: 1,
  hotel: 5,
  mall: 5,
  gas: 1,
  lab: 5,
};

/** 地标 / 企业造型 */
export type LandmarkStyle =
  | 'bank'
  | 'hospital'
  | 'jail'
  | 'news'
  | 'lottery'
  | 'magic'
  | 'card'
  | 'dept'
  | 'amusement'
  | 'scenery'
  | 'office';
export const LANDMARK_STYLES: readonly LandmarkStyle[] = [
  'bank',
  'hospital',
  'jail',
  'news',
  'lottery',
  'magic',
  'card',
  'dept',
  'amusement',
  'scenery',
  'office',
];

export interface LandmarkLook {
  wall: number;
  roof: RoofKind;
  floors: number;
  accent: number;
  /** 招牌默认文字（开发期兜底；正式文字由调用方经 i18n 传入） */
  sign: string;
}

export const LANDMARK_LOOKS: Readonly<Record<LandmarkStyle, LandmarkLook>> = {
  bank: { wall: PALETTE.cream, roof: 'flat', floors: 3, accent: PALETTE.sun, sign: '银行' },
  hospital: { wall: PALETTE.white, roof: 'flat', floors: 4, accent: PALETTE.red, sign: '医院' },
  jail: { wall: PALETTE.wallGrey, roof: 'flat', floors: 2, accent: PALETTE.steel, sign: '监狱' },
  news: { wall: PALETTE.wallBlue, roof: 'flat', floors: 3, accent: PALETTE.blue, sign: '新闻' },
  lottery: { wall: PALETTE.wallPink, roof: 'dome', floors: 2, accent: PALETTE.pink, sign: '乐透' },
  magic: { wall: 0xd9c8ff, roof: 'tower', floors: 2, accent: PALETTE.purple, sign: '魔法' },
  card: { wall: PALETTE.wallMint, roof: 'gable', floors: 2, accent: PALETTE.green, sign: '卡片' },
  dept: { wall: PALETTE.wallCream, roof: 'flat', floors: 4, accent: PALETTE.orange, sign: '百货' },
  amusement: { wall: PALETTE.sun, roof: 'dome', floors: 1, accent: PALETTE.orange, sign: '乐园' },
  scenery: { wall: PALETTE.plaza, roof: 'tower', floors: 2, accent: PALETTE.red, sign: '' },
  office: { wall: PALETTE.glass, roof: 'flat', floors: 6, accent: PALETTE.blue, sign: '企业' },
};

/** 企业行业 → 造型与招牌兜底文字 */
export const INDUSTRY_LOOKS: Readonly<Record<IndustryKey, { style: LandmarkStyle; accent: number; sign: string }>> = {
  airline: { style: 'office', accent: PALETTE.blue, sign: '航空' },
  hotel: { style: 'office', accent: PALETTE.pink, sign: '饭店' },
  electronics: { style: 'office', accent: PALETTE.purple, sign: '电子' },
  insurance: { style: 'office', accent: PALETTE.green, sign: '保险' },
  auto: { style: 'office', accent: PALETTE.red, sign: '汽车' },
  oil: { style: 'office', accent: PALETTE.orange, sign: '石油' },
  bank: { style: 'bank', accent: PALETTE.sun, sign: '银行' },
  dept: { style: 'dept', accent: PALETTE.orange, sign: '百货' },
  construction: { style: 'office', accent: PALETTE.sun, sign: '建设' },
  sect: { style: 'scenery', accent: PALETTE.red, sign: '宗教' },
  unknown: { style: 'office', accent: PALETTE.steel, sign: '企业' },
};

/** 地形字符 → 颜色（g 草、w 水、s 沙、p 广场、m 山） */
export const TERRAIN_COLORS: Readonly<Record<string, number>> = {
  g: PALETTE.grass,
  w: PALETTE.water,
  s: PALETTE.sand,
  p: PALETTE.plaza,
  m: PALETTE.mountain,
};
