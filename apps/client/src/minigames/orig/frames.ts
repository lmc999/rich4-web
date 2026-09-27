// 小游戏原版视图的帧号与摆放（原版皮肤 A13；design-draft §3.6）。纯函数，不引入 Pixi，node 单测直接覆盖。
// 依据：v2.06 rich4.exe 的小游戏代码（0x411932..0x4155xx）与本机素材包逐帧目视（.cache/w3-mg/，不入库）：
// - 企鹅：Panel#80 图0 底图、图1 站立、图2 被炸焦黑、图3 冰屋 (320,225)、图4–8 埋藏物露头（炸弹/金币/红宝石/蓝宝石/钻石，
//   开局 1 秒内画在所有埋藏格上：0x413f39(1) 按 kind+3 取帧）、图9 挖开的雪坑（挖掘中画在当前格，0x41219a）；
//   Panel#82 走路、#83 挖掘各 8 方向 × 4 帧（方向序：下、右下、右、右上、上、左上、左、左下）；
//   Panel#84 / #85 高分（>55）/ 低分（<40）结算姿势（0x414c14..0x414c37 载入到 0x488a58 / 0x488a54，状态 4 / 5 绘制），
//   中间分数画站立帧；Panel#86–90 揭晓动画 6 帧（85 + 埋藏类型：86 炸弹爆炸、87 金币、88 红宝石、89 蓝宝石、90 钻石）；
// - 气球：Panel#91 图0 底图、图1–9 数字 1–9、图10 ×2、图11 ÷2、图12 ?（(kind & 15) + 1）、图13 爆开；
// - 喜从天降：财神 Panel#93 按状态机查表 0x472ea5（6 帧 × 5 态）画在 (x, 126)；捣蛋鬼预警 Panel#94 第 warn 帧画在 (warnX, 125)；
//   宝物 Panel#95–98（宝箱/钱袋/元宝/金币）与炸弹 #99，帧 = 摆动帧 0..7；接物者 Panel#100+角色：图0 站立、图1–3 结算表情、
//   图4 被炸，其后左走、右走各 (帧数 − 5) / 2 帧（0x4150b5）；结算表情按分数 <40 / <50 / <60 / ≥60 取图 1 / 2 / 0 / 3（0x414a10）；
// - 共用：Panel#79 图0–9 HUD 液晶数字 15×28（y = 421；各框 x 见下表，0x413a9c）、图10–19 大号彩色数字（结算：y = 150，
//   首位 x = 353 − 33n、间距 66，0x4140a7）。
import { penguin, xicong } from '@rich4/shared/minigames';

// ───────────────────────── 共用 HUD ─────────────────────────

/** HUD 液晶数字的贴点 y（三款底图的 HUD 条同一套框位） */
export const HUD_DIGIT_Y = 421;
/** 时间框：「%03d」+ 固定的 0（十分之一秒 → SS.T0） */
export const HUD_TIME_X: readonly number[] = [49, 69, 94, 114];
/** 四组两位数计数框（企鹅：钻石/红宝石/蓝宝石/金币；喜从天降：宝箱/钱袋/元宝/金币） */
export const HUD_PAIR_X: readonly (readonly [number, number])[] = [
  [185, 205],
  [276, 296],
  [367, 387],
  [458, 478],
];
/** 三位得分框（企鹅、喜从天降） */
export const HUD_SCORE3_X: readonly number[] = [549, 569, 589];
/** 四位得分框（七彩气球） */
export const HUD_SCORE4_X: readonly number[] = [529, 549, 569, 589];

/** 各底图 HUD 条的上沿（三张底图都在 y = 387；HUD 条盖在场景物件之上：气球从 y=420 升起、宝物落到 380 以下） */
export const HUD_TOP: Readonly<Record<'penguin' | 'balloon' | 'xicong', number>> = {
  penguin: 387,
  balloon: 387,
  xicong: 387,
};

/** 非负整数补零到 n 位；超过 n 位时夹到全 9 */
export function padDigits(v: number, n: number): string {
  const max = 10 ** n - 1;
  const x = Math.max(0, Math.min(max, Math.floor(v)));
  return String(x).padStart(n, '0');
}

/** 时间框的 4 位：剩余时间（十分之一秒）按「%03d」再补固定的 0 */
export function timeDigits(tenths: number): string {
  return `${padDigits(tenths, 3)}0`;
}

/** 喜从天降的时间框：tick 为 0.05 秒，HUD 显示 timeLeft / 2（原版 C 整除，向下取整；359 → 17.9 而非 18.0） */
export function xicongTimeTenths(timeLeft: number): number {
  return Math.floor(Math.max(0, timeLeft) / 2);
}

/** HUD 数字帧：'0'..'9' → 图 0..9 */
export function lcdFrame(ch: string): number {
  const d = ch.charCodeAt(0) - 48;
  return d >= 0 && d <= 9 ? d : 0;
}

/** 结算大号分数：每位的帧与画点（Panel#79 图10–19，锚点居中） */
export const BIG_SCORE_Y = 150;
export function bigScoreLayout(score: number): { frame: number; x: number; y: number }[] {
  const s = String(Math.max(0, Math.floor(score)));
  const x0 = 353 - 33 * s.length;
  return [...s].map((ch, i) => ({ frame: 10 + lcdFrame(ch), x: x0 + i * 66, y: BIG_SCORE_Y }));
}

// ───────────────────────── 企鹅挖宝 ─────────────────────────

export const PENGUIN_BG = {
  screen: 0,
  idle: 1,
  burnt: 2,
  igloo: 3,
  hole: 9,
} as const;

/** 埋藏物露头（开局记忆阶段）：类型 1..5 → Panel#80 图 4..8 */
export function penguinBuriedFrame(kind: number): number {
  return kind + 3;
}

/** sim 朝向（0 右 1 右下 2 下 3 左下 4 左 5 左上 6 上 7 右上）→ 精灵方向组（下、右下、右、右上、上、左上、左、左下） */
export function penguinDirGroup(dir: number): number {
  return (((2 - dir) % 8) + 8) % 8;
}

/** 走路帧（Panel#82）：方向组 × 4 + 本格内子步 0..3 */
export function penguinWalkFrame(dir: number, sub: number): number {
  return penguinDirGroup(dir) * 4 + Math.max(0, Math.min(3, sub));
}

/** 挖掘帧（Panel#83）：方向组 × 4 + 已挖的 tick（0..3） */
export function penguinDigFrame(dir: number, digLeft: number): number {
  return penguinDirGroup(dir) * 4 + Math.max(0, Math.min(3, penguin.DIG_TICKS - digLeft));
}

/** 揭晓动画精灵（Panel#86–90）：85 + 埋藏类型 */
export function penguinRevealKey(kind: number): string {
  return `mg.penguin.${85 + kind}`;
}

/** 结算姿势：高分（>55）Panel#84 循环、低分（<40）Panel#85 循环、中间画站立帧 */
export function penguinPoseKey(score: number): string | null {
  if (score < penguin.POSE_LOW_BELOW) return 'mg.penguin.85';
  if (score > penguin.POSE_HIGH_ABOVE) return 'mg.penguin.84';
  return null;
}

/** HUD 计数顺序（钻石、红宝石、蓝宝石、金币）对应的埋藏类型 */
export const PENGUIN_HUD_KINDS: readonly number[] = [5, 3, 4, 2];

// ───────────────────────── 七彩气球 ─────────────────────────

export const BALLOON_POP_FRAME = 13;

/** 气球帧：类型 0..11 → 图 1..12；爆开时图 13 */
export function balloonFrame(kind: number, popping: boolean): number {
  return popping ? BALLOON_POP_FRAME : (kind & 15) + 1;
}

/** 准星（ui.cursor = Data#0 图 6–8 三帧轮播） */
export const RETICLE_FRAMES: readonly number[] = [6, 7, 8];
export const RETICLE_FRAME_MS = 120;

// ───────────────────────── 喜从天降 ─────────────────────────

/** 财神帧表（0x472ea5：状态 0..4 × 帧 0..5） */
export const GOD_FRAMES: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 5, 6],
  [0, 1, 2, 4, 5, 6],
  [7, 8, 9, 10, 11, 0],
  [11, 10, 9, 8, 7, 0],
  [12, 13, 14, 15, 17, 18],
];
export const GOD_DRAW_Y = 126;
export const WARN_DRAW_Y = 125;

export function godFrame(state: number, frame: number): number {
  const row = GOD_FRAMES[state] ?? GOD_FRAMES[xicong.GOD_IDLE_STATE]!;
  return row[Math.max(0, Math.min(row.length - 1, frame))]!;
}

/** 掉落物精灵：类型 0..4（宝箱、钱袋、元宝、金币、炸弹）→ Panel#95..99 */
export function xicongItemKey(kind: number): string {
  return `mg.xicong.${95 + Math.max(0, Math.min(4, kind))}`;
}

/** 透视缩放：0.5 + (y − 130) / 250（y < 130 时 0.5） */
export function xicongItemScale(y: number): number {
  return 0.5 + Math.max(0, y - xicong.ITEM_TOSS_UNTIL_Y) / 250;
}

/** 接物者结算表情：分档 0..3（<40、<50、<60、≥60）→ 图 1、2、0、3 */
export const CATCHER_POSE_FRAMES: readonly number[] = [1, 2, 0, 3];
export const CATCHER_BOMB_FRAME = 4;
export const CATCHER_WALK_START = 5;

/** 每个方向的走路帧数（帧数 − 5）/ 2 */
export function catcherPerDir(count: number): number {
  return Math.max(1, (count - CATCHER_WALK_START) >> 1);
}

/**
 * 接物者帧：被炸 → 图4；结算（pose 非 null）→ 表情；移动（dir 1 左 / 2 右）→ 5 + (dir − 1) × perDir + 步帧；静止 → 图0。
 * 步帧 walk 由调用方给（移动中逐 tick 递增，按 perDir 取模）。
 */
export function catcherFrame(
  count: number,
  s: { catcherDir: number; hitBomb: boolean },
  walk: number,
  pose: number | null,
): number {
  if (s.hitBomb) return CATCHER_BOMB_FRAME;
  if (pose !== null) return CATCHER_POSE_FRAMES[pose] ?? 0;
  if (s.catcherDir === 1 || s.catcherDir === 2) {
    const per = catcherPerDir(count);
    return CATCHER_WALK_START + (s.catcherDir - 1) * per + (((walk % per) + per) % per);
  }
  return 0;
}

/** HUD 计数顺序（宝箱、钱袋、元宝、金币）= counts[0..3] */
export const XICONG_HUD_KINDS: readonly number[] = [0, 1, 2, 3];

/**
 * 被炸的爆炸（fx.godLeave = Data#485，110×110）画在 (接物者 x − 55, 295)。依据（v2.06 rich4.exe）：喜從天降的载入函数
 * fcn.00414f20 在 0x415016 载入 Data#485（与 Panel#78/79/92–99 同批）存到 0x488a68；接物判定 fcn.00412b66 接到 type 4（炸弹）
 * 时在 0x412d2b 以 (word[0x488ad6] − 0x37, 0x127) 播放它。与棋盘上的神明离身烟雾共用同一个资源。
 */
export const XICONG_BOOM_KEY = 'fx.godLeave';
export const XICONG_BOOM_DX = -55;
export const XICONG_BOOM_Y = 295;
