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

// ───────────────────────── M6：卡片与道具（design/minigames-ai.md §9.5–§9.7） ─────────────────────────

/** 连锁店过路费基数（与引擎 ECON.CHAIN_TOLL 相同，AI 估算同街过路费用） */
export const CHAIN_TOLL_BASE = 2000;
/** 每回合用卡最多看 8 张候选，用道具最多看 4 种（时光机不计）（@0x418e18） */
export const CARD_RING = 8;
export const ITEM_RING = 4;
/** AI 从不主动出的卡：换屋、转向与四张被动卡 */
export const AI_NEVER_PLAYS: readonly number[] = [5, 6, 18, 19, 20, 21];
/** 均富：平均现金 > 我的现金 × 10 且我的现金 < 3000·PI */
export const EQUAL_WEALTH_RATIO = 10;
export const EQUAL_WEALTH_CASH = 3000;
/** 均贫 / 查税：最恨的人现金 > 30000·PI；否则视野内对手现金 > 50000·PI */
export const HATED_CASH = 30000;
export const RIVAL_CASH = 50000;
/** 免费卡：金额 > 现金，或金额 > (rng%3000+3000)·PI；嫁祸（过路费、罚款）：金额 > (rng%4000+4000)·PI */
export const FREE_CARD_BASE = 3000;
export const SCAPEGOAT_BASE = 4000;
/** 嫁祸（查税）：我的现金 ≥ 20000·PI 才用 */
export const SCAPEGOAT_TAX_CASH = 20000;
/** 保释：点券 > 30 才保释玩家；≥ 700 才雇恶人（实际收 300）（@0x43d3d8） */
export const BAIL_MIN_POINTS = 30;
export const HIRE_MIN_POINTS = 700;
/** 通用资金门槛：现金 + 存款 > 10000 */
export const MONEY_FLOOR = 10000;
