/**
 * 企鹅挖宝（落点码 6）常量。规则权威：design/minigames-ai.md §3；原版细节：research/r_minigames_chars.md §1.2。
 * VA 均指 v3.11 合版 exe。⚑ = 单一来源或待核实（VERIFY V-C1 / minigames-ai §11 M3–M7），当前按推荐默认实现。
 */
import { MINIGAME_TIMING } from '../types';

export const PENGUIN_TIMING = MINIGAME_TIMING.penguin;

/** 棋盘 9×9 索引，格号 = 行×9 + 列 */
export const BOARD_N = 9;
export const CELL_COUNT = BOARD_N * BOARD_N;

/** 冰屋格（第 4 行第 4 列），画在 (320,225)，不可走 */
export const IGLOO_CELL = 40;

/**
 * ⚑ 有效格掩码（按行的列区间，含端点）：@source 格表 v311:0x474d7c（81×8 字节，word[0]==0 为无效），B 级，M4 待核实。
 * 第 4 行另外去掉冰屋所在的第 4 列。合计 64 格。
 */
export const VALID_COL_RANGES: readonly (readonly [number, number])[] = Object.freeze([
  [3, 6],
  [1, 7],
  [1, 8],
  [0, 8],
  [0, 8],
  [0, 8],
  [0, 7],
  [1, 7],
  [2, 5],
] as const);

export const VALID_CELL_COUNT = 64;

/** ⚑ 起点：第 6 行第 2 列 = 格 56。@source v311:0x4148a2（B，M5） */
export const START_CELL = 56;

/** 格心（舞台坐标）：x = 48(r+c) − 64，y = 24(r−c) + 225；菱形半宽 48、半高 24 */
export const CELL_ORIGIN_X = -64;
export const CELL_ORIGIN_Y = 225;
export const CELL_HALF_W = 48;
export const CELL_HALF_H = 24;

/** 埋藏物类型：0 空；1 炸弹；2..5 宝物 */
export const ITEM_NONE = 0;
export const ITEM_BOMB = 1;

/**
 * 埋藏件数模板（类型 1..5 依次埋 3/12/3/9/1 件）。@source v311:0x411fc8（A，dword×5）
 * 下标 = 类型；下标 0 占位。
 */
export const BURY_COUNTS: readonly number[] = Object.freeze([0, 3, 12, 3, 9, 1]);

/** 各类型分值：炸弹 0（挖到即结束）；2=5 分、3=12 分、4=8 分、5=20 分。@source v311:0x413d6a..0x413da6（A） */
export const ITEM_SCORE: readonly number[] = Object.freeze([0, 0, 5, 12, 8, 20]);

/** 理论满分 = 5×12 + 12×3 + 8×9 + 20×1 */
export const PENGUIN_MAX_SCORE = 188;

/** 走一格 4 tick；到达后挖 4 tick。@source minigame-screen 企鹅段（A） */
export const TICKS_PER_CELL = 4;
export const DIG_TICKS = 4;

/** 16.16 定点 */
export const FX_SHIFT = 16;
/** ⚑ DDA 副轴取整：round(fx) = (fx + 0x8000) >> 16。@source v311:0x41211c / 0x412287（B，M6） */
export const FX_HALF = 0x8000;

/**
 * 朝向（仅表现用）：按屏幕八方位，0=右 1=右下 2=下 3=左下 4=左 5=左上 6=上 7=右上。
 * 行 +1 → 屏幕右下，列 +1 → 屏幕右上。
 */
export const DIR_INITIAL = 2;

/** 结算姿势分档（表现层）：<40 低、>55 高、其余中。@source v311:0x4149c8 / 0x4149e8（A） */
export const POSE_LOW_BELOW = 40;
export const POSE_HIGH_ABOVE = 55;

/*
 * 其余按推荐默认实现的 ⚑ 项：
 * - 揭晓瞬间完成（挖掘第 4 tick 结束时揭晓），揭晓后立即可以再次点击（M7：揭晓动画期间点击不被吞）。
 * - 第一步就无路可走时原地挖当前格；DDA 某步两轴都停时原地「走」一格（仍耗 4 tick），直到步数用完。
 * - 起点格也参与埋藏（free 从 64 起）。
 */
