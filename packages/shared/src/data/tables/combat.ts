/**
 * 对抗系统的常数（卡片、道具、神明、关押；design/engine.md §10.2–§10.5、§10.11；docs/research/g_arbitration.md §2–§3；
 * r_cards.md §5、§8–§10；r_items.md §5；g_villains.md §5–§6）。引擎代码通过 CMB.xxx 取值。
 * 物件引信、娃娃步数、飞弹半宽等与 exe 锚点核对过的常数仍在 economy.ts（ECON.BOMB_FUSE 等）。
 * 证据缺失、先按默认值实现的条目在 note 里标 ⚑（DEV-12）。
 */
import type { Sourced, Src } from '../source';

export interface CombatConst extends Sourced {
  value: number;
  note: string;
}

const R = (research: string): Src => ({ research });
const X = (va: string): Src => ({ exe: '3.11', va });
const U = (url: string): Src => ({ url });

function c(value: number, note: string, src: Src[], confidence: Sourced['confidence'] = 'high'): CombatConst {
  return Object.freeze({ value, note, src, confidence });
}

const CARDS5 = R('docs/research/r_cards.md §5');
const CARDS10 = R('docs/research/r_cards.md §10');
const GA3 = R('docs/research/g_arbitration.md §3.3');

export const COMBAT = Object.freeze({
  // ───────────── 关押与状态天数（两段式计数器写入值） ─────────────
  /** 陷害卡：他人 5 天；被嫁祸回出卡者 4 天 */
  FRAME_DAYS: c(5, '陷害他人写 5', [X('0x44476a'), GA3, CARDS5]),
  FRAME_SELF_DAYS: c(4, '最终目标 == 出卡者时写 4', [X('0x44476a'), R('docs/research/g_arbitration.md §3.4')]),
  /** 梦游卡：他人 5 天；被嫁祸回出卡者 4 天 */
  SLEEPWALK_DAYS: c(5, '梦游他人写 5', [X('0x4442f2'), GA3, CARDS5]),
  SLEEPWALK_SELF_DAYS: c(4, '最终目标 == 出卡者时写 4', [X('0x4442f2'), R('docs/research/g_arbitration.md §3.4')]),
  /** 复仇卡：出卡者受同样的罪 5 天 */
  REVENGE_DAYS: c(5, '复仇反弹 5 天（直接施加，不再查出卡者的被动卡 ⚑）', [CARDS5], 'medium'),
  /** 停留卡：对自己写 0x80（本回合），对别人写 1（下回合） */
  STAY_SELF: c(0x80, '停留卡对自己', [
    U('https://github.com/mytbk/rich4/blob/master/asm/rich4_card_tingliuka.asm'),
    R('docs/research/g_arbitration.md §3-3'),
  ]),
  STAY_OTHER: c(1, '停留卡对别人（含恶人）', [
    U('https://github.com/mytbk/rich4/blob/master/asm/rich4_card_tingliuka.asm'),
    R('docs/research/g_arbitration.md §3-3'),
  ]),
  /** 乌龟卡：对自己 2，对别人 3 */
  TORTOISE_SELF: c(2, '乌龟卡对自己', [
    U('https://github.com/mytbk/rich4/blob/master/asm/rich4_card_wuguika.asm'),
    R('docs/research/g_arbitration.md §3-3'),
  ]),
  TORTOISE_OTHER: c(3, '乌龟卡对别人（含恶人）', [
    U('https://github.com/mytbk/rich4/blob/master/asm/rich4_card_wuguika.asm'),
    R('docs/research/g_arbitration.md §3-3'),
  ]),
  /** 地雷、恶犬、飞弹、核弹住院 3 天；身上的定时炸弹爆炸住院 5 天 */
  MINE_HOSPITAL_DAYS: c(3, '踩中地雷住院 3 天', [X('0x41be5f'), R('docs/research/r_items.md §5.3')]),
  DOG_HOSPITAL_DAYS: c(3, '步行被恶犬咬住院 3 天', [R('docs/research/r_deities.md §7.12')]),
  STRIKE_HOSPITAL_DAYS: c(3, '飞弹、核弹住院 3 天（说明书 5 天，exe push 3）', [
    R('docs/research/r_items.md §5.6'),
    R('docs/design/engine.md §1 #2'),
  ]),
  BOMB_HOSPITAL_DAYS: c(5, '定时炸弹爆炸住院 5 天', [X('0x41b697'), R('docs/research/g_arbitration.md §2.e')]),

  // ───────────── 敌意（被害者对出卡者，AI 用；对盟友产生正敌意即解除同盟） ─────────────
  HATE_HARM_PI: c(150, '陷害、梦游、冬眠：150 × PI', [CARDS10]),
  HATE_DEMOLISH_PI: c(30, '拆除卡、工程车、恶魔显灵、飞弹炸到地主：30 × PI', [
    CARDS10,
    R('docs/research/g_arbitration.md §2.d'),
  ]),
  HATE_LEVEL_PI: c(30, '恶魔卡、怪兽卡：每级 30 × PI', [CARDS10]),
  HATE_STRIKE_VICTIM_PI: c(90, '被飞弹、核弹炸到的人：90 × PI', [R('docs/design/engine.md §10.4')], 'medium'),
  HATE_CASH_DIV: c(100, '均富 / 均贫：(现金 − 平均) / 100；查税：税额 / 100', [CARDS10]),
  HATE_BUY_LAND_DIV: c(5, '购地卡：地价 × PI × (等级 + 2) / 5', [CARDS10]),
  ALLIANCE_DECAY_PI: c(20, '同盟期间每个自己的回合双方敌意各 −20 × PI（不低于 0 ⚑）', [
    R('docs/research/r_cards.md §9'),
  ]),

  // ───────────── 卡片数值 ─────────────
  /** 查税 = trunc(现金 / 5)（20%） */
  TAX_AUDIT_DIV: c(5, '查税：现金 × 20%（向零取整）', [CARDS5]),
  /** 红卡、黑卡：PROGRAM 写 0x20 / 0x02（当天 + 下一天），MANUAL 3 天且红黑互相抵消 */
  RED_BLACK_DAYS: c(2, '走势字节半字节 2：当天立即 ±10%，下一个自然日再 ±10%', [
    R('docs/research/g_arbitration.md §2.a'),
    R('docs/research/r_stocks_time.md §4.5'),
  ]),
  RED_BLACK_MANUAL_DAYS: c(
    3,
    'MANUAL：说明书「涨停板三天」（按自然日倒数 ⚑）',
    [R('docs/research/r_cards.md §7')],
    'low',
  ),

  // ───────────── 道具与物件 ─────────────
  /** 神明、乞丐重生：随机抽格，|dx| ≥ 300 或 |dy| ≥ 300 才接受；64 次后放宽（DEV-08） */
  RESPAWN_TRIES: c(64, '神明搭档、乞丐换位的抽格次数上限，之后不看距离（DEV-08）', [
    R('docs/architecture.md §7.3 DEV-08'),
  ]),
  /** 每月 1 日礼物、宝箱各重新摆放 1 个 */
  MONTHLY_GIFTS: c(1, '每月 1 日礼物重新摆放的个数', [R('docs/design/engine.md §10.11')], 'medium'),
  MONTHLY_CHESTS: c(1, '每月 1 日宝箱重新摆放的个数', [R('docs/design/engine.md §10.11')], 'medium'),
  /** 地图上路障、地雷、定时炸弹各最多 10 个（与道具池共同保证） */
  OBJECT_KIND_MAX: c(10, '路障、地雷、定时炸弹的地图上限', [R('docs/research/r_items.md §2')]),
  /** 交通工具退回背包时可以达到第 10 台（原版可达到的特例） */
  VEHICLE_BAG_MAX: c(10, '机车、汽车退回背包时的上限', [R('docs/research/r_items.md §2')]),
  /** 工程车在加油站的收费倍率、骰子数见 facilities / setup；持续回合数见 ECON.ENGINEER_TURNS */
  BLESS_HIGH: c(100, '加持：值 > 100 必定 high', [X('0x44b896'), R('docs/research/g_arbitration.md §2.b')]),
  BLESS_MID: c(50, '加持：50 < 值 ≤ 100 时 rand & 1', [X('0x44b896'), R('docs/research/g_arbitration.md §2.b')]),

  // ───────────── M7：四大恶人、拍卖、投降、公布栏 ─────────────
  /** 强盗路过银行：每位非雇主在场玩家 trunc(存款 × 0.2)（先存款后现金，进雇主现金） */
  ROBBER_BANK_RATE: c(0.2, '强盗抢银行比例（常量 0x463b60 = 0.2；社区 50% 不采用）', [
    X('0x463b60'),
    R('docs/research/g_villains.md §3、§7.2'),
  ]),
  /** 小偷拿走宝箱：雇主点券 +500 */
  THIEF_CHEST_POINTS: c(500, '小偷拿走宝箱，雇主点券 +500', [R('docs/research/g_villains.md §3')]),
  /** 拍卖加价的最小一档（出价档 0/100/500/1000/5000/10000） */
  AUCTION_MIN_INC: c(100, '加价最小一档 100', [
    R('docs/research/g_arbitration.md §2.j'),
    R('docs/design/engine.md §9.5'),
  ]),
  /** 破产 / 投降清算：释放的地产 > 3 处时随机抽 3 处拍卖（成交款进公库） */
  LIQUIDATION_AUCTIONS: c(3, '清算拍卖场数（释放 > 3 处才拍）', [R('docs/research/r_property.md §9.4')]),
  /** 投降召唤死神：真人 ≥ 2、参赛 ≥ 3（投降后仍 ≥ 2 人） */
  SURRENDER_MIN_HUMANS: c(2, '投降需要至少 2 名在场真人', [R('docs/research/r_deities.md §7.13')], 'medium'),
  SURRENDER_MIN_PLAYERS: c(3, '投降需要至少 3 名在场玩家', [R('docs/research/r_deities.md §7.13')], 'medium'),
  /** 公布栏：每人 7 个挂牌槽；地产标价上限 = 市价 × 10（市价 = (地价 + 等级 × 房价) × PI） */
  BOARD_SLOTS: c(7, '公布栏每人 7 个挂牌槽', [R('docs/research/r_property.md §9.3')], 'medium'),
  BOARD_LOT_CAP_X: c(10, '地产挂牌标价上限 = 市价 × 10', [R('docs/research/r_property.md §9.3')], 'medium'),
} as const);

export type CombatKey = keyof typeof COMBAT;

function valuesOf<T extends Record<string, CombatConst>>(t: T): { readonly [K in keyof T]: number } {
  const out: Record<string, number> = {};
  for (const k of Object.keys(t).sort()) out[k] = t[k]!.value;
  return Object.freeze(out) as { readonly [K in keyof T]: number };
}

/** 数值视图：CMB.FRAME_DAYS === 5 */
export const CMB = valuesOf(COMBAT);
