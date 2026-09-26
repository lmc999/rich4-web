/**
 * 数据表与引擎共用的领域枚举（architecture §4「ID」、design/engine.md §3、§10）。
 * data 不能依赖 engine（architecture §3），所以这些枚举放在这里，由 engine/types/ids.ts 原样再导出。
 * 数值 id 一律沿用原版编号：卡片 1..30、道具 1..13、角色 0..11、神明 1..12 与 15、新闻 0..35、命运 0..36。
 * 字符串 key（CARD_KEYS 等）是 camelCase，供数据表与 i18n 拼接文案 key 使用。
 */
import type { TileKind } from '../maps/types';

/** 生成 [0, N) 的整数字面量联合 */
type Enumerate<N extends number, Acc extends number[] = []> = Acc['length'] extends N
  ? Acc[number]
  : Enumerate<N, [...Acc, Acc['length']]>;

/** [From, To] 闭区间的整数字面量联合（From ≤ To ≤ 64） */
export type IntRange<From extends number, To extends number> = Exclude<Enumerate<To>, Enumerate<From>> | To;

function range<T extends number>(from: number, to: number): readonly T[] {
  const out: T[] = [];
  for (let i = from; i <= to; i++) out.push(i as T);
  return Object.freeze(out);
}

// ───────────────────────── 卡片（30 张，@source docs/research/g_arbitration.md §1） ─────────────────────────

export type CardId = IntRange<1, 30>;

export const CARD = {
  EQUAL_WEALTH: 1, // 均富
  EQUAL_POVERTY: 2, // 均贫
  BUY_LAND: 3, // 购地
  SWAP_LAND: 4, // 换地
  SWAP_HOUSE: 5, // 换屋
  TURN_AROUND: 6, // 转向
  REBUILD: 7, // 改建
  AUCTION: 8, // 拍卖
  ANGEL: 9, // 天使
  DEVIL: 10, // 恶魔
  MONSTER: 11, // 怪兽
  DEMOLISH: 12, // 拆除
  ROB: 13, // 抢夺
  STAY: 14, // 停留
  HIBERNATE: 15, // 冬眠
  SLEEPWALK: 16, // 梦游
  FRAME: 17, // 陷害
  REVENGE: 18, // 复仇（被动）
  SCAPEGOAT: 19, // 嫁祸（被动）
  FREE: 20, // 免费（被动）
  PARDON: 21, // 免罪（被动）
  DISPEL_GOD: 22, // 送神符
  SUMMON_GOD: 23, // 请神符
  RED: 24, // 红卡
  BLACK: 25, // 黑卡
  TAX_AUDIT: 26, // 查税
  RAISE_PRICE: 27, // 涨价
  SEAL: 28, // 查封
  ALLIANCE: 29, // 同盟
  TORTOISE: 30, // 乌龟
} as const satisfies Record<string, CardId>;

export const CARD_IDS: readonly CardId[] = range<CardId>(1, 30);

export const CARD_KEYS = {
  1: 'equalWealth',
  2: 'equalPoverty',
  3: 'buyLand',
  4: 'swapLand',
  5: 'swapHouse',
  6: 'turnAround',
  7: 'rebuild',
  8: 'auction',
  9: 'angel',
  10: 'devil',
  11: 'monster',
  12: 'demolish',
  13: 'rob',
  14: 'stay',
  15: 'hibernate',
  16: 'sleepwalk',
  17: 'frame',
  18: 'revenge',
  19: 'scapegoat',
  20: 'free',
  21: 'pardon',
  22: 'dispelGod',
  23: 'summonGod',
  24: 'redCard',
  25: 'blackCard',
  26: 'taxAudit',
  27: 'raisePrice',
  28: 'seal',
  29: 'alliance',
  30: 'tortoise',
} as const satisfies { readonly [C in CardId]: string };

/** 被动卡：不能主动打出，只在触发点自动生效或询问（design/engine.md §10.3） */
export const PASSIVE_CARD_IDS: readonly CardId[] = Object.freeze([
  CARD.REVENGE,
  CARD.SCAPEGOAT,
  CARD.FREE,
  CARD.PARDON,
] as CardId[]);

export function isPassiveCard(card: CardId): boolean {
  return card >= CARD.REVENGE && card <= CARD.PARDON;
}

// ───────────────────────── 道具（13 种） ─────────────────────────

export type ItemId = IntRange<1, 13>;

export const ITEM = {
  ROBOT_DOLL: 1, // 机器娃娃
  ROADBLOCK: 2, // 路障
  MINE: 3, // 地雷
  TIME_BOMB: 4, // 定时炸弹
  MOTORCYCLE: 5, // 机车
  CAR: 6, // 汽车
  MISSILE: 7, // 飞弹
  REMOTE_DICE: 8, // 遥控骰子
  ROBOT_WORKER: 9, // 机器工人（研究所 1 级）
  TIME_MACHINE: 10, // 时光机（研究所 2 级）
  TELEPORTER: 11, // 传送机（研究所 3 级）
  ENGINEERING_VEHICLE: 12, // 工程车（研究所 4 级）
  NUKE: 13, // 核子飞弹（研究所 5 级）
} as const satisfies Record<string, ItemId>;

export const ITEM_IDS: readonly ItemId[] = range<ItemId>(1, 13);

export const ITEM_KEYS = {
  1: 'robotDoll',
  2: 'roadblock',
  3: 'mine',
  4: 'timeBomb',
  5: 'motorcycle',
  6: 'car',
  7: 'missile',
  8: 'remoteDice',
  9: 'robotWorker',
  10: 'timeMachine',
  11: 'teleporter',
  12: 'engineeringVehicle',
  13: 'nuke',
} as const satisfies { readonly [I in ItemId]: string };

/** 1..8：共享库存（各 10 个），商店有售 */
export const POOL_ITEM_IDS: readonly ItemId[] = range<ItemId>(1, 8);
/** 9..13：只能由研究所产出，商店不卖；卖出后直接消失 */
export const RESEARCH_ITEM_IDS: readonly ItemId[] = range<ItemId>(9, 13);

export function isPoolItem(item: ItemId): boolean {
  return item <= 8;
}

/** 研究所研发项目 1..5（项目 p 产出道具 8+p，需要研究所等级 ≥ p） */
export type ResearchProject = IntRange<1, 5>;

export function researchItemOf(project: ResearchProject): ItemId {
  return (8 + project) as ItemId;
}

// ───────────────────────── 角色（12 名，原版编号 0..11） ─────────────────────────

export type CharacterId = IntRange<0, 11>;

export const CHARACTER = {
  JOHN_JOE: 0, // 约翰乔
  SHALONBASI: 1, // 沙隆巴斯
  SHINTARO: 2, // 忍太郎
  MADAM_QIAN: 3, // 钱夫人
  ATUBO: 4, // 阿土伯
  PRINCESS_SARAH: 5, // 莎拉公主
  MIYAMOTO: 6, // 宫本宝藏
  TANGTANG: 7, // 糖糖
  WUMI: 8, // 乌咪
  SUN_XIAOMEI: 9, // 孙小美
  DANNY: 10, // 小丹尼
  JIN_BEIBEI: 11, // 金贝贝
} as const satisfies Record<string, CharacterId>;

export const CHARACTER_IDS: readonly CharacterId[] = range<CharacterId>(0, 11);

/** i18n key（characters.original.json / characters.alt.json 的键） */
export const CHARACTER_KEYS = {
  0: 'johnJoe',
  1: 'shalonbasi',
  2: 'shintaro',
  3: 'madamQian',
  4: 'atubo',
  5: 'princessSarah',
  6: 'miyamoto',
  7: 'tangtang',
  8: 'wumi',
  9: 'sunXiaomei',
  10: 'danny',
  11: 'jinBeibei',
} as const satisfies { readonly [C in CharacterId]: string };

// ───────────────────────── 神明（种类号沿用原版物件表；死神 15） ─────────────────────────

export type GodKind = IntRange<1, 12> | 15;

export const GOD = {
  SMALL_WEALTH: 1, // 小财神
  BIG_WEALTH: 2, // 大财神
  SMALL_FORTUNE: 3, // 小福神
  BIG_FORTUNE: 4, // 大福神
  SMALL_POOR: 5, // 小穷神
  BIG_POOR: 6, // 大穷神
  SMALL_MISFORTUNE: 7, // 小衰神
  BIG_MISFORTUNE: 8, // 大衰神
  ANGEL: 9, // 天使
  DEVIL: 10, // 恶魔
  DOG: 11, // 恶犬（不附身）
  EARTH_GOD: 12, // 土地公
  DEATH: 15, // 死神
} as const satisfies Record<string, GodKind>;

export const GOD_KINDS: readonly GodKind[] = Object.freeze([...range<GodKind>(1, 12), GOD.DEATH]);

export const GOD_KEYS = {
  1: 'smallWealth',
  2: 'bigWealth',
  3: 'smallFortune',
  4: 'bigFortune',
  5: 'smallPoor',
  6: 'bigPoor',
  7: 'smallMisfortune',
  8: 'bigMisfortune',
  9: 'angel',
  10: 'devil',
  11: 'dog',
  12: 'earthGod',
  15: 'death',
} as const satisfies { readonly [G in GodKind]: string };

// ───────────────────────── 四大恶人（原版演员号 4..7） ─────────────────────────

export type VillainKind = 'thief' | 'robber' | 'thug' | 'spy';

/** 固定顺序，也是 state.villains 的顺序：小偷、强盗、流氓、间谍 */
export const VILLAIN_KINDS: readonly VillainKind[] = Object.freeze(['thief', 'robber', 'thug', 'spy'] as const);

/** 家：小偷、强盗在监狱，流氓、间谍在医院（design/engine.md §5 步骤 4） */
export const VILLAIN_HOME = {
  thief: 'jail',
  robber: 'jail',
  thug: 'hospital',
  spy: 'hospital',
} as const satisfies { readonly [V in VillainKind]: 'jail' | 'hospital' };

// ───────────────────────── 设施类型（原版编码 0..4） ─────────────────────────

/** 下标即原版编码：0 公园、1 旅馆、2 购物中心、3 加油站、4 研究所（@source docs/research/r_property.md §数据结构） */
export type FacilityType = 'park' | 'hotel' | 'mall' | 'gas' | 'lab';

export const FACILITY_TYPES: readonly FacilityType[] = Object.freeze(['park', 'hotel', 'mall', 'gas', 'lab'] as const);

// ───────────────────────── 交通工具与开局选项（开局表的档位，默认值见 engine/types/config.ts） ─────────────────────────

/** 当前交通工具；engineer = 工程车（持续 7 个自己的回合） */
export type Vehicle = 'walk' | 'moto' | 'car' | 'engineer';
/** 开局可选的交通工具 */
export type StartVehicle = Exclude<Vehicle, 'engineer'>;
export const START_VEHICLES: readonly StartVehicle[] = Object.freeze(['walk', 'moto', 'car'] as const);

/** 总资金档位（原版开局表，@source docs/research/g_arbitration.md §2.h） */
export type InitialFund = 300000 | 200000 | 100000 | 50000 | 30000 | 10000;
export const INITIAL_FUND_OPTIONS: readonly InitialFund[] = Object.freeze([
  300000, 200000, 100000, 50000, 30000, 10000,
] as const);

/** 地契期限 */
export type Tenure = 'unlimited' | '2y' | '1y' | '6m' | '3m' | '1m';
export const TENURE_OPTIONS: readonly Tenure[] = Object.freeze(['unlimited', '2y', '1y', '6m', '3m', '1m'] as const);

/** 游戏时间（天）；0 = 无限 */
export type TimeLimitDays = 0 | 730 | 365 | 182 | 91 | 30;
export const TIME_LIMIT_OPTIONS: readonly TimeLimitDays[] = Object.freeze([0, 730, 365, 182, 91, 30] as const);

/** 胜利条件：资产达到总资金的倍数；0 = 无 */
export type WinMultiple = 0 | 100 | 50 | 10 | 5 | 3;
export const WIN_MULTIPLE_OPTIONS: readonly WinMultiple[] = Object.freeze([0, 100, 50, 10, 5, 3] as const);

// ───────────────────────── 新闻、命运、魔法屋 ─────────────────────────

export const NEWS_COUNT = 36;
export const FATE_COUNT = 37;
export const MAGIC_CONDITION_COUNT = 12;
export const MAGIC_EFFECT_COUNT = 12;

/** 新闻 0..35（design/engine.md §10.6） */
export type NewsId = IntRange<0, 35>;
/** 命运 0..36（design/engine.md §10.7） */
export type FateId = IntRange<0, 36>;
/** 魔法屋条件 0..11（design/engine.md §10.8） */
export type MagicConditionId = IntRange<0, 11>;
/** 魔法屋效果 0..11（design/engine.md §10.8） */
export type MagicEffectId = IntRange<0, 11>;

export const NEWS_IDS: readonly NewsId[] = range<NewsId>(0, NEWS_COUNT - 1);
export const FATE_IDS: readonly FateId[] = range<FateId>(0, FATE_COUNT - 1);

export const MAGIC_CONDITION = {
  RICHEST: 0, // 财产最多（并列都算）
  MOST_LOTS: 1, // 地产最多（0 不参选）
  MOST_HOUSES: 2, // 房屋最多
  MOST_CASH: 3, // 现金最多
  MOST_DEPOSIT: 4, // 存款最多
  MOST_POINTS: 5, // 点券最多
  WALKING: 6, // 步行
  RIDING_MOTO: 7, // 骑机车
  DRIVING_CAR: 8, // 开汽车
  GOD_ATTACHED: 9, // 神明附身
  MALE: 10, // 男生
  FEMALE: 11, // 女生
} as const satisfies Record<string, MagicConditionId>;

export const MAGIC_EFFECT = {
  SELL_CARDS: 0, // 卖掉所有卡，按原价折成点券 ⚑
  FATE_X3: 1, // 连抽 3 次命运
  JAIL: 2, // 坐牢 3 天
  STAY: 3, // 停留 1 次
  DEPOSIT_ALL: 4, // 现金全部存入存款
  LEVEL_UP: 5, // 脚下地产 +1 级
  GAIN_CARD: 6, // 得 1 张卡
  TURN_AROUND: 7, // 转向
  SELL_ITEMS: 8, // 卖掉所有道具（含交通工具）
  LEVEL_DOWN: 9, // 脚下地产 −1 级
  HOSPITAL: 10, // 住院 3 天
  AUCTION: 11, // 拍卖脚下地产 ⚑
} as const satisfies Record<string, MagicEffectId>;

export const MAGIC_CONDITION_IDS: readonly MagicConditionId[] = range<MagicConditionId>(0, 11);
export const MAGIC_EFFECT_IDS: readonly MagicEffectId[] = range<MagicEffectId>(0, 11);

// ───────────────────────── 小游戏 ─────────────────────────

/**
 * 企鹅挖宝（落点码 6）/ 七彩气球（7）/ 喜从天降（8）。
 * shared/minigames 只能依赖 util，因此 minigames/types.ts 另有一份同值声明，由类型测试保证两者一致。
 */
export type MinigameId = Extract<TileKind, 'penguin' | 'balloon' | 'xicong'>;
export const MINIGAME_IDS: readonly MinigameId[] = Object.freeze(['penguin', 'balloon', 'xicong'] as const);

/** 小游戏规则参数（预留 'exe206'，若核实后 v2.06 有差异） */
export interface MinigameParams {
  ruleset: 'exe311';
}

// ───────────────────────── AI 特质（resolveTraits 在 data/tables/characters.ts） ─────────────────────────

/** 个性：0 乖宝宝、1 普通人、2 大老奸 */
export type Personality = 0 | 1 | 2;

/** 对应原版玩家结构 +0x16..+0x1a；比例为 0..100 的整数 */
export interface AiTraits {
  personality: Personality;
  useCards: boolean;
  useItems: boolean;
  loanRatio: number;
  cashRatio: number;
  stockRatio: number;
}

/** UI 标签：按角色（原版）/ 乖宝宝·简单 / 普通人·普通 / 大老奸·困难 */
export type AiPreset = 'character' | 'gentle' | 'normal' | 'cunning';
export const AI_PRESETS: readonly AiPreset[] = Object.freeze(['character', 'gentle', 'normal', 'cunning'] as const);

/** 预设只覆盖 personality（character 表示沿用角色表） */
export const AI_PRESET_PERSONALITY = {
  character: null,
  gentle: 0,
  normal: 1,
  cunning: 2,
} as const satisfies { readonly [P in AiPreset]: Personality | null };

/** 座位的电脑配置：预设 + 可选的逐项覆盖 */
export interface SeatAiConfig {
  preset: AiPreset;
  overrides?: Partial<AiTraits>;
}
