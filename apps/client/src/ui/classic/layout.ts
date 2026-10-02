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
/**
 * GO 钮骰子数竖槽里的小骰子（exe fcn.004169f6，按 vehicle&3 分支，跳表 0x4169e6）：步行 / 工程车 1 个、机车 2 个、汽车 3 个
 * 竖着叠放；第 i 个在「i < 骰子数且没有停留」时画亮图 2i+7、画点 x=7，否则画灰图 2i+6、x=8（图 6–11 两两成对：
 * 第 1/2/3 个骰子 = 1/2/3 点）。坐标为 GO 钮内（锚点 0,0）：
 * - 1 个：y=26（0x416b67–0x416bb6）；2 个：y=16+19i（0x416bb8–0x416c64）；3 个：y=9+16i（0x416c66–0x416d06）
 */
export interface DiceSlotIcon {
  frame: number;
  x: number;
  y: number;
  on: boolean;
}

export function diceSlotIcons(slots: number, count: number, stay: boolean): DiceSlotIcon[] {
  const n = Math.min(3, Math.max(1, Math.trunc(slots)));
  const out: DiceSlotIcon[] = [];
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 26 : n === 2 ? 16 + 19 * i : 9 + 16 * i;
    const on = i < count && !stay;
    out.push(on ? { frame: 2 * i + 7, x: 7, y, on } : { frame: 2 * i + 6, x: 8, y, on });
  }
  return out;
}

/** 骰子 FLC（Panel#4/5/6 189×285）的尺寸 */
export const DICE_FLC_W = 189;
export const DICE_FLC_H = 285;
/**
 * 骰子 FLC 的画点（exe fcn.00418d0b 0x418d50–0x418d83，屏幕 640×480 坐标）：(136, 48) + 表 0x4730ac[方向槽]，
 * 方向槽 = (8 − 视角 + 朝向) & 7（与人物精灵的方向槽同一公式）。原版镜头跟着行动者，所以 FLC 落在人物头顶一带、
 * 随朝向偏移（不在棋盘视窗正中）
 */
export const DICE_FLC_ORIGIN = { x: 136, y: 48 } as const;
export const DICE_FLC_OFFSETS: readonly (readonly [number, number])[] = Object.freeze([
  [4, 12],
  [12, 12],
  [8, 6],
  [-4, -6],
  [-12, -12],
  [-24, -12],
  [-20, -6],
  [-12, 6],
]);

/** 骰子 FLC 的矩形（舞台坐标，人物在棋盘视窗中心、1 源像素 = 1 舞台像素时）；方向槽未知时按槽 0 */
export function diceFlcRect(slot: number | null | undefined): Rect {
  const s = slot === null || slot === undefined ? 0 : ((Math.trunc(slot) % 8) + 8) % 8;
  const [dx, dy] = DICE_FLC_OFFSETS[s]!;
  return { x: DICE_FLC_ORIGIN.x + dx, y: DICE_FLC_ORIGIN.y + dy, w: DICE_FLC_W, h: DICE_FLC_H };
}

/**
 * 原版的渲染基准：镜头对准的世界点画在屏幕 (220,260)，即棋盘视窗 (0,40) 440×440 的中心（render.md §1.3）。
 * 原版每 tick 把镜头设为行动者的世界坐标（0x40d35c–0x40d394 → fcn.00407ebd(p.x,p.y)），所以掷骰时人物锚点恒在这里
 */
export const BOARD_RENDER_BASE = { x: 220, y: 260 } as const;
/** 骰子相对人物的比例（棋盘缩放 / 舞台缩放）的上下限：太小看不清点数，太大超出棋盘视窗 */
export const DICE_SCALE_MIN = 0.5;
export const DICE_SCALE_MAX = 1.5;
/** FLC 上缘可以伸出棋盘视窗的高度（原版方向槽 4、5 的 FLC 顶在 y=36，比视窗上缘高 4 像素） */
const DICE_TOP_SLACK = 12;

/** 掷骰的人在棋盘画布上的位置（与 uiStore 的 DiceAnchor 同形；这里是纯函数，不依赖 store） */
export interface DiceAnchorLike {
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
}

export interface DicePlacement {
  /** FLC 左上角（舞台坐标） */
  x: number;
  y: number;
  /** FLC 与点数面相对原版尺寸的比例（1 = 1 个棋盘源像素对 1 个舞台像素） */
  scale: number;
  /** 按人物实际的画面位置摆的（false：没有位置或人物不在视窗里，按人物在视窗中心摆） */
  tracked: boolean;
}

/**
 * 骰子 FLC 的摆放（exe fcn.00418d0b 0x418d50–0x418d83 的画点 (136,48)+表 0x4730ac[槽]，相对人物锚点 (220,260) 换算）：
 * FLC 左上 = 人物锚点 + ((136,48) − (220,260) + T[槽]) × k，k = 棋盘缩放 / 舞台缩放（1 个棋盘源像素是几个舞台像素），
 * FLC 与点数面按同一比例缩放——骰子相对人物的位置和大小与原版一致，不受镜头跟随偏移、手动拖动、缩放的影响。
 * - 锚点（舞台坐标）= 棋盘视窗左上 + 画布坐标 × 440 / 画布宽；k 夹在 [DICE_SCALE_MIN, DICE_SCALE_MAX]；
 * - 没有位置（程序化棋盘、人物不在棋盘上），或人物不在棋盘视窗里（关闭跟随、pin 别的座位时走出了画面）：按人物在视窗中心摆，
 *   与原版镜头对准行动者时相同，不画到看不见的地方；
 * - 整块 FLC 夹在棋盘视窗之内（上缘按原版允许伸出 12 像素）。
 */
export function diceFlcPlacement(
  slot: number | null | undefined,
  at: DiceAnchorLike | null | undefined,
): DicePlacement {
  const base = diceFlcRect(slot);
  const vp = REGION.board;
  if (!at || !(at.w > 0) || !(at.h > 0) || !(at.zoom > 0)) return { x: base.x, y: base.y, scale: 1, tracked: false };
  const k = Math.min(DICE_SCALE_MAX, Math.max(DICE_SCALE_MIN, (at.zoom * vp.w) / at.w));
  let ax = vp.x + (at.x * vp.w) / at.w;
  let ay = vp.y + (at.y * vp.h) / at.h;
  const inside = ax >= vp.x && ax <= vp.x + vp.w && ay >= vp.y && ay <= vp.y + vp.h;
  if (!inside) {
    ax = BOARD_RENDER_BASE.x;
    ay = BOARD_RENDER_BASE.y;
  }
  const w = DICE_FLC_W * k;
  const h = DICE_FLC_H * k;
  const x = ax + (base.x - BOARD_RENDER_BASE.x) * k;
  const y = ay + (base.y - BOARD_RENDER_BASE.y) * k;
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return {
    x: clamp(x, vp.x, vp.x + vp.w - w),
    y: clamp(y, vp.y - DICE_TOP_SLACK, vp.y + vp.h - h),
    scale: k,
    tracked: inside,
  };
}

/**
 * 点数面（Panel#3）的画点，相对 FLC 左上角（exe 0x418de8–0x418e1c：(x0+0x55, y0+0x91)，第 i 颗画帧 6i+点数−1）。
 * 三套角度的锚点把它们分别摆到 FLC 底部的左、中、右，和 FLC 末帧的骰子重合
 */
export const DICE_FACE_POINT = { x: 0x55, y: 0x91 } as const;
/** 点数面素材缺失时 CSS 骰子的左上角（相对 FLC 左上角；按原版三套锚点换算的落点） */
export const DICE_FACE_FALLBACK: readonly (readonly [number, number])[] = Object.freeze([
  [1, 243],
  [96, 248],
  [153, 244],
]);

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

// ───────────────────────── toast 落点 ─────────────────────────

/** 边距条至少这么宽才把 toast 排进去（844×390 两侧各 162；667×375 只有 84，字一行放不下几个） */
export const TOAST_GUTTER_MIN = 140;
/** 边距条顶上留给抽屉按钮的高度：上内边距 8 + 按钮 44 + 间距 8（classic.module.css .drawerBtns / .drawerBtn） */
export const TOAST_GUTTER_TOP = 60;
/** toast 列表与空位边缘的距离 */
export const TOAST_INSET = 6;
/** 舞台右栏（资料栏 + 日历） */
const RIGHT_COLUMN: Rect = { x: 440, y: 0, w: 200, h: 480 };

/** 抽屉宽度（classic.module.css .drawer：min(320px, 86vw)） */
export function drawerWidth(viewportW: number): number {
  return Math.min(320, 0.86 * viewportW);
}

export type ClassicToastPlace = 'gutter-left' | 'gutter-right' | 'stage-right';

export interface ClassicToastSlot extends Rect {
  /** top：从上缘往下排（列表只有内容那么高，最高 h）；bottom：贴下缘往上长 */
  align: 'top' | 'bottom';
  place: ClassicToastPlace;
}

/**
 * 原版皮肤对局画面的 toast 落点（CSS 像素，相对舞台容器）；null = 网页版的缺省位置（页面上部正中）。
 * 只在舞台缩小（scale < 1，手机横屏）时挪：缺省位置的 toast 是固定的 CSS 像素大小，舞台缩小后正好叠在棋盘视窗上部——
 * 原版的亮卡、神明、新闻、命运弹窗与镜头焦点都在棋盘视窗里（亮卡消息框 (123,48)–(318,181)，844×390 时出卡人那一行
 * 被第一条 toast 盖住）。挪到棋盘视窗以外、没被抽屉盖住的第一个空位：
 * 1. 边距条（抽屉模式且宽 ≥ TOAST_GUTTER_MIN）：抽屉按钮以下、从上往下排，先左后右；这块本来空着，什么都不挡。
 *    哪边的抽屉开着就用另一边（两个抽屉不会同时开）；
 * 2. 舞台右栏（资料栏 + 日历，x 440–640）：边距条太窄（667×375）或整栏模式（侧栏有内容）时，贴右栏下缘往上长，
 *    一两条只盖住日历，多了往上伸进资料栏；抽屉盖住右栏时（窄屏开着聊天）不用；
 * 3. 都不行：null。
 * 桌面（scale ≥ 1）照旧：toast 相对舞台小，缺省位置一条只到工具列下缘附近。
 */
export function classicToastSlot(box: ClassicLayoutBox, drawer: 'left' | 'right' | null): ClassicToastSlot | null {
  if (!(box.scale < 1)) return null;
  if (box.rails === 'drawer') {
    for (const side of ['left', 'right'] as const) {
      const r = side === 'left' ? box.left : box.right;
      if (drawer === side || r.w < TOAST_GUTTER_MIN) continue;
      return {
        x: r.x + TOAST_INSET,
        y: r.y + TOAST_GUTTER_TOP,
        w: r.w - 2 * TOAST_INSET,
        h: r.h - TOAST_GUTTER_TOP - TOAST_INSET,
        align: 'top',
        place: side === 'left' ? 'gutter-left' : 'gutter-right',
      };
    }
  }
  const col = stageToScreen(box, RIGHT_COLUMN);
  const dw = drawerWidth(box.width);
  if (drawer === 'right' && box.width - dw < col.x + col.w) return null;
  if (drawer === 'left' && dw > col.x) return null;
  return {
    x: col.x + TOAST_INSET,
    y: col.y + TOAST_INSET,
    w: col.w - 2 * TOAST_INSET,
    h: col.h - 2 * TOAST_INSET,
    align: 'bottom',
    place: 'stage-right',
  };
}
