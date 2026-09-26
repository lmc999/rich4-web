/**
 * 全局常数（design/engine.md §14 economy.ts）。每条都带出处；引擎代码通过 ECON.xxx 取值。
 * 证据缺失、先按默认值实现的条目在 note 里标 ⚑（DEV-12），等待 docs/VERIFY.md 核实。
 */
import type { Sourced, Src } from '../source';

export interface EconConst extends Sourced {
  value: number;
  note: string;
}

const R = (research: string): Src => ({ research });
const V = (verify: string): Src => ({ verify });
const X = (va: string): Src => ({ exe: '3.11', va });

function c(value: number, note: string, src: Src[], confidence: Sourced['confidence'] = 'high'): EconConst {
  return Object.freeze({ value, note, src, confidence });
}

export const ECONOMY = Object.freeze({
  /** 物价指数初值 */
  PRICE_INDEX_INIT: c(1, '开局物价指数为 1，只升不降', [
    R('docs/research/r_rules_map.md §7'),
    R('docs/research/r_property.md §2'),
  ]),
  /** 地产最高等级 */
  MAX_LEVEL: c(5, '空地 0 → 摩天大楼 5', [R('docs/research/r_property.md §3.1')]),
  /** 连锁店单店过路费基数 */
  CHAIN_TOLL: c(2000, '过路费 = 2000 × 地主连锁店数 × PI', [X('0x419744'), R('docs/research/r_property.md §5')]),
  /** 手牌上限 */
  HAND_MAX: c(15, '满手时自动弃最便宜的一张（handFull=autoCheapest）', [
    X('0x4412e4'),
    R('docs/research/g_arbitration.md §1、§2.g'),
  ]),
  /** 每种道具的持有上限 */
  ITEM_MAX: c(9, '每种道具最多 9 个', [R('docs/research/g_arbitration.md §1')]),
  /** 1..8 号道具的全局库存初值 */
  ITEM_POOL_INIT: c(10, '机器娃娃…遥控骰子各 10 个', [X('0x47fee2'), R('docs/research/r_references.md §2.2')]),
  /** 卖回价 = trunc(标价 × 数量 × 9 / 10) */
  SELL_RATE_NUM: c(9, '卖回价的分子', [R('docs/research/g_arbitration.md §1')]),
  SELL_RATE_DEN: c(10, '卖回价的分母', [R('docs/research/g_arbitration.md §1')]),
  /** 点券上限（uint16） */
  POINTS_MAX: c(65535, 'saturate 模式夹到 65535（DEV-01）', [R('docs/research/r_references.md §2.3')]),
  /** 落点码 10/11/12 */
  POINTS_SQUARE_50: c(50, '落点码 10：得 50 点券', [X('0x4197e9'), R('docs/research/r_rules_map.md §11.4')]),
  POINTS_SQUARE_30: c(30, '落点码 11：得 30 点券', [X('0x4197e9'), R('docs/research/r_rules_map.md §11.4')]),
  POINTS_SQUARE_10: c(10, '落点码 12：得 10 点券', [X('0x4197e9'), R('docs/research/r_rules_map.md §11.4')]),
  /** 宝箱 */
  CHEST_POINTS: c(500, '停在宝箱上得 500 点券', [X('0x41bcb6'), R('docs/research/g_arbitration.md §2.l')]),
  /** 乞丐施舍 = 1000 × PI */
  BEGGAR_ALMS: c(1000, '停在别人的乞丐上施舍 1000×PI 进公库', [R('docs/research/r_rules_map.md §9')]),
  /** 贷款期限（天） */
  LOAN_DAYS: c(90, '到期日遇休市顺延', [R('docs/research/r_rules_map.md §8'), V('extract:constants.loanDays')]),
  /** 月息 = 存款 / 10（无贷款者） */
  INTEREST_DIV: c(10, '每月 1 日存款 ×1.1（向零取整）', [R('docs/research/r_rules_map.md §7')]),
  /** 保释他人（点券） */
  BAIL_POINTS: c(30, '监狱 / 医院格保释他人', [R('docs/research/r_rules_map.md §10'), V('extract:constants.bail')]),
  /** 雇用恶人（点券） */
  HIRE_POINTS: c(300, '放出恶人', [R('docs/research/r_rules_map.md §10'), V('extract:constants.hire')]),
  /** 乐透每注金额与号码数 */
  LOTTERY_TICKET: c(1000, '每注 1000 元', [R('docs/research/r_rules_map.md §7'), V('extract:constants.lotteryTicket')]),
  LOTTERY_NUMBERS: c(36, '36 个号码', [R('docs/design/engine.md §4'), V('extract:constants.lotteryNumbers')]),
  /** 免费卡询问门槛 = 2000 × PI */
  FREE_CARD_THRESHOLD: c(2000, '过路费 ≥ 2000×PI 或付不起时询问免费卡', [
    X('0x419e34'),
    R('docs/research/r_rules_map.md §8'),
  ]),
  /** 定时炸弹引信（步） */
  BOMB_FUSE: c(38, '拾取后 38 步爆炸', [R('docs/research/g_arbitration.md §2.e'), V('extract:constants.bombFuse')]),
  /** 机器娃娃步数 */
  DOLL_STEPS: c(9, '沿前进方向走 9 步', [R('docs/design/engine.md §1 #14'), V('extract:constants.dollSteps')]),
  /** 飞弹 / 核弹方窗半宽（世界坐标） */
  MISSILE_HALF: c(100, '飞弹半宽 100', [R('docs/design/engine.md §10.4'), V('extract:constants.missileHalf')]),
  NUKE_HALF: c(220, '核弹半宽 220', [R('docs/design/engine.md §10.4'), V('extract:constants.nukeHalf')]),
  /** 神明重生与参照点在 X 或 Y 方向上的最小距离 */
  RESPAWN_DIST: c(300, '神明搭档重生距离（DEV-08：64 次后放宽）', [R('docs/design/engine.md §10.5')], 'medium'),
  /** 恶人步数 = rand15() % 9 + 2 */
  VILLAIN_STEPS_MIN: c(2, '恶人步数下限', [X('0x40dd1f'), R('docs/design/engine.md §7.8')]),
  VILLAIN_STEPS_RANGE: c(9, '恶人步数 rand%9', [X('0x40dd1f'), R('docs/design/engine.md §7.8')]),
  /** 小游戏不玩分支：50 + rand15() % 20 */
  MINIGAME_SKIP_BASE: c(50, '不玩分支底分', [X('0x415457'), R('docs/design/minigames-ai.md §2.1')]),
  MINIGAME_SKIP_RANGE: c(20, '不玩分支 rand%20', [X('0x415457'), R('docs/design/minigames-ai.md §2.1')]),
  /** 每支股票的总股本 */
  STOCK_TOTAL_SHARES: c(10000, 'Σ持股 + 流通 + 公司保留 = 10000', [R('docs/design/engine.md §5')], 'medium'),
  /** 每回合可买量：float ≤ 1000 时为 float，否则 floor(float × (1000 + rand%2000) / 10000) */
  QUOTA_FLOAT_MIN: c(1000, '流通股 ≤ 1000 时全部可买', [X('0x42915a'), R('docs/design/engine.md §7.2')]),
  QUOTA_BASE: c(1000, '可买量系数下限（千分比）', [X('0x42915a'), R('docs/design/engine.md §7.2')]),
  QUOTA_RANGE: c(2000, '可买量系数 rand%2000', [X('0x42915a'), R('docs/design/engine.md §7.2')]),
  QUOTA_DEN: c(10000, '可买量系数分母', [X('0x42915a'), R('docs/design/engine.md §7.2')]),
  /** 神明持续天数 */
  GOD_DAYS: c(7, '附身当回合 + 之后 6 个回合', [R('docs/research/g_arbitration.md §3.3')]),
  DEATH_GOD_DAYS: c(13, '死神 13 天', [R('docs/research/g_arbitration.md §2.k')]),
  /** 冬眠、涨价 / 查封、同盟、工程车 */
  HIBERNATE_DAYS: c(5, '冬眠跳过 5 个回合', [R('docs/research/g_arbitration.md §3.3')]),
  MARK_DAYS: c(5, '涨价卡、查封卡 5 天', [R('docs/research/r_rules_map.md §10')]),
  ALLIANCE_DAYS: c(7, '同盟 7 天', [R('docs/research/g_arbitration.md §3.3')]),
  ENGINEER_TURNS: c(7, '工程车持续 7 个自己的回合', [R('docs/research/g_arbitration.md §2.d')], 'medium'),
  /** 两段式计数器：0x80 = 待释放，低 7 位 = 天数 */
  COUNTER_PENDING: c(0x80, '减到 0 时写 0x80，下一回合释放', [X('0x41c84f'), R('docs/research/g_arbitration.md §3.2')]),
  COUNTER_MASK: c(0x7f, '重复入狱：(旧值 + 新天数) & 0x7f', [X('0x41c84f'), R('docs/research/g_arbitration.md §3.3')]),
  /** 电脑买地保留额：min(trunc(开局资金 × 5%), 7000) × PI */
  AI_BUY_RESERVE_PCT: c(5, '电脑买地时现金+存款−价格须大于保留额', [
    X('0x41d7d4'),
    R('docs/design/minigames-ai.md §9.7'),
  ]),
  AI_BUY_RESERVE_CAP: c(7000, '电脑买地保留额上限（乘 PI 前）', [X('0x41d7d4'), R('docs/design/minigames-ai.md §9.7')]),
} as const);

export type EconKey = keyof typeof ECONOMY;

function valuesOf<T extends Record<string, EconConst>>(t: T): { readonly [K in keyof T]: number } {
  const out: Record<string, number> = {};
  for (const k of Object.keys(t).sort()) out[k] = t[k]!.value;
  return Object.freeze(out) as { readonly [K in keyof T]: number };
}

/** 数值视图：ECON.CHAIN_TOLL === 2000 */
export const ECON = valuesOf(ECONOMY);
