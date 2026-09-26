/**
 * 引擎的基础 id 与小型值类型（architecture §4「ID」、design/engine.md §3）。
 * 数据表共用的领域枚举定义在 data/tables/ids.ts，这里原样再导出。
 */
import type { CardId, GodKind, ItemId, MagicEffectId, VillainKind } from '../../data/tables/ids';

export type { LotId, TileId } from '../../data/maps/types';
export * from '../../data/tables/ids';

/** 座位 0..3，也是回合顺序（原版 1P→4P） */
export type SeatIndex = 0 | 1 | 2 | 3;
export const SEAT_INDEXES: readonly SeatIndex[] = Object.freeze([0, 1, 2, 3] as const);

export function isSeatIndex(x: unknown): x is SeatIndex {
  return x === 0 || x === 1 || x === 2 || x === 3;
}

/** 住宅地 / 设施 / 企业的 LotId 细分（与 MapDef 的 LotId 兼容） */
export type LandLotId = `L${number}`;
export type FacilityLotId = `F${number}`;
export type CompanyLotId = `C${number}`;

/** y*10000 + m*100 + d；0 表示「无」（例如无贷款、无限期地契） */
export type DateNum = number;

/** 地产等级；连锁店的等级 ≤ 1 */
export type LotLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type DiceFace = 1 | 2 | 3 | 4 | 5 | 6;
/** 骰子颗数：步行 1、机车 ≤2、汽车 ≤3、工程车 1 */
export type DiceCount = 1 | 2 | 3;

/** 座位由谁控制：只有开局 PlayerSetup 与 SYS_SET_CONTROLLER 能改（托管不改） */
export type Controller = 'human' | 'ai';

/** 棋盘上的演员：玩家或四大恶人 */
export type ActorRef = { t: 'seat'; seat: SeatIndex } | { t: 'villain'; kind: VillainKind };

/** 资金的一方：玩家、公司（盈余）、公库（乐透奖池）、银行（铸造 / 销毁，计入 ledger） */
export type Party =
  | { t: 'seat'; seat: SeatIndex }
  | { t: 'company'; company: CompanyLotId }
  | { t: 'pool' }
  | { t: 'bank' };

/** 付款原因（MONEY 事件与月度损益统计用） */
export type MoneyReason =
  | 'toll' // 住宅过路费
  | 'fee' // 设施费（旅馆、购物中心、加油站）
  | 'companyFee' // 企业格收费
  | 'buyLand' // 买地
  | 'buyFacility' // 买设施地
  | 'upgrade' // 加盖
  | 'buildFacility' // 设施首建
  | 'cardBuyLand' // 购地卡
  | 'equalize' // 均富、均贫卡
  | 'taxAudit' // 查税卡
  | 'tax' // 新闻：所得税、地价税、证交税
  | 'fine' // 命运、新闻罚款
  | 'reward' // 命运、新闻奖金
  | 'godPower' // 神明发威（老虎机）
  | 'beggar' // 施舍乞丐
  | 'villain' // 恶人收益、偷窃
  | 'loan' // 贷款放款
  | 'repay' // 还款
  | 'loanForced' // 到期强制还款
  | 'finance' // 特别融资
  | 'reserveShortfall' // 储备金缺口由董事长垫付
  | 'atm' // ATM 存取
  | 'interest' // 月息
  | 'dividend' // 分红
  | 'lotteryTicket' // 买乐透
  | 'lotteryPrize' // 乐透中奖
  | 'subscribe' // 现场认购股票
  | 'stock' // 股票买卖
  | 'board' // 公布栏成交
  | 'auction' // 拍卖成交
  | 'insurance' // 保险理赔
  | 'construction' // 建设公司代建
  | 'debug'; // SYS_DEBUG

/** 事件、关押、破产、地产变动的起因 */
export type CauseKind =
  | 'card'
  | 'item'
  | 'god'
  | 'object' // 地雷、地面炸弹、路障等路面物件
  | 'dog'
  | 'bomb' // 身上的定时炸弹爆炸
  | 'news'
  | 'fate'
  | 'magic'
  | 'villain'
  | 'toll'
  | 'fee'
  | 'tax'
  | 'loan'
  | 'dividend'
  | 'beggar'
  | 'hotel'
  | 'airline'
  | 'engineer' // 工程车拆房
  | 'surrender'
  | 'bankrupt'
  | 'debug'
  | 'system';

/** ref：卡号、道具号、神明种类、新闻号、命运号、魔法效果号、恶人种类或地块 id；by：责任座位（出卡者、雇主等） */
export interface Cause {
  k: CauseKind;
  ref: number | string | null;
  by: SeatIndex | null;
}

/** 常用 Cause 构造：{k:'card', ref: CardId, by} */
export type CardCause = Cause & { k: 'card'; ref: CardId };
export type ItemCause = Cause & { k: 'item'; ref: ItemId };
export type GodCause = Cause & { k: 'god'; ref: GodKind };
export type MagicCause = Cause & { k: 'magic'; ref: MagicEffectId };

/**
 * 引擎随机数的语义标签（design/engine.md §3 RNG）。
 * 每次取数都带 purpose；SYS_DEBUG forceNext 按 purpose 逐个出队替换语义结果。
 */
export type RandPurpose =
  | 'dice' // 掷骰：rand15()%6+1
  | 'fork' // 岔路：rand15()%候选数
  | 'reverse' // 转向后随机重设来路
  | 'parachute' // 首回合跳伞落点与来路
  | 'quota' // 股票每回合可买量
  | 'deck' // 按牌堆剩余张数加权抽卡
  | 'gift' // 礼物：按道具池加权
  | 'shelf' // 百货货架张数与抽卡
  | 'chairmanGift' // 百货董事长进店：卡或道具
  | 'wheel' // 转盘：旅馆、购物中心、航空、保险
  | 'slot' // 神明发威老虎机，每位 rand15()%10
  | 'place' // 开局与月初放置礼物、宝箱、神明
  | 'respawn' // 神明搭档重生
  | 'news' // 新闻牌序与新闻随机目标
  | 'fate' // 命运牌序与命运随机目标
  | 'bless' // 加持判定（50<值≤100 时 50%）
  | 'magicCond' // 魔法屋条件 rand15()%12
  | 'villainSteps' // 恶人步数 rand15()%9+2
  | 'steal' // 恶人、小衰神随机拿卡或丢卡
  | 'beggar' // 乞丐移到随机节点
  | 'lottery' // 乐透开奖号码
  | 'market' // 股市行情
  | 'minigameSeed' // 小游戏种子（写入 PendingDecision.minigame）
  | 'minigameSkip' // 不玩分支：50+rand15()%20 与台词槽 rand15()&1
  | 'birthday' // 电脑座位的「生日」随机拿卡
  | 'aiSeed'; // 开局派生 secret.aiSeed

export const RAND_PURPOSES: readonly RandPurpose[] = Object.freeze([
  'dice',
  'fork',
  'reverse',
  'parachute',
  'quota',
  'deck',
  'gift',
  'shelf',
  'chairmanGift',
  'wheel',
  'slot',
  'place',
  'respawn',
  'news',
  'fate',
  'bless',
  'magicCond',
  'villainSteps',
  'steal',
  'beggar',
  'lottery',
  'market',
  'minigameSeed',
  'minigameSkip',
  'birthday',
  'aiSeed',
] as const);

/** 卡片、道具、菜单项不可用的原因（i18n key 后缀） */
export type ReasonKey =
  | 'noTarget'
  | 'passive'
  | 'marketClosed'
  | 'suspended'
  | 'limitUp'
  | 'limitDown'
  | 'tortoise'
  | 'sleepwalk'
  | 'investBlocked'
  | 'notEnoughCash'
  | 'notEnoughPoints'
  | 'handFull'
  | 'itemFull'
  | 'poolEmpty'
  | 'noAnchor'
  | 'humanOnly'
  | 'alreadyEquipped'
  | 'nothingToDispel'
  | 'menuLimit'
  | 'notYourTurn';
