// 拍卖场（Panel#26 图集 116 帧；ui.md §2.3）的布局常量与纯函数。
// 帧语义（本机真实素材包目视 + 逐像素贴合，test/w3-venueb-*.mjs）：图0 拍卖厅底图；1 星形闪框；2 蓝边十字花纹框（价格牌，
// CLASSIC_FRAMES.crossPanel）；3–16 竞价钮 PASS / +100 / +500 / +1000 / +5000 / +10000 / Give up 各两态（常态 87×39、悬停 94×46，
// 锚点同为 (43,19)）；17/20 女助手（图18 眨眼贴 (+60,+27)）；21/24/25 拍卖官（图25 的口型图28 贴 (+40,+36)）；
// 30–77 建筑缩图：30+5·gm+(L−1) 为第 gm 张地图的 L 级住宅、50 连锁店、51 公园、52–56 旅馆、57–61 购物中心、62–66 加油站、
// 67–71 研究所（缩图的锚点使底边都落在画点下方约 58px）；78–89 12 角色 Q 版小人的黄色描边；90–102 小占地标志（90 为「售」）、
// 103–115 大占地标志（103 为「售」）。
// 布局（visual）：拍卖官站在左边讲台旁、女助手在右边；左上角星形闪框里是拍卖品；中上方的十字花纹框写价格与领先者；
// 竞拍者的 Q 版小人（venue.chibi.<角色>.1）站在地毯上，领先者背后描黄边；最下面一排是 7 颗竞价钮。
import type { BidIncrement, FacilityType, LotLevel } from '@rich4/shared/engine';
import type { Rect } from '../../layout';

export const AUCTION_SHEET = 'venue.auction.screen';

/** 12 角色 Q 版小人的待机帧（Panel#28+3c，1 帧，锚点在脚底中间） */
export function chibiSheet(character: number): string {
  return `venue.chibi.${Math.min(11, Math.max(0, Math.trunc(character)))}.1`;
}

export const AUCTION_FRAME = {
  bg: 0,
  burst: 1,
  board: 2,
  assistant: 17,
  assistantEyes: 18,
  auctioneer: 21,
  auctioneerCall: 25,
  auctioneerCallMouth: 28,
  building0: 30,
  chain: 50,
  park: 51,
  outline0: 78,
  saleSign: 103,
} as const;

/** 竞价钮：PASS、+100、+500、+1000、+5000、+10000、Give up（常态帧 3+2i、悬停 4+2i） */
export type BidButton = { k: 'pass' } | { k: 'bid'; inc: Exclude<BidIncrement, 0> } | { k: 'quit' };

export const BID_BUTTONS: readonly BidButton[] = [
  { k: 'pass' },
  { k: 'bid', inc: 100 },
  { k: 'bid', inc: 500 },
  { k: 'bid', inc: 1000 },
  { k: 'bid', inc: 5000 },
  { k: 'bid', inc: 10000 },
  { k: 'quit' },
];

export const BID_BUTTON = { w: 87, h: 39, gap: 4, x0: 3, y: 434 } as const;

export function bidButtonFrames(i: number): { normal: number; hover: number } {
  return { normal: 3 + 2 * i, hover: 4 + 2 * i };
}

export function bidButtonRect(i: number): Rect {
  return { x: BID_BUTTON.x0 + i * (BID_BUTTON.w + BID_BUTTON.gap), y: BID_BUTTON.y, w: BID_BUTTON.w, h: BID_BUTTON.h };
}

export const AUCTIONEER_AT = { x: 0, y: 131 } as const;
export const AUCTIONEER_CALL_AT = { x: 22, y: 128 } as const;
export const AUCTIONEER_CALL_MOUTH = { x: 40, y: 36 } as const;
export const ASSISTANT_AT = { x: 531, y: 92 } as const;
export const ASSISTANT_EYES = { x: 60, y: 27 } as const;
/** 拍卖品：星形闪框的画点（锚点居中）与建筑缩图的画点（底边落在闪框中下部） */
export const ITEM_AT = { x: 100, y: 70 } as const;
export const ITEM_BUILDING_AT = { x: 100, y: 46 } as const;
/** 价格牌（十字花纹框） */
export const PRICE_BOARD: Rect = { x: 188, y: 10, w: 302, h: 126 };
/**
 * 中央决策倒计时的小牌（场景坐标，上缘中点；common/sceneCover）：舞台顶端正中是价格牌的标题行，改到价格牌右边与
 * 右上角圆环（x 604–636）之间的背景上，与圆环同高
 */
export const AUCTION_BADGE = { x: 548, y: 8 } as const;
/** 「按起拍价出价」文字钮（原版没有这一档的钮图） */
export const START_BID: Rect = { x: 330, y: 140, w: 150, h: 26 };
/** 竞拍者站位：地面线与横向范围 */
export const BIDDER_GROUND = 428;
export const BIDDER_SPAN = { x0: 214, x1: 516 } as const;

/** n 个竞拍者的站位（横坐标，均匀分布、居中） */
export function bidderSlots(n: number): number[] {
  if (n <= 0) return [];
  const w = BIDDER_SPAN.x1 - BIDDER_SPAN.x0;
  const step = Math.min(80, w / n);
  const mid = (BIDDER_SPAN.x0 + BIDDER_SPAN.x1) / 2;
  return Array.from({ length: n }, (_, i) => Math.round(mid + (i - (n - 1) / 2) * step));
}

/** 地图 id → 住宅缩图的地图序号（台 0 / 中 1 / 日 2 / 美 3；其他按台湾） */
export function mapStyleIndex(mapId: string | null | undefined): number {
  const id = (mapId ?? '').toLowerCase();
  if (id.includes('china')) return 1;
  if (id.includes('japan')) return 2;
  if (id.includes('usa') || id.includes('america')) return 3;
  return 0;
}

const FACILITY_BASE: Readonly<Record<Exclude<FacilityType, 'park'>, number>> = {
  hotel: 52,
  mall: 57,
  gas: 62,
  lab: 67,
};

/** 拍卖品的缩图帧：住宅按地图与等级、连锁店、设施按类型与等级；空地（0 级）画「售」牌 */
export function lotArtFrame(
  lot: { facility: FacilityType | null; chain: boolean } | null,
  level: LotLevel | number,
  mapStyle: number,
): number {
  const L = Math.max(0, Math.min(5, Math.trunc(level)));
  if (lot?.facility === 'park') return AUCTION_FRAME.park;
  if (lot?.facility) return L === 0 ? AUCTION_FRAME.saleSign : FACILITY_BASE[lot.facility] + L - 1;
  if (lot?.chain) return AUCTION_FRAME.chain;
  if (L === 0) return AUCTION_FRAME.saleSign;
  return AUCTION_FRAME.building0 + 5 * Math.max(0, Math.min(3, mapStyle)) + L - 1;
}

/** 出价后的新价格：无人领先时按起拍价 + inc，否则现价 + inc（与程序化对话框的 bidPrice 相同） */
export function nextPrice(o: { leader: unknown; start: number; price: number }, inc: BidIncrement): number {
  return (o.leader === null ? o.start : o.price) + inc;
}
