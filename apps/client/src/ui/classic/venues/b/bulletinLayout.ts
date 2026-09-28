// 公佈欄（Panel#73 图集 20 帧；ui.md §2.3）的布局常量与纯函数。帧语义（本机真实素材包目视）：
// 图0 软木板 596×348（左上「公佈欄」标题、右上 SALE / EXIT 两颗钮画在图里、右下吉祥物）；1 灰绿表格 336×416（13 行 × 3 列，
// 首行右端是 × 钮）；2 橙色表格 416×416（表头 + 12 行 × 5 列、右侧滚动条）；3 / 4 粉 / 绿 5×3 选格（带 EXIT）；
// 5 石纹小框；6 / 7 / 8 绿色明细卡 192×224 / 256 / 288（右上角分别画着道具 / 股票 / 房子图标，3 / 4 / 5 行数值条，
// 底部两颗红钮）；9–11 粉底图标（股票 / 房子 / 道具）、12–16 蓝底图标（卡片 / 股票 / 房子 / 道具 / 卡片），72×72；
// 17 红框四格类别选择（股票 / 道具 / 地产 / 卡片）；18 × 钮 21×21；19 灰钮 80×32。
// 布局（visual）：软木板居中；挂牌是钉在板上的图标（5×3 一页，下方写价格）；点挂牌弹出明细卡（买下 / 撤下、取消）；
// SALE → 类别选择 → 表格里选要卖的东西 → 明细卡 + 计算器输入数量与价格 → 挂牌。
import type { ListingAsset } from '@rich4/shared/engine';
import type { Rect } from '../../layout';

export const BULLETIN_SHEET = 'venue.bulletin.screen';

/** 依赖的素材：公佈欄图集 + 计算器（数量、价格） */
export const BULLETIN_REQUIRED_KEYS: readonly string[] = [BULLETIN_SHEET, 'ui.numpad', 'ui.numpad.mask'];

export const BULLETIN_FRAME = {
  board: 0,
  table: 1,
  stockTable: 2,
  detail3: 6,
  detail4: 7,
  detail5: 8,
  kinds: 17,
  close: 18,
} as const;

export type ListKind = ListingAsset['t'];

/** 板子左上角（场景坐标） */
export const BOARD_AT = { x: 22, y: 66 } as const;
export const BOARD_SIZE = { w: 596, h: 348 } as const;
/**
 * 中央决策倒计时的小牌（场景坐标，小牌上缘中点；common/sceneCover）：板面与板上的弹框（类别、明细卡、计算器）时摆在
 * 工具列（y<40）与软木板（y≥66）之间的空档正中；选资产的表格从 y=32 画到 y=448、横跨中线，改到表格左边的空处
 * （标题「公」字之上）
 */
export const COUNTDOWN_BADGE = { board: { x: 320, y: 40 }, table: { x: 76, y: 40 } } as const;
/** 板上画好的 SALE / EXIT 钮（板内坐标） */
export const SALE_BTN: Rect = { x: 443, y: 9, w: 68, h: 36 };
export const EXIT_BTN: Rect = { x: 517, y: 9, w: 68, h: 36 };

/** 挂牌图钉：5 列 × 3 行，每格 72×72，下方写价格 */
export const TILE = { cols: 5, rows: 3, w: 72, h: 72, dx: 80, dy: 84, x0: 24, y0: 82 } as const;
export const TILES_PER_PAGE = TILE.cols * TILE.rows;

/** 第 i 个挂牌（本页内）的图标左上角（场景坐标） */
export function tileAt(i: number): { x: number; y: number } {
  const col = i % TILE.cols;
  const row = Math.floor(i / TILE.cols);
  return { x: BOARD_AT.x + TILE.x0 + col * TILE.dx, y: BOARD_AT.y + TILE.y0 + row * TILE.dy };
}

/** 挂牌图标帧：别人的蓝底（卡片 12、股票 13、地产 14、道具 15），自己的粉底（股票 9、地产 10、道具 11；卡片没有粉底，用 16） */
export function listingIconFrame(kind: ListKind, mine: boolean): number {
  if (mine) return kind === 'stock' ? 9 : kind === 'lot' ? 10 : kind === 'item' ? 11 : 16;
  return kind === 'card' ? 12 : kind === 'stock' ? 13 : kind === 'lot' ? 14 : 15;
}

/** 明细卡：卡片与道具 3 行（图6）、股票 4 行（图7）、地产 5 行（图8） */
export function detailFrame(kind: ListKind): { frame: number; h: number; rows: number } {
  if (kind === 'lot') return { frame: BULLETIN_FRAME.detail5, h: 288, rows: 5 };
  if (kind === 'stock') return { frame: BULLETIN_FRAME.detail4, h: 256, rows: 4 };
  return { frame: BULLETIN_FRAME.detail3, h: 224, rows: 3 };
}

export const DETAIL = {
  w: 192,
  /** 名称条、图标、数值条、两颗红钮（卡内坐标） */
  name: { x: 8, y: 22, w: 100, h: 28 } as Rect,
  icon: { x: 112, y: 4 },
  rowY0: 80,
  rowDy: 30,
  label: { x: 6, w: 50 },
  value: { x: 58, w: 130, h: 24 },
  left: (h: number): Rect => ({ x: 16, y: h - 38, w: 74, h: 22 }),
  right: (h: number): Rect => ({ x: 104, y: h - 38, w: 74, h: 22 }),
} as const;

/** 明细卡的位置：浏览挂牌时居中，挂牌表单时靠左（右边放计算器） */
export const DETAIL_AT = { view: { x: 224, y: 96 }, form: { x: 128, y: 96 } } as const;
export const CALC_AT = { x: 340, y: 116 } as const;

/**
 * 类别选择（红框四格 144×96）：板上 SALE 钮下方；四格依次为股票、道具、地产、卡片。手机上整块放大 1.4 倍（每格 ≥44px），
 * 关闭钮放在框外右侧（不与格子的扩展热区重叠）。
 */
export const KINDS = { w: 144, h: 96 } as const;
export const KIND_ORDER: readonly ListKind[] = ['stock', 'item', 'lot', 'card'];
export function kindsLayout(wide: boolean): { x: number; y: number; scale: number; close: Rect } {
  const scale = wide ? 1.4 : 1;
  const x = wide ? 380 : 430;
  const y = 116;
  return { x, y, scale, close: { x: x + KINDS.w * scale + 18, y, w: 21, h: 21 } };
}
export function kindCell(i: number, scale = 1): Rect {
  return {
    x: (8 + (i % 2) * 66) * scale,
    y: (8 + Math.floor(i / 2) * 42) * scale,
    w: 62 * scale,
    h: 38 * scale,
  };
}
/** 挂牌表单：计算器右侧切换「数量 / 价格」的文字钮 */
export const FIELD_BTNS = { x: 476, y: 120, w: 64, h: 56, dy: 70 } as const;
/** 板面翻页钮（板内坐标） */
export const PAGE_BTNS = { x: 244, y: 28, w: 48, h: 30, dx: 60 } as const;

/** 表格：图1 为 3 列（地产 / 卡片 / 道具）、图2 为 5 列（股票）；首行为表头，数据行行高 32，手机上一项占两行 */
export const TABLE = {
  plain: {
    frame: BULLETIN_FRAME.table,
    w: 336,
    h: 416,
    at: { x: 152, y: 32 },
    cols: [0, 96, 192, 336],
    /** 画在表头右端的 × */
    closeArt: { x: 308, y: 2, w: 26, h: 26 },
  },
  stock: {
    frame: BULLETIN_FRAME.stockTable,
    w: 416,
    h: 416,
    at: { x: 112, y: 32 },
    cols: [0, 96, 176, 256, 336, 408],
    /** 画在滚动条顶端的 × */
    closeArt: { x: 404, y: 0, w: 12, h: 12 },
  },
  rowH: 32,
  dataRows: 12,
  /** 「返回」文字钮在表格右上角外侧（x 相对表格右缘） */
  closeBtn: { x: 6, y: 2, w: 56, h: 40 },
  /** 表格翻页钮（表格右缘外侧） */
  pageBtn: { x: 6, y: 70, w: 48, h: 48, dy: 60 },
} as const;

/** 一页能放的项数：每项占 rowsPerItem 行 */
export function itemsPerPage(rowsPerItem: number): number {
  return Math.floor(TABLE.dataRows / Math.max(1, rowsPerItem));
}

/** 第 i 项（本页内）的行矩形（表格内坐标） */
export function tableRow(i: number, rowsPerItem: number, w: number): Rect {
  const h = TABLE.rowH * rowsPerItem;
  return { x: 0, y: TABLE.rowH + i * h, w, h };
}

/** 分页：总数 → 页数（至少 1） */
export function pageCount(n: number, per: number): number {
  return Math.max(1, Math.ceil(n / Math.max(1, per)));
}

/** 价格上限：地产按 lotCaps，其他不设上限（取一个足够大的数） */
export const PRICE_MAX = 99_999_999;
