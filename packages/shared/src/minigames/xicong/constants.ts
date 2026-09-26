/**
 * 喜从天降（落点码 8）常量。规则权威：design/minigames-ai.md §5；原版细节：research/r_minigames_chars.md §1.4。
 * VA 均指 v3.11 合版 exe。⚑ = 单一来源或待核实（minigames-ai §11 M14–M18），当前按推荐默认实现。
 */
import { MINIGAME_TIMING } from '../types';

export const XICONG_TIMING = MINIGAME_TIMING.xicong;

// ───────────── 财神 ─────────────

/** 财神 y 与活动范围、每 tick 步长。@source 0x4138ba..0x413a22（A/B） */
export const GOD_Y = 126;
export const GOD_MIN_X = 110;
export const GOD_MAX_X = 530;
export const GOD_STEP = 12;
/** 左右半场分界（转身掷骰、炸弹落点） */
export const MID_X = 320;

/**
 * ⚑ 财神状态机（跳表 0x413234，M18）：0 向右走；2 右端转身；3 左端转身；4 向左走；1 不可达。
 * 行走段：frame 0..4 每拍先判 frame == spawnFrame 则在当前 x 撒一件，再 frame++、x±12；
 * frame == 5 的那一拍是决策拍：向右时若 x > 320 先掷 rand%4，结果为 0 或 x == 530 就转身（x 不动）；
 * 否则 spawnFrame = rand%5、x±12、frame 清零。向左对称，条件为 x < 320 或 x == 110。
 * 这样行走时每拍恰好 ±12，一段 6 拍 72px；向右的决策点为 170/242/314/386/458/530，向左为 470/398/326/254/182/110。
 * 转身段：每拍 frame++，走满 5 帧当拍切到 4 / 0、frame 清零（是否另有一拍空转待核实）。
 */
export const GOD_WALK_RIGHT = 0;
export const GOD_TURN_RIGHT_END = 2;
export const GOD_TURN_LEFT_END = 3;
export const GOD_WALK_LEFT = 4;
export const GOD_SEGMENT_FRAMES = 5;
/** 转身掷骰 rand%4 == 0 才转身（在远半场） */
export const GOD_TURN_ROLL = 4;
/** 撒宝帧 rand%5 */
export const GOD_SPAWN_ROLL = 5;

/** 初始：state 3（左端转身）、frame 4、x 110。⚑ 初始 spawnFrame 取 0（资料未给出；转身结束时不重掷） */
export const GOD_INIT_STATE = GOD_TURN_LEFT_END;
export const GOD_INIT_FRAME = 4;
export const GOD_INIT_X = GOD_MIN_X;
export const GOD_INIT_SPAWN_FRAME = 0;

/** ending 阶段财神停下的表现帧（state 2、frame 2） */
export const GOD_IDLE_STATE = GOD_TURN_RIGHT_END;
export const GOD_IDLE_FRAME = 2;

// ───────────── 掉落物 ─────────────

/** 最多 16 件；ix == 0 表示空槽 */
export const ITEM_SLOTS = 16;

/**
 * 类型：0 = 10 分（10%）、1 = 5 分（15%）、2 = 3 分（30%）、3 = 1 分（45%）、4 = 炸弹。
 * rand%20：<9 → 3；<15 → 2；<18 → 1；其余 → 0。rand 在找空槽之前就掷。@source 0x4123d7..0x412463（A）
 */
export const ITEM_BOMB = 4;
export const ITEM_ROLL = 20;
export const ITEM_SCORE: readonly number[] = Object.freeze([10, 5, 3, 1, 0]);

/** 下落：起点 y = 100，初速 −16；y < 130 时速度每 tick +2（上限 16）；之后按 FALL 匀速。@source v311:0x475010、0x4134b3（A） */
export const ITEM_START_Y = 100;
export const ITEM_START_VY = -16;
export const ITEM_GRAVITY = 2;
export const ITEM_MAX_VY = 16;
export const ITEM_TOSS_UNTIL_Y = 130;
export const FALL: readonly number[] = Object.freeze([24, 18, 15, 12, 15]);
/** y > 380 算漏接 */
export const ITEM_MISS_Y = 380;

/** ⚑ 横向摆动：判定点 px = x + trunc(frame·max(0, y−130)/250)，frame 取 0..7 循环。@source 0x4132bc（B） */
export const SWAY_DIV = 250;
export const SWAY_FRAMES = 8;

// ───────────── 接物者（玩家角色） ─────────────

/** y = 380；鼠标 x 与自身相差 > 8 才追，每 tick 10px。@source 0x413606..0x413688（A） */
export const CATCHER_Y = 380;
export const CATCHER_DEADZONE = 8;
export const CATCHER_SPEED = 10;
/** 行走动画帧数（表现用） */
export const CATCHER_FRAMES = 10;
/** ⚑ 初始位置与光标：舞台中央（资料未给出） */
export const CATCHER_INIT_X = 320;

/**
 * ⚑ 接住矩形：默认贴图 66×72、锚点 (33,71) → x−33 < px < x+33 且 309 < y < 381。@source 0x413743（B，M16）
 */
export const CATCH_HALF_W = 33;
export const CATCH_TOP_Y = 309;
export const CATCH_BOTTOM_Y = 381;

/** ⚑ 只有移动中（dir ≠ 0）才判定接住（remake 读法，M16）；核实为「静止也能接」时改 false 并刷新 golden */
export const CATCH_REQUIRES_MOVING = true;

/**
 * ⚑ 进入 ending（时间到或被炸）后接物者停下（dir = 0）且不再判定接住：资料只说「时间到后不再跟随鼠标」
 * 与「接到炸弹立即结束，已得分数保留」，这里取两者一致的读法。
 */

// ───────────── 炸弹 ─────────────

/**
 * 预警：未激活时若（state < 2 且 x > 320）或（state > 3 且 x < 320），先掷 r = rand%10，r ≥ 7（30%）且处于游玩中
 * 才掷 rand%140 起预警；落点在财神另一侧：财神 x > 320 → 160 + r，否则 360 + r。@source mytbk asm 0x41375b..0x4137e8（A）
 */
export const WARN_ROLL = 10;
export const WARN_PASS_BELOW = 7;
export const WARN_X_ROLL = 140;
export const WARN_X_LEFT = 160;
export const WARN_X_RIGHT = 360;
/** 预警 12 帧，第 8 帧（且未被炸）投下炸弹 */
export const WARN_FRAMES = 12;
export const WARN_DROP_AT = 8;

/** 结算姿势分档（表现层）：<40、40–49、50–59、≥60。@source 0x4150fe..0x41512c（A） */
export const POSE_THRESHOLDS: readonly number[] = Object.freeze([40, 50, 60]);

/** ⚑ 每 tick 的世界更新顺序：接物者 → 掉落物 → 预警 → 财神（v311:0x413248，M17） */
