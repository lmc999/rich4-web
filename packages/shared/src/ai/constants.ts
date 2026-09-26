/**
 * 原版 AI 的经济判据常数（design/minigames-ai.md §8–§9.7；VA 为 exe v3.11 地址，需按 v2.06 复核 ⚑）。
 * 买地保留额（5%、7000）与 BasicAiPolicy 共用，放在 data/tables/economy（architecture §17.2）。
 */

/** 个性闸门：d = f7 − personality；d ≥ 2 从不做，d == 1 时 rng%3==0 才做（@0x41e69e / 0x420e9a） */
export const GATE_NEVER = 2;
export const GATE_ONE_IN = 3;

/** 买股票：rand%3 必须为 0（@0x42bf14）；到期前 15 天内不买 */
export const STOCK_BUY_GATE = 3;
export const STOCK_BUY_LOAN_DAYS = 15;
/** 选股：第 i 名 rand%24 ≤ 12 − i 才选中 */
export const STOCK_RANK_MOD = 24;
export const STOCK_RANK_BASE = 12;
/** 打分门槛：无企业股票存款须 > 30000·PI，有企业须 > 20000·PI */
export const STOCK_PLAIN_MIN_DEPOSIT = 30000;
export const STOCK_COMPANY_MIN_DEPOSIT = 20000;
/** 有企业：月均盈余档位 5000·PI / 10000·PI */
export const STOCK_SURPLUS_LOW = 5000;
export const STOCK_SURPLUS_HIGH = 10000;
/** 卖股票：没有还款压力时 rand%3 必须为 0（@0x42c802）；压力 = 到期 ≤ 6 天且现金+存款 < 贷款 */
export const STOCK_SELL_GATE = 3;
export const STOCK_PRESSURE_DAYS = 6;

/** ATM：现金比例 t，当月 1–7 日 ×1.5、26 日及以后 ×0.5；t ≥ 1 取 0.9、t ≤ 0 取 0.1；偏离 ≥ 0.25 才调整（@0x437acd） */
export const ATM_EARLY_LAST_DAY = 7;
export const ATM_LATE_FIRST_DAY = 26;
export const ATM_BAND = 0.25;

/** 柜台：rand%10==0 或 现金+存款 < 30000 才借；到期 ≤ 6 天且现金+存款 ≥ 1.1×贷款时还清（@0x436668） */
export const LOAN_RNG_MOD = 10;
export const LOAN_CASH_FLOOR = 30000;
export const REPAY_DAYS = 6;

/** 认购：保留 trunc(开局资金 × 30%) × PI 的现金（@0x41d267） */
export const SUBSCRIBE_RESERVE_PCT = 30;

/** 乐透：现金 > 1000 才买（@0x43169e） */
export const LOTTERY_MIN_CASH = 1000;

/** 商店：点券 < 100 时变卖；道具按此顺序各买一件：遥控骰子、路障、飞弹、机器娃娃、定时炸弹、地雷（@0x42ed8d..0x42f307） */
export const SHOP_LOW_POINTS = 100;
export const SHOP_TOOL_ORDER = [8, 2, 7, 1, 4, 3] as const;

/** 骰子颗数：身背定时炸弹引信 < 15 时只掷 1 颗；前瞻 5 格（@0x4221c0） */
export const DICE_BOMB_FUSE = 15;
export const DICE_LOOKAHEAD = 5;
