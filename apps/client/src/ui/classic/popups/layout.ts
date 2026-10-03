// 原版弹窗的素材键与几何（original-skin.md §4.2 通用；ui.md §2.1–§2.3；本机素材包逐像素统计，见各常量注释）。纯数据与纯函数。
//
// - 新闻板 / 命运板：Panel#66 = ui.newsBoard 图0（蓝 NEWS）/ 图1（紫 ?），440×480 贴 (0,0)；插图框在 (25,44)、388×251
//   （框内近白像素的包围盒），新闻插图 Data#400+i = illustration.news.<i>（36 条逐一目视对上；exe 0x44a200
//   lea edi,[ebx+0x190]）；命运插图 = Data#FATE_ART_TABLE[slot] = illustration.fate.<表值 − 436>（exe 0x473dd8，见下方
//   「命运板」），文字左上 (24,330)、表情头像 (390,344)（exe fcn.0044c4a0 与各处理函数参数 0 分支）。
// - 神明老虎机：Panel#67 = ui.godSlot，图0 4 位机身 193×183（锚点 96,98）、图1 3 位 156×183（锚点 78,98）、图2/3 拉杆
//   上 / 下、图4–23 滚轮条 38×36（图 4+2d = 数字 d 居中、5+2d = d 与 d+1 之间），滚轮窗左上 (21,97)、步距 37（目视）。
// - 轮盘：Panel#68–71 = ui.roulette.0–3，图0/1 天使（挥杖两态）、图2–13 转盘每帧顺时针转 30°。按盘面数值与
//   facilities.ts 的 WHEEL 表对上：68 = 航空（0 1 2 3 2 1）、69 = 旅馆（1 2 3 4）、70 = 购物中心（6 1 2 3 4 5）、
//   71 = 保险（3 5 10 15 20 30），均为图2 从正上方起顺时针（本机真实素材包逐帧目视核对）；ui.md、original-skin.md §4.2 与
//   catalog 描述已按此更正（早期写成「旅馆 / 购物中心 / 保险 / 航空」是推断）。
// - 月结颁奖 / 终局：Panel#25 = venue.monthly.screen，图0 底图 640×480、图5 MONEY 卡 353×450（4 个名次格 64×88，
//   左上 (19,41)、步距 83）、图6–9 名次 1–4、图19 主持人立绘、图47+3c（+0..2）角色 c 的 Q 版小人三帧。
// - 资产表：Panel#9 = venue.assets.screen，图0–2 三页 640×480、图5/6 EXIT 常态 / 亮、图7–10 上下箭头、图12 蓝钮、
//   图13–24 神明小像（顺序按目视与 GodKind 1–10、12、15 对上，visual）。
// - 托管 AI：Panel#77 = ui.autoplay，图0 对话框 435×355、图1/2 左栏角色页签亮 / 暗 116×86、图3 红点（选中）、
//   图4/5 左右箭头、图6+c 角色 c 的圆头像。
// - 存读档：Data#479 = ui.saveLoad，图0 LOAD 窗 555×451、图1 SAVE 窗 555×381、图2–5 四张地图缩图 72×72。
import { TABLES } from '@rich4/shared/data';
import type { GodKind } from '@rich4/shared/engine';
import type { Rect } from '../layout';

export const NEWS_SHEET = 'ui.newsBoard';
export const SLOT_SHEET = 'ui.godSlot';
export const MONTHLY_SHEET = 'venue.monthly.screen';
export const ASSETS_SHEET = 'venue.assets.screen';
export const AUTOPLAY_SHEET = 'ui.autoplay';
export const SAVELOAD_SHEET = 'ui.saveLoad';
export const FACE_SHEET = 'portrait.face72';
export const COMMON_SHEET = 'ui.common';

export function newsArtKey(id: number): string {
  return `illustration.news.${id}`;
}

/**
 * 新闻板 / 命运板下面垫的底色：原版把 Panel#66 的图整张不透明拷到后台缓冲（新闻 0x44a2ba、命运 0x44c626 都是
 * fcn.00454a55，与卡片插画同一个拷贝函数，没有色键），图里 RGB 0 的像素画出来是黑色；素材包的 ui.newsBoard 按
 * rgb0-backdrop 把这些像素抠成了透明（插图框下沿的阴影条等），不垫底会透出棋盘。垫黑后与原版逐像素相同
 */
export const BOARD_UNDERLAY = '#000';

export const NEWS_BOARD = {
  w: 440,
  h: 480,
  art: { x: 25, y: 44, w: 388, h: 251 },
  text: { x: 28, y: 304, w: 384, h: 164 },
} as const;

// ───────────────────────── 命运板 ─────────────────────────

/**
 * 命运插图表（49 项，Data 资源号）：下标 = 命运处理函数表下标 slot（第 k 条命运 k < 33 为 k，33–36 在地图 gm 为 k + 4·gm，
 * 与 presentation/eventText.fateVariantSlot 相同）。40 张插图全部被引用，同一标题总对应同一张图。
 * 与 tools/extract 资源目录的 FATE_ART_TABLE 同值（那边由本机测试逐项对 exe 核对）。
 * @source exe v2.06 VA 0x473dd8 u16[49]（0x44c542：k<33 用表[k]；0x44c58a：k≥33 用表[k+4gm]）
 */
export const FATE_ART_TABLE: readonly number[] = Object.freeze([
  436, 437, 438, 439, 440, 441, 442, 443, 444, 445, 446, 447, 448, 449, 450, 451, 452, 453, 454, 455, 456, 456, 456,
  457, 457, 458, 459, 460, 460, 460, 461, 462, 463,
  // slot 33–36 台湾、37–40 大陆、41–44 日本、45–48 美国
  464, 465, 466, 467, 464, 468, 469, 470, 471, 465, 466, 472, 473, 474, 469, 475,
]);

/** 命运插图的首个资源号（illustration.fate.<res − 436>） */
export const FATE_ART_BASE = 436;

/** 命运插图的逻辑键（slot 越界时按 0） */
export function fateArtKey(slot: number): string {
  const res = FATE_ART_TABLE[slot] ?? FATE_ART_TABLE[0]!;
  return `illustration.fate.${res - FATE_ART_BASE}`;
}

/**
 * 命运板上的表情头像：讲话头像（portrait.speaker.<抽到命运的人的角色>，map#15+角色）的图号 1–4，按处理函数参数 0 分支
 * 逐条读出（坏事图2 / 图3，得钱图4，k4、k20、k27 图1，33–36 都是图3）。
 * @source exe v2.06 各命运处理函数 fcn.00454905(板图1, [0x495ccc+seat*0x34]+0x18/0x24/0x30/0x3c, 390, 344)，
 *   例如 0x44a8f6–0x44a91a；k20 / k27 经 0x44bc6b 跳到 0x44bd80（图1），0x44bd66–0x44bd8a 是得钱一组共用的结尾（图4）
 */
export const FATE_FACE: readonly number[] = Object.freeze([
  2, 2, 3, 3, 1, 4, 2, 3, 3, 2, 3, 3, 3, 3, 2, 2, 2, 3, 3, 2, 1, 4, 4, 2, 3, 4, 3, 1, 4, 4, 2, 4, 2, 3, 3, 3, 3, 3, 3,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
]);

/**
 * 命运板（exe fcn.0044c4a0）：Panel#66 图1 整张 440×480 拷到 (0,0)；插图 388×251 不透明贴 (25,44)；文字从 (24,330) 起
 * 左上对齐（fcn.0044e200(28, #F0F0F0, #101010, 3, 0)：28px 粗体、#101010 的 (1,1) 阴影、字距 −1）；表情头像按锚点画在
 * (390,344)。原版的文字只有一两行 28px 的整句；我们的标题照原版 28px 写在 (24,330)，正文与金额另起一块（避开头像）。
 */
export const FATE_BOARD = {
  frame: 1,
  w: 440,
  h: 480,
  art: NEWS_BOARD.art,
  title: { x: 24, y: 330 },
  face: { x: 390, y: 344 },
  /** 我们的正文与金额：标题下方到板底、头像左侧 */
  body: { x: 24, y: 366, w: 344, h: 102 },
} as const;

// ───────────────────────── 老虎机 ─────────────────────────

export const SLOT = {
  body: { 4: { frame: 0, w: 193, h: 183, ax: 96, ay: 98 }, 3: { frame: 1, w: 156, h: 183, ax: 78, ay: 98 } },
  lever: { up: 2, down: 3 },
  reel: { x0: 21, y0: 97, dx: 37, w: 38, h: 36, frame0: 4, frames: 20 },
} as const;

/** 滚轮停在数字 d 的帧 */
export function reelFrame(d: number): number {
  return SLOT.reel.frame0 + 2 * (((d % 10) + 10) % 10);
}

/** 滚动中第 tick 格的帧（每格半个数字，10 个数字共 20 帧循环） */
export function reelSpinFrame(tick: number, offset: number): number {
  return SLOT.reel.frame0 + ((((tick + offset * 7) % SLOT.reel.frames) + SLOT.reel.frames) % SLOT.reel.frames);
}

/** 值拆成 digits 位（左侧补 0；超出位数取低位） */
export function slotDigits(value: number, digits: number): number[] {
  const n = Math.max(1, Math.min(8, Math.trunc(digits)));
  return [
    ...String(Math.max(0, Math.trunc(value)))
      .padStart(n, '0')
      .slice(-n),
  ].map(Number);
}

// ───────────────────────── 轮盘 ─────────────────────────

export type WheelKind = 'airline' | 'hotel' | 'mall' | 'insurance';

export interface WheelDef {
  key: string;
  /** 图2 从正上方起顺时针的扇区数值 */
  sectors: readonly number[];
}

/** 资源号依据见文件头「轮盘」：Panel#68–71 依次为航空 / 旅馆 / 购物中心 / 保险，按真实素材图2 盘面逐格核对 */
export const WHEELS: Readonly<Record<WheelKind, WheelDef>> = {
  airline: { key: 'ui.roulette.0', sectors: [0, 1, 2, 3, 2, 1] },
  hotel: { key: 'ui.roulette.1', sectors: [1, 2, 3, 4] },
  mall: { key: 'ui.roulette.2', sectors: [6, 1, 2, 3, 4, 5] },
  insurance: { key: 'ui.roulette.3', sectors: [3, 5, 10, 15, 20, 30] },
};

export const WHEEL = { frame0: 2, frames: 12, angel: [0, 1], size: 165 } as const;

/**
 * 转盘停在 value 时的帧：每帧顺时针 30°，第 j 格扇区（从正上方起顺时针）转到正上方要转 (n−j) 个扇区 = (n−j)·12/n 帧。
 * value 不在盘面上时返回 null。
 */
export function wheelFrameFor(kind: WheelKind, value: number): number | null {
  const s = WHEELS[kind].sectors;
  const j = s.indexOf(value);
  if (j < 0) return null;
  const n = s.length;
  return WHEEL.frame0 + (((n - j) % n) * WHEEL.frames) / n;
}

/** 行业码 → 转盘（航空 / 保险；其余行业没有转盘） */
export function companyWheel(industry: number): WheelKind | null {
  const fee = TABLES.facilities.industries.find((d) => d.industry === industry)?.fee;
  return fee === 'airline' || fee === 'insurance' ? fee : null;
}

// ───────────────────────── 月结 / 终局 ─────────────────────────

export const MONEY_CARD = { frame: 5, w: 353, h: 450, x0: 19, y0: 41, dx: 83, cw: 64, ch: 88 } as const;
export const RANK_FRAME0 = 6;
export const HOST_FRAME = 19;
export const CHIBI_FRAME0 = 47;

export function chibiFrame(character: number, step = 0): number {
  return CHIBI_FRAME0 + 3 * Math.max(0, Math.min(11, Math.trunc(character))) + (step % 3);
}

/** 第 i 个名次格（相对 MONEY 卡左上角） */
export function moneySlot(i: number): Rect {
  return { x: MONEY_CARD.x0 + i * MONEY_CARD.dx, y: MONEY_CARD.y0, w: MONEY_CARD.cw, h: MONEY_CARD.ch };
}

// ───────────────────────── 资产表 ─────────────────────────

export const ASSETS = {
  pages: [0, 1, 2],
  exit: { normal: 5, hover: 6 },
  arrows: { up: 7, down: 8 },
  blueButton: 12,
  /** 页 0（逐像素统计的格线；数值栏与头像框按目视）：头像框、三颗蓝钮、中间与右侧各 4 行数值栏、下方道具 5×3 与卡片 5×3 */
  portrait: { x: 25, y: 153, w: 70, h: 94 },
  buttons: [
    { x: 13, y: 284 },
    { x: 13, y: 348 },
    { x: 13, y: 412 },
  ],
  fieldsL: { x: 176, y0: 72, dy: 48, w: 160, h: 32 },
  fieldsR: { x: 464, y0: 72, dy: 48, w: 144, h: 32 },
  labels: { x: 176, y0: 280, dy: 48, w: 82, h: 32 },
  itemGrid: { x: 265, y: 266, cols: 5, rows: 3, dx: 72, dy: 32, w: 70, h: 30 },
  cardGrid: { x: 265, y: 369, cols: 5, rows: 3, dx: 72, dy: 32, w: 70, h: 30 },
  /** 页 1 地产表：5 栏（格线 x=120/215/311/399/495/583），首行表头，行高 32（y=65 起） */
  estate: { cols: [121, 217, 313, 401, 497, 583], y0: 65, dy: 32, h: 30, rows: 12 },
  /** 页 2 股票表：3 栏（格线 x=144/263/399/551），首行表头（y=85 起） */
  stocks: { cols: [145, 265, 401, 551], y0: 85, dy: 32, h: 30, rows: 11 },
  /** 翻页箭头：页 1 的底图里画着上下箭头（逐像素统计 x=592..623、y=368 / 417 起 31×31），页 2 没有，叠图7/8 */
  pager: { x: 592, up: 368, down: 417, size: 31 },
  exitAt: { x: 546, y: 23 },
  faceAt: { x: 24, y: 58 },
  switchAt: { x: 100, up: 58, down: 100 },
} as const;

const GOD_ORDER: readonly GodKind[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15];

/** 神明小像帧（Panel#9 图13–24；恶犬没有） */
export function godFrame(kind: GodKind): number | null {
  const i = GOD_ORDER.indexOf(kind);
  return i < 0 ? null : 13 + i;
}

// ───────────────────────── 托管 AI ─────────────────────────

export const AUTOPLAY = {
  dialog: { frame: 0, w: 435, h: 355 },
  tab: { on: 1, off: 2, w: 116, h: 86 },
  dot: 3,
  arrows: { left: 4, right: 5 },
  head0: 6,
  /**
   * 对话框里（逐像素统计与目视）：第一组两行（用卡 / 用道具）、第二组三行（个性）的红点左上角，行名栏在点右侧 22；
   * 两条比例滑杆的刻度区（10 格、每格 8px = 10%）与左右箭头；右侧两个框钮
   */
  toggles: [
    { x: 186, y: 45 },
    { x: 186, y: 77 },
  ],
  personality: [
    { x: 186, y: 133 },
    { x: 186, y: 165 },
    { x: 186, y: 197 },
  ],
  headers: [
    { x: 137, y: 20 },
    { x: 137, y: 108 },
    { x: 193, y: 240 },
  ],
  rowLabel: { dx: 22, w: 76, h: 18 },
  sliders: [
    { x: 209, y: 266, w: 80, h: 22 },
    { x: 209, y: 299, w: 80, h: 22 },
  ],
  arrowW: 12,
  buttons: [
    { x: 374, y: 95, w: 46, h: 60 },
    { x: 374, y: 180, w: 46, h: 60 },
  ],
} as const;

export function autoplayHead(character: number): number {
  return AUTOPLAY.head0 + Math.max(0, Math.min(11, Math.trunc(character)));
}
