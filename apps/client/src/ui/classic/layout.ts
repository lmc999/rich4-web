// 路线 A 的舞台与区域（original-skin.md §4.1；ui.md §2.1 主画面）：640×480 逻辑坐标，等比缩放、letterbox 居中；
// 舞台左右剩余宽度放联机侧栏，宽度不足时收成抽屉按钮。纯函数，不碰 DOM。
//
// 原版区域（坐标以 ui 调研与 mockup-main-640x480 为准）：
//   工具列   (0,0)   440×40   Panel#1：图0 底条，图1–11 常态、图12–22 悬停，第 i 钮画点 (i·40+20, 20)
//   棋盘视窗 (0,40)  440×440  嵌入 BoardSurface 的画布（真实像素，不随舞台 transform 缩放）
//   资料栏   (440,0) 200×280  Panel#0 四页
//   日历     (440,280) 200×200 Panel#2 / 节日图 / 缩小地图
// 各屏内部的精确坐标（资料栏数值、物价指数、日历文字、页签命中区、GO 钮）原版未逐屏逆向，这里按素材目视取值（visual）。

export const STAGE_W = 640;
export const STAGE_H = 480;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const REGION = {
  toolbar: { x: 0, y: 0, w: 440, h: 40 },
  board: { x: 0, y: 40, w: 440, h: 440 },
  profile: { x: 440, y: 0, w: 200, h: 280 },
  calendar: { x: 440, y: 280, w: 200, h: 200 },
} as const satisfies Record<string, Rect>;

/** 工具列按钮：宽 40，第 i 钮画点 (i·40+20, 20)（ui.md：11 钮正好铺满 440 宽） */
export const TOOL_W = 40;
export const TOOL_COUNT = 11;
export function toolPoint(i: number): { x: number; y: number } {
  return { x: i * TOOL_W + TOOL_W / 2, y: 20 };
}

/** GO 钮（Panel#7 72×67，锚点 0,0）：棋盘视窗右下角（mockup 的示意位置） */
export const GO_RECT: Rect = { x: 360, y: 400, w: 72, h: 67 };
/**
 * 骰子数竖槽：GO 钮掩膜 Panel#8 的区 1（钮内 x7..22、y9..56，逐像素统计），点按切换颗数；
 * 骰子数小图（Panel#7 图6–11，15×15，锚点 0,0）画在槽内竖直居中（槽内亮区 x7..20，偏左 0 像素）
 */
export const DICE_COUNT_RECT: Rect = { x: GO_RECT.x + 7, y: GO_RECT.y + 9, w: 16, h: 48 };
/** 骰子数小图在竖槽按钮内的画点（按钮左上角为原点） */
export const DICE_COUNT_SPRITE = { x: 0, y: 16 } as const;

/** 滚骰 FLC（Panel#4/5/6 189×285）：棋盘视窗正中 */
export const DICE_FLC_RECT: Rect = { x: (440 - 189) / 2, y: 40 + (440 - 285) / 2, w: 189, h: 285 };

/** 侧栏至少这么宽才整栏显示，否则收成抽屉（844×390 的手机横屏两侧各约 162px → 抽屉） */
export const RAIL_FULL_MIN = 180;
/** 侧栏最宽（超宽屏时整体居中） */
export const RAIL_MAX = 380;
/** 抽屉模式下两侧至少留这么宽放抽屉按钮（不足时缩小舞台） */
export const GUTTER_MIN = 48;

export type RailMode = 'full' | 'drawer';

export interface ClassicLayoutBox {
  /** 容器尺寸（CSS 像素） */
  width: number;
  height: number;
  /** 舞台缩放：min(W/640, H/480)（抽屉按钮放不下时扣掉两侧边距再算） */
  scale: number;
  /** 整数倍（≥1）时最近邻，否则平滑 */
  pixelated: boolean;
  /** 舞台（CSS 像素，相对容器；x/y 取整） */
  stage: Rect;
  /** 棋盘视窗（CSS 像素） */
  board: Rect;
  rails: RailMode;
  /** 左右侧栏（full）或放抽屉按钮的边距条（drawer） */
  left: Rect;
  right: Rect;
}

/** 缩放是否算整数倍 */
export function isIntegerScale(s: number): boolean {
  return s >= 1 && Math.abs(s - Math.round(s)) < 1e-3;
}

/** 舞台逻辑坐标的矩形 → 容器像素（按舞台缩放，四边取整） */
export function stageToScreen(box: Pick<ClassicLayoutBox, 'stage' | 'scale'>, r: Rect): Rect {
  const s = box.scale;
  const x0 = Math.round(box.stage.x + r.x * s);
  const y0 = Math.round(box.stage.y + r.y * s);
  const x1 = Math.round(box.stage.x + (r.x + r.w) * s);
  const y1 = Math.round(box.stage.y + (r.y + r.h) * s);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 舞台内元素的绝对定位样式（区域坐标只在这里定义一次，DOM 测试直接读 style） */
export function regionStyle(r: Rect): { left: number; top: number; width: number; height: number } {
  return { left: r.x, top: r.y, width: r.w, height: r.h };
}

/** 计算舞台、棋盘视窗与侧栏的位置 */
export function computeClassicLayout(width: number, height: number): ClassicLayoutBox {
  const W = Math.max(1, width);
  const H = Math.max(1, height);
  let scale = Math.min(W / STAGE_W, H / STAGE_H);
  let side = (W - STAGE_W * scale) / 2;
  if (side < GUTTER_MIN) {
    // 4:3 或更窄：给抽屉按钮留出边距
    scale = Math.min((W - 2 * GUTTER_MIN) / STAGE_W, H / STAGE_H);
    side = (W - STAGE_W * scale) / 2;
  }
  scale = Math.max(0.1, scale);
  const sw = STAGE_W * scale;
  const sh = STAGE_H * scale;
  const rails: RailMode = side >= RAIL_FULL_MIN ? 'full' : 'drawer';
  const railW = Math.max(0, Math.floor(rails === 'full' ? Math.min(RAIL_MAX, side) : side));
  // 整体（左栏 + 舞台 + 右栏）水平居中、舞台垂直居中
  const total = sw + 2 * railW;
  const x0 = Math.round((W - total) / 2);
  const stageX = x0 + railW;
  const stageY = Math.round((H - sh) / 2);
  const stage: Rect = { x: stageX, y: stageY, w: Math.round(sw), h: Math.round(sh) };
  const left: Rect = { x: x0, y: 0, w: railW, h: H };
  const right: Rect = { x: stageX + stage.w, y: 0, w: railW, h: H };
  const partial = { stage, scale };
  return {
    width: W,
    height: H,
    scale,
    pixelated: isIntegerScale(scale),
    stage,
    board: stageToScreen(partial, REGION.board),
    rails,
    left,
    right,
  };
}
