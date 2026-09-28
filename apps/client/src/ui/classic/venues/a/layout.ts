// 第一组场所屏（original-skin.md §4.2 场所屏、§5 A12；design-draft §4.3）的素材逻辑键、帧号与场景坐标（纯数据与纯函数）。
// 帧尺寸与帧号以 ui.md §2.3 与 tools/extract/src/assets/catalog.v206.ts 为准；部件在底图里的落点用 test/w3-venue-match.mjs
// 在本机 v2.06 素材上逐像素（梯度）比对得到（标 exe-free「visual」）；各部件在 640×480 舞台上的摆放没有读 exe，
// 是按样稿与底图构图目视排的（our layout），以后对照 exe 核实时只改这里。
import type { Rect } from '../../layout';

// ───────────────────────── 逻辑键 ─────────────────────────

export const VENUE_KEYS = {
  /** Panel#23：银行柜台底图、百叶窗、董事长办公室、柜员与董事长表情、资料羊皮纸、蓝钮、EXIT、讲话框 */
  bank: 'venue.bank.screen',
  /** Panel#24：ATM 320×338 + 亮钮 + 计量条 + 键帽 + LCD 数字 */
  atm: 'venue.bank.atm',
  /** Panel#10：百货公司两页（卡片店 / 道具店） */
  shop: 'venue.shop.screen',
  /** Panel#12：乐透投注底图（号码盘烘焙在图里）、猫女、选号圈、气泡、蓝条 */
  lotteryBet: 'venue.lottery.bet',
  /** Panel#14：奖池跑马灯 FLC 213×68×5 */
  marquee: 'venue.lottery.marquee',
  /** Panel#15：开奖底图、主持人 6 姿势与表情、气泡、爆炸框、12 角色小头、号码球 0–9 */
  lotteryDraw: 'venue.lottery.draw',
  /** Panel#16：摇奖机 FLC 275×270×42（不透明） */
  machine: 'venue.lottery.machine',
  /** Panel#17：开球彩带 FLC 280×480×37（置信度 guess：不可用时不播） */
  streamers: 'venue.lottery.streamers',
  /** Panel#75：股市两页表格、公司详情、行业图 × 9 */
  stock: 'venue.stock.screen',
  /** Panel#74：13 个道具小图标 24×20（可选：缺失时道具行只写字） */
  itemIcons: 'ui.itemIcons',
} as const;

// ───────────────────────── ATM（Panel#24） ─────────────────────────

export type AtmKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'clear' | 'back' | 'max' | 'enter';

export interface AtmKeyDef {
  key: AtmKey;
  /** 按下帧（落点 = rect 左上角） */
  frame: number;
  /** 键区（ATM 本体坐标） */
  rect: Rect;
  cap: string;
}

const ATM_COLS = [58, 97, 136] as const;
const ATM_ROWS = [211, 230, 249, 268] as const;
/** 图5–16 的键序（按下帧逐一与本体比对：第一排 7 8 9 … 最后一排 C 0 ←） */
const ATM_GRID: readonly (readonly [AtmKey, string])[] = [
  ['7', '7'],
  ['8', '8'],
  ['9', '9'],
  ['4', '4'],
  ['5', '5'],
  ['6', '6'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['clear', 'C'],
  ['0', '0'],
  ['back', '←'],
];

export const ATM = {
  w: 320,
  h: 338,
  /** 路过：落在棋盘视窗中央；停下：银行底图之上、舞台中央（our layout） */
  at: { pass: { x: 60, y: 91 }, stop: { x: 160, y: 60 } },
  body: 0,
  /**
   * 两颗业务钮（图1 单手、图2 双手捧钞票；两图的语义按目视推断：单手 = 存入、捧钞 = 取出）与 EXIT（图3）；
   * 亮帧落点与本体烘焙的钮重合
   */
  ops: {
    deposit: { frame: 1, rect: { x: 57, y: 49, w: 80, h: 41 } },
    withdraw: { frame: 2, rect: { x: 139, y: 49, w: 80, h: 41 } },
  },
  exit: { frame: 3, rect: { x: 221, y: 49, w: 43, h: 41 } },
  /** 计量条亮格（图4）与点按取值的范围（0% / 50% / 100% 刻度烘焙在本体上） */
  meter: { frame: 4, rect: { x: 58, y: 139, w: 204, h: 26 } },
  keys: [
    ...ATM_GRID.map(
      ([key, cap], i): AtmKeyDef => ({
        key,
        frame: 5 + i,
        rect: { x: ATM_COLS[i % 3]!, y: ATM_ROWS[Math.floor(i / 3)]!, w: 33, h: 17 },
        cap,
      }),
    ),
    { key: 'max', frame: 17, rect: { x: 183, y: 233, w: 49, h: 25 }, cap: 'MAX' },
    { key: 'enter', frame: 18, rect: { x: 175, y: 260, w: 57, h: 25 }, cap: '↵' },
  ] as readonly AtmKeyDef[],
  /** LCD 数字（图19–28 = 0–9，18×32）：在绿色屏幕上右对齐（our layout） */
  lcd: { frame0: 19, w: 18, h: 32, right: 262, y: 97, step: 19, cells: 9 },
  /** 业务名写在屏幕左侧（数字最多 9 位时不重叠） */
  label: { x: 60, y: 100 },
  /** 输入框覆盖的液晶区 */
  lcdRect: { x: 88, y: 98, w: 176, h: 34 },
  /** 禁止符号（图29，锚点居中） */
  ban: 29,
  /** 热区分组的容器（业务钮 + EXIT；键盘） */
  opsBox: { x: 52, y: 44, w: 216, h: 50 },
  keysBox: { x: 50, y: 200, w: 190, h: 120 },
} as const;

/** ATM 的手机扩展热区：数字键之间的空隙对半分（互不重叠，补不到 44px：手机主要用液晶屏上的数字框）；MAX / ↵ 补足 */
export function atmKeyPad(k: AtmKeyDef): Rect {
  // MAX 往上补到喇叭格栅（上面没有控件）、↵ 往下补到本体下缘：两颗都到 56 逻辑像素高（0.8125 倍时约 45px）
  if (k.key === 'max') return { x: 176, y: 204, w: 62, h: 56 };
  if (k.key === 'enter') return { x: 172, y: 260, w: 66, h: 56 };
  const col = ATM_COLS.indexOf(k.rect.x as (typeof ATM_COLS)[number]);
  const row = ATM_ROWS.indexOf(k.rect.y as (typeof ATM_ROWS)[number]);
  return { x: 55 + col * 39, y: 210 + row * 19, w: 39, h: 19 };
}

/** LCD 上显示的数字（最多 cells 位，超出只留低位） */
export function atmDigits(v: number, cells: number = ATM.lcd.cells): number[] {
  return [...String(Math.max(0, Math.trunc(v))).slice(-cells)].map(Number);
}

// ───────────────────────── 银行柜台（Panel#23） ─────────────────────────

export const BANK = {
  /** 图0 柜台（柜员）、图2 董事长办公室 */
  hall: 0,
  office: 2,
  /** 柜员眼睛（图5 睁眼 = 底图、图6 闭眼）与嘴（图8 = 底图、图9/10 说话）：落点逐像素比对 */
  clerk: { eyes: { x: 140, y: 114, open: 5, closed: 6 }, mouth: { x: 140, y: 152, rest: 8, talk: [9, 10] } },
  /** 董事长（办公室图2 上）：眼睛图11/12、嘴图13/14 */
  chairman: { eyes: { x: 496, y: 162, open: 11, closed: 12 }, mouth: { x: 496, y: 197, rest: 13, talk: [14] } },
  /** 柜员的心形气泡（图21，尾巴在左）与董事长的讲话框（图22，尾巴在右下）：our layout */
  clerkBalloon: { frame: 21, x: 230, y: 34, text: { x: 58, y: 24, w: 118, h: 94 } },
  chairmanBalloon: { frame: 22, x: 224, y: 64, text: { x: 16, y: 12, w: 218, h: 60 } },
  /** 资料羊皮纸（图15，200×280，三条浅蓝栏烘焙了金币 / 小猪 / 房子图标）：our layout */
  sheet: {
    frame: 15,
    x: 436,
    y: 4,
    title: { x: 12, y: 14, w: 176, h: 76 },
    rows: [
      { x: 44, y: 98, w: 144, h: 30 },
      { x: 44, y: 160, w: 144, h: 32 },
      { x: 44, y: 223, w: 144, h: 33 },
    ],
  },
  /**
   * 蓝钮（图16 常态、图17 亮）：业务钮横排在柜台前（纵向留足手机 44px 热区，不互相遮挡），确认钮在右栏（our layout）
   */
  blue: { normal: 16, hover: 17, w: 114, h: 40 },
  ops: [
    { x: 12, y: 430 },
    { x: 130, y: 430 },
    { x: 248, y: 430 },
  ],
  confirm: { x: 446, y: 300 },
  /** 计算器（Panel#21）左上角 */
  calc: { x: 296, y: 184 },
  /** EXIT（图18 常态、图19 亮）：与底图烘焙的钮重合 */
  exit: { normal: 18, hover: 19, x: 548, y: 431 },
  ban: 23,
  /** 倒计时圆环（羊皮纸下方、确认钮右侧） */
  ring: { x: 596, y: 296 },
} as const;

// ───────────────────────── 百货公司（Panel#10） ─────────────────────────

export type ShopPage = 'card' | 'item';

export const SHOP = {
  bg: { card: 0, item: 16 },
  /** 货架（图1 CARD 卡片架、图17 ITEM 道具架，222×462）：our layout */
  shelf: { card: 1, item: 17, x: 412, y: 9, w: 222, h: 462 },
  /** 卡片架：页首 CARD 下面 15 行（每行 26） */
  cardRows: { x: 6, y: 60, w: 210, h: 26, count: 15 },
  /** 道具架：页首 ITEM 下面 8 行（每行 48，白线分隔） */
  itemRows: { x: 6, y: 70, w: 210, h: 48, count: 8 },
  /**
   * 店员：图2 女巫（锚点 −52,208）、图18 道具店女孩（锚点 −21,229）按同一画点摆（our layout：画点 (206, 240)，
   * 女孩下缘正好落在柜台面上）。表情帧的落点（相对立绘左上角）逐像素比对得到
   */
  clerk: {
    at: { x: 206, y: 240 },
    // 眼睛：闭眼帧用于眨眼；嘴：说话时轮换；cross：整张不高兴的脸（手牌满、点券不够时）
    card: {
      frame: 2,
      ax: -52,
      ay: 208,
      eyes: { dx: 33, dy: 28, closed: 7 },
      mouth: { dx: 33, dy: 59, talk: [10, 9] },
      cross: { dx: 33, dy: 28, frame: 12 },
    },
    item: {
      frame: 18,
      ax: -21,
      ay: 229,
      eyes: { dx: 70, dy: 39, closed: 21 },
      mouth: { dx: 70, dy: 78, talk: [27, 25] },
      cross: { dx: 70, dy: 30, frame: 28 },
    },
  },
  /** 讲话框：卡片店蓝色（图15，尾巴在右）、道具店粉色（图34，尾巴在右） */
  balloon: {
    card: { frame: 15, x: 0, y: 8, text: { x: 26, y: 30, w: 200, h: 150 } },
    item: { frame: 34, x: 8, y: 20, text: { x: 26, y: 26, w: 168, h: 112 } },
  },
  /** 翻页角（右上角三角：卡片店上画锤子图13/14 → 道具店；道具店上画 CARD 图29/30 → 卡片店） */
  corner: { x: 555, y: 0, w: 85, h: 85, toItem: [13, 14], toCard: [29, 30] },
  /** EXIT（图35/36）、点数底板（图37，左侧烘焙了宝石） */
  exit: { normal: 35, hover: 36, x: 8, y: 432 },
  points: { frame: 37, x: 96, y: 432, text: { x: 36, y: 0, w: 50, h: 40 } },
  /** 选中商品的详情区（卡图、名称价格、数量、买卖钮） */
  detail: { x: 8, y: 236, w: 262, h: 150 },
  /** 买 / 卖页签：与 EXIT、点数排在最下一行（纵向留足手机 44px 热区） */
  tabs: { y: 432, w: 92, h: 40, xs: [194, 290] },
  /** 手机横屏的原生下拉框（桌面只给读屏） */
  picker: { x: 20, y: 180, w: 230 },
  /** 货架翻页钮（货架坐标：页首左侧的空白处，不压 ITEM / CARD 字与右上翻页角；our layout） */
  pager: { x: 6, y: 8, w: 70, h: 44 },
  /** 行首选中标记（图32，14×14 锚点居中） */
  marker: 32,
} as const;

export function shopRowRect(page: ShopPage, i: number): Rect {
  const r = page === 'card' ? SHOP.cardRows : SHOP.itemRows;
  return { x: SHOP.shelf.x + r.x, y: SHOP.shelf.y + r.y + r.h * i, w: r.w, h: r.h };
}

// ───────────────────────── 乐透投注（Panel#12） ─────────────────────────

export const LOTTERY = {
  bg: 0,
  /** 猫女（图1）坐在号码盘上沿；图3/4 眼睛、图5/6 嘴（落点逐像素比对） */
  girl: {
    frame: 1,
    x: 0,
    y: -14,
    eyes: { dx: 63, dy: 68, open: 3, closed: 4 },
    mouth: { dx: 63, dy: 110, frames: [5, 6] },
  },
  /** 气泡（图8，尾巴在左） */
  balloon: { frame: 8, x: 300, y: 4, text: { x: 50, y: 26, w: 168, h: 140 } },
  /** 跑马灯 FLC（Panel#14）：落点同 flic-map（推断） */
  marquee: { x: 213, y: 206, w: 213, h: 68, text: { x: 22, y: 16, w: 169, h: 36 } },
  /** 号码盘：9 列 × 4 行，格心按底图烘焙的号码目视量出 */
  cells: { x0: 60, dx: 64, y0: 296, dy: 47.67, w: 62, h: 46, cols: 9, rows: 4 },
  /** 选号圈（图7，锚点 28,25 = 格心） */
  ring: 7,
  /** 蓝条（图9，172×28）：当按钮底板用（机选 / 不买；手机热区一个往上、一个往下补，互不遮挡） */
  bar: { frame: 9, w: 172, h: 28, quick: { x: 446, y: 202 }, skip: { x: 446, y: 234 } },
  /** YES/NO 消息框画点（锚点 97,81） */
  confirm: { x: 518, y: 112 },
  /** 手机横屏的原生下拉框（桌面只给读屏） */
  picker: { x: 8, y: 206, w: 196 },
} as const;

/** 号码下标 0..35 → 格子（场景坐标） */
export function lotteryCell(i: number): Rect & { cx: number; cy: number } {
  const c = LOTTERY.cells;
  const col = i % c.cols;
  const row = Math.floor(i / c.cols);
  const cx = c.x0 + c.dx * col;
  const cy = Math.trunc(c.y0 + c.dy * row);
  return { cx, cy, x: cx - c.w / 2, y: cy - c.h / 2, w: c.w, h: c.h };
}

// ───────────────────────── 乐透开奖（Panel#15/16/17） ─────────────────────────

export const DRAW = {
  bg: 0,
  /** 主持人 6 姿势（图1–6）：右下对齐（our layout） */
  host: { right: 632, bottom: 480, poses: [1, 2, 3, 4, 5, 6] },
  hostSize: [
    [152, 413],
    [206, 413],
    [134, 422],
    [127, 364],
    [124, 411],
    [162, 460],
  ] as readonly (readonly [number, number])[],
  /** 心形气泡（图22，尾巴在右） */
  balloon: { frame: 22, x: 300, y: 24, text: { x: 26, y: 26, w: 128, h: 88 } },
  /** 爆炸框：图24 中奖（锚点 147,130）、图23 无人中奖（锚点 120,98） */
  burst: { win: 24, none: 23, x: 320, y: 250 },
  /** 12 角色小头（图25–36，锚点居中） */
  head0: 25,
  /** 号码球（图37–46 = 0–9，71×70，锚点居中） */
  ball0: 37,
  balls: { y: 205, xs: [284, 356] },
  /** 中奖人小头与一句话（都落在两种爆炸框的亮色区域里） */
  winnerY: 262,
  subtitle: { x: 220, y: 282, w: 200, h: 58 },
  /**
   * 摇奖机 FLC（Panel#16，不透明）：第 0 帧与底图逐像素比对的最佳落点 (183,75)（平均色差 5.4；flic-map 推断的 (182,105)
   * 偏下 30 行，test/w3-venues-a-flcmatch.ts）；彩带（Panel#17）落点同 flic-map（推断）
   */
  machine: { x: 183, y: 75, w: 275, h: 270 },
  streamers: { x: 180, y: 0, w: 280, h: 480 },
  /** 「跳过」钮（右上角，our layout） */
  skip: { x: 544, y: 8, w: 88, h: 30 },
  /** 各阶段在弹窗寿命里的比例：开场 → 摇奖 → 揭晓 */
  phase: { spin: 0.18, reveal: 0.6 },
} as const;

export type DrawPhase = 'intro' | 'spin' | 'reveal';

/** 弹窗开始后 elapsed 毫秒时的阶段（没有号码时直接揭晓「不开奖」） */
export function drawPhase(elapsed: number, ms: number, hasNumber: boolean): DrawPhase {
  if (!hasNumber) return 'reveal';
  const total = Math.max(1, ms);
  if (elapsed >= total * DRAW.phase.reveal) return 'reveal';
  if (elapsed >= total * DRAW.phase.spin) return 'spin';
  return 'intro';
}

/** 号码（显示值 1..36）→ 两颗球的数字 */
export function drawBalls(n: number): [number, number] {
  const v = Math.max(0, Math.min(99, Math.trunc(n)));
  return [Math.floor(v / 10), v % 10];
}

// ───────────────────────── 股市（Panel#75） ─────────────────────────

export const STOCK = {
  /** 图0 绿色行情表、图1 橙色表（未用）、图2 公司详情 587×375、图3–11 行业图 80×112 */
  table: 0,
  detail: 2,
  industry0: 3,
  industries: 9,
  /** 顶栏 6 格（第 6 格烘焙了 EXIT 与走出门的小人） */
  header: [
    { x: 16, y: 8, w: 108, h: 30 },
    { x: 128, y: 8, w: 70, h: 30 },
    { x: 202, y: 8, w: 69, h: 30 },
    { x: 276, y: 8, w: 133, h: 30 },
    { x: 414, y: 8, w: 134, h: 30 },
    { x: 553, y: 8, w: 69, h: 30 },
  ] as readonly Rect[],
  /** 表格：6 列（边界 x）、13 行（第 0 行为栏名，1–12 为 12 支股票），行高 32 */
  cols: [15, 136, 240, 320, 416, 521, 624] as readonly number[],
  rows: { y0: 48, h: 32, count: 13 },
  /**
   * 倒计时圆环（左上角，32×32，压在最后一行「盈虧」栏右端）与中央决策倒计时的小牌（上缘中点）：顶栏正中是「存款」栏、
   * 表格与详情框占满中间，小牌挨在圆环左边（最后一行「盈虧」栏的数字靠右，被圆环盖住的部分之外是空的）
   */
  ring: { x: 598, y: 446 },
  badge: { x: 574, y: 449 },
  /** 详情框（图2）落点与框内部件（相对详情框左上角） */
  panel: {
    x: 26,
    y: 52,
    w: 587,
    h: 375,
    image: { x: 25, y: 55 },
    info: { x: 124, y: 22, w: 250, h: 170 },
    chart: { x: 66, y: 208, w: 288, h: 128 },
    calc: { x: 438, y: 28 },
    side: { y: 228, xs: [388, 478], w: 84, h: 30 },
    submit: { x: 388, y: 285, w: 178, h: 64 },
    back: { x: 20, y: 178, w: 92, h: 28 },
    note: { x: 380, y: 262, w: 196, h: 20 },
  },
} as const;

/** 第 r 行（0 = 栏名，1..12 = 股票）的矩形 */
export function stockRowRect(r: number): Rect {
  const c = STOCK.cols;
  return { x: c[0]!, y: STOCK.rows.y0 + STOCK.rows.h * r, w: c[c.length - 1]! - c[0]!, h: STOCK.rows.h };
}

/** 第 k 列（0..5）的横向范围 */
export function stockCol(k: number): { x: number; w: number } {
  const c = STOCK.cols;
  return { x: c[k]!, w: c[k + 1]! - c[k]! };
}

/** 股票的行业图（没有行业数据时按序号取模，确定性） */
export function stockIndustryFrame(idx: number): number {
  return STOCK.industry0 + (((Math.trunc(idx) % STOCK.industries) + STOCK.industries) % STOCK.industries);
}

/** 走势折线（values 为分；空或单值时画水平线）：返回 SVG points 字符串 */
export function trendPoints(values: readonly number[], w: number, h: number, pad = 4): string {
  if (values.length === 0) return '';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  const n = values.length;
  return values
    .map((v, i) => {
      const x = n === 1 ? w / 2 : pad + ((w - 2 * pad) * i) / (n - 1);
      const y = span === 0 ? h / 2 : pad + (h - 2 * pad) * (1 - (v - lo) / span);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
