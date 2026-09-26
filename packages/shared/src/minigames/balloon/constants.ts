/**
 * 七彩气球（落点码 7）常量。规则权威：design/minigames-ai.md §4；原版细节：research/r_minigames_chars.md §1.3。
 * VA 均指 v3.11 合版 exe。⚑ = 单一来源或待核实（minigames-ai §11 M8–M13），当前按推荐默认实现。
 */
import { MINIGAME_TIMING } from '../types';

export const BALLOON_TIMING = MINIGAME_TIMING.balloon;

/** 16 个槽。@source 0x413027（A） */
export const SLOT_COUNT = 16;

/** 8 条跑道 x = 40 + 80k（k = 0..7）；x == 0 表示空槽。@source 0x41305e（A） */
export const LANE_COUNT = 8;
export const LANES: readonly number[] = Object.freeze([40, 120, 200, 280, 360, 440, 520, 600]);

/** 生成位置 y。@source 0x41309b（A） */
export const SPAWN_Y = 420;

/** 跑道占用判据：该跑道上有气球 y > 300 时不能再放。@source 0x413083（A） */
export const LANE_BLOCK_Y = 300;

/**
 * 气球类型：0..8 = 数字 1..9（分值 kind+1）；9 = ×2；10 = ÷2；11 = ?
 */
export const KIND_DOUBLE = 9;
export const KIND_HALF = 10;
export const KIND_MYSTERY = 11;
export const KIND_COUNT = 12;

/** 生成掷骰：每 tick、每个空槽 r = rand%1000。@source 0x4131a5（A） */
export const SPAWN_ROLL = 1000;
/** r < 20 → 数字 1–5（kind = r>>2） */
export const SPAWN_LOW_BELOW = 20;
/** r < 28 → 数字 6–9（kind = ((27−r)>>1)+5） */
export const SPAWN_HIGH_BELOW = 28;
/** r < 30 → 特殊表[rand%10] */
export const SPAWN_SPECIAL_BELOW = 30;

/** 特殊表：×2 占 20%，÷2 占 50%，? 占 30%。@source v311:0x475039（A，M9） */
export const SPECIAL_TABLE: readonly number[] = Object.freeze([9, 9, 10, 10, 10, 10, 10, 11, 11, 11]);

/** 上升速度（px/tick），按类型 0..11。@source v311:0x475004（A，M8） */
export const SPEED: readonly number[] = Object.freeze([15, 15, 15, 15, 18, 18, 18, 24, 24, 24, 24, 18]);

/** 大球（kind < 6，数字 1–6）与小球（kind ≥ 6，数字 7–9 与特殊）的分界 */
export const BIG_KIND_BELOW = 6;

/** ⚑ 命中框半宽/半高（含端点，以气球坐标为中心）。@source 0x414f26（B，M11） */
export const HIT_BIG = Object.freeze({ hw: 22, hh: 30 });
export const HIT_SMALL = Object.freeze({ hw: 18, hh: 26 });

/**
 * ⚑ 出屏判据：y + off ≤ 0 时移除；off = 精灵高度 − 锚点 y。大球 141−30、小球 116−26、爆开图 122−40。
 * @source Panel.mkf #91 精灵头（B，M13）
 */
export const OFF_BIG = 111;
export const OFF_SMALL = 90;
export const OFF_POP = 82;

/** 爆开图停留 tick。@source 0x4130b6..0x4130d2（A） */
export const POP_TICKS = 3;

/** 数字气球加分后 ≥ 1000 时夹回 999（「999 bug」，只在加数字这一支）。@source 0x414ed6..0x414ef3（A，M12） */
export const DIGIT_CAP_AT = 1000;
export const DIGIT_CAP_TO = 999;

/** ? 的 6 种效果（rand%6）：0 剩余时间 = 1；1 冻结；2 速度 ×2；3 速度 ÷2；4 分数清零；5 分数 ×2。@source 0x414ba4 跳表（A） */
export const MYSTERY_EFFECTS = 6;
export const EFFECT_TIME_ONE = 0;
export const EFFECT_FREEZE = 1;
export const EFFECT_FAST = 2;
export const EFFECT_SLOW = 3;
export const EFFECT_ZERO = 4;
export const EFFECT_DOUBLE = 5;

/**
 * ⚑ 冻结 20 tick：点击发生在 step 开头，本 step 先 freeze−− 再判断，所以气球实际停 19 个 step（按 §4.2 伪代码顺序）。
 */
export const FREEZE_TICKS = 20;

/** 速度模式：0 正常；1 ×2；2 ÷2（>>1） */
export const SPEED_NORMAL = 0;
export const SPEED_FAST = 1;
export const SPEED_SLOW = 2;

/** ⚑ 无可用跑道时不掷选道的那次 rand（M10） */
export const ROLL_LANE_WHEN_NONE = false;

/** ×2 / ? 翻倍后的上限（不夹 999，只防 int32 溢出） */
export const SCORE_SAT = 0x7fffffff;
