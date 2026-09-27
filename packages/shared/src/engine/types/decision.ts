/**
 * 决策模型（architecture §5.4 为唯一清单；options 结构见 design/engine.md §9.2–§9.3）。
 * 前端决策注册表与 AI 的 HANDLERS 都要用 satisfies 覆盖 DECISION_KINDS 全部 23 种。
 * 不存在：选岔路、选小游戏、遥控骰子对话框（它是 TURN_MENU 里道具的目标 {t:'dice'}）、转盘、老虎机。
 */
import type {
  ActorRef,
  CardId,
  CompanyLotId,
  DateNum,
  DiceCount,
  DiceFace,
  FacilityLotId,
  FacilityType,
  ItemId,
  LandLotId,
  LotId,
  LotLevel,
  MagicConditionId,
  MagicEffectId,
  MinigameId,
  MinigameParams,
  ReasonKey,
  ResearchProject,
  SeatIndex,
  TileId,
  VillainKind,
} from './ids';
import type { PlayerIntent } from './intent';
import type { ListingAsset, TurnLogEntry } from './state';

export const DECISION_KINDS = Object.freeze([
  'TURN_MENU',
  'BANK_ATM',
  'BANK_COUNTER',
  'BUY_LAND',
  'UPGRADE_LAND',
  'BUY_FACILITY',
  'BUILD_FACILITY',
  'UPGRADE_FACILITY',
  'FACILITY_TYPE',
  'RESEARCH',
  'SHOP',
  'LOTTERY',
  'BAIL',
  'MINIGAME',
  'MAGIC_CAST',
  'CONSTRUCTION_PICK',
  'SUBSCRIBE_SHARES',
  'USE_FREE_CARD',
  'SCAPEGOAT',
  'AUCTION_BID',
  'BIRTHDAY_PICK',
  'DISCARD_CARD',
  'DEATH_GOD_TARGET',
] as const);

/** 23 种决策 */
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** 计时类别：服务器按它查 DECISION_TIMEOUT_S（shared/net/timing.ts） */
export type DecisionTimingClass = 'menu' | 'confirm' | 'pick' | 'shop' | 'bank' | 'auction' | 'lottery' | 'minigame';

/** 每回合非终结 TURN_MENU 操作的上限，超出抛 EngineRuleError('MENU_LIMIT')（architecture §5.5 防刷） */
export const MENU_ACTION_LIMIT = 40;

// ───────────────────────── 目标候选（design/engine.md §9.3） ─────────────────────────

/** 传送机的被传送物 */
export type TeleportSource =
  | { k: 'actor'; actor: ActorRef }
  | { k: 'god'; slot: number }
  | { k: 'object'; object: number }
  | { k: 'house'; lot: LotId };

/** 传送机的目的地：空道路格或空地 */
export type TeleportDest = { k: 'road'; node: TileId } | { k: 'lot'; lot: LotId };

export interface RobVictim {
  seat: SeatIndex;
  cards: { slot: number; card: CardId }[];
  items: { item: ItemId; count: number }[];
}

/**
 * 卡片、道具的合法候选，全部由引擎计算（视窗半宽 windowHalf，以使用者棋子的世界坐标为中心）。
 * 客户端只负责高亮并提供 DOM 备用列表；对应的提交结构见 UseTarget。
 */
export type TargetCandidates =
  | { t: 'none' }
  /** 自动选择（请神符：视窗内最近的可附身神明） */
  | { t: 'auto' }
  | { t: 'seat'; seats: SeatIndex[] }
  | { t: 'actor'; actors: ActorRef[] }
  /** needType：0 级设施首建时需要在 UseTarget.facility 附带类型 */
  | { t: 'lot'; lots: LotId[]; needType: LotId[] }
  | { t: 'underfoot'; lot: LotId; types: FacilityType[] | null }
  | { t: 'lotPair'; from: LotId; to: LotId[] }
  | { t: 'lotOrObject'; lots: LotId[]; objects: number[] }
  | { t: 'stock'; stocks: number[] }
  | { t: 'node'; nodes: TileId[] }
  | { t: 'anyNode' }
  | { t: 'dice'; values: DiceFace[] }
  | { t: 'rob'; victims: RobVictim[] }
  | { t: 'teleport'; sources: TeleportSource[]; roads: TileId[]; lands: LotId[] };

// ───────────────────────── 各 kind 的 options ─────────────────────────

export interface TurnMenuCardRow {
  slot: number;
  card: CardId;
  usable: boolean;
  reason: ReasonKey | null;
  targets: TargetCandidates;
}

export interface TurnMenuItemRow {
  item: ItemId;
  count: number;
  usable: boolean;
  reason: ReasonKey | null;
  targets: TargetCandidates;
}

export interface StockRow {
  idx: number;
  priceCents: number;
  /** 涨跌幅 ×10（千分比），例如 +9.5% 为 95 */
  changePct10: number;
  quota: number;
  float: number;
  limitUp: boolean;
  limitDown: boolean;
  suspended: boolean;
  shares: number;
  costCents: number;
  maxBuy: number;
  maxSell: number;
  chairman: SeatIndex | null;
}

/** 公布栏挂牌的展示行 */
export interface ListingView {
  id: number;
  seller: SeatIndex;
  price: number;
  asset: ListingAsset;
  mine: boolean;
  affordable: boolean;
}

export interface TurnMenuOptions {
  dice: {
    allowed: DiceCount[];
    current: DiceCount;
    /** 不能掷骰选颗数的原因：停留 0 步、乌龟 1 步、梦游自动掷 */
    locked: null | 'stay' | 'tortoise' | 'sleepwalk';
  };
  cards: TurnMenuCardRow[];
  items: TurnMenuItemRow[];
  stock: {
    open: boolean;
    reason: null | 'sunday' | 'holiday' | 'halted';
    rows: StockRow[];
    deposit: number;
  };
  board: {
    listings: ListingView[];
    /** 本人已挂牌数 */
    mine: number;
    canList: boolean;
    /** 地产挂牌的估值上限（地块 → 金额） */
    lotCaps: { lot: LotId; cap: number }[];
  };
  canSurrender: boolean;
  timeMachine: { usable: boolean; anchorTurn: number | null };
  /** 本座位本回合已做的自由操作（AI PRE_ROLL 用） */
  turnLog: TurnLogEntry[];
  /** 本回合已用的非终结操作次数与上限 */
  menuActions: { used: number; limit: number };
}

export interface BankAtmOptions {
  mode: 'pass' | 'stop';
  cash: number;
  deposit: number;
  /** 挤兑期间为 false（只能存） */
  canWithdraw: boolean;
  /** 取款后若其他在场玩家存款合计低于银行董事长的融资余额，差额由他垫付；无则 null */
  reserveShortfallPayer: SeatIndex | null;
}

export interface BankCounterOptions {
  cash: number;
  deposit: number;
  loan: number;
  loanDue: DateNum;
  /** = netWorth − loan */
  loanLimit: number;
  loanBlocked: null | 'bankRun' | 'rejected' | 'sunday';
  /** 首次借款的到期日预览（90 天后，遇休市顺延） */
  dueDatePreview: DateNum;
  repayMax: number;
  /** 只有银行董事长才有：= 其他在场玩家存款和；否则 null */
  financeLimit: number | null;
  finance: number;
}

export interface StreetPreview {
  lots: LotId[];
  owners: (SeatIndex | null)[];
}

export interface BuyLandOptions {
  lot: LandLotId;
  price: number;
  cash: number;
  level: LotLevel;
  street: StreetPreview;
  /** 买下后本块的过路费预览 */
  tollAfter: number;
  /** 福神附身：买后多送 1 级 */
  fortuneBonus: boolean;
}

export interface UpgradeLandOptions {
  lot: LandLotId;
  cost: number;
  cash: number;
  fromLevel: LotLevel;
  /** 含福神加成 */
  toLevel: LotLevel;
  tollBefore: number;
  tollAfter: number;
}

export interface BuyFacilityOptions {
  lot: FacilityLotId;
  price: number;
  cash: number;
  level: LotLevel;
  type: FacilityType;
  fortuneBonus: boolean;
}

export interface FacilityTypeRow {
  type: FacilityType;
  /** 等级上限：公园 1、旅馆 5、购物中心 5、加油站 1、研究所 5 */
  cap: number;
  feePreview: number;
}

export interface BuildFacilityOptions {
  lot: FacilityLotId;
  cost: number;
  cash: number;
  types: FacilityTypeRow[];
}

export interface UpgradeFacilityOptions {
  lot: FacilityLotId;
  type: FacilityType;
  cost: number;
  cash: number;
  fromLevel: LotLevel;
  toLevel: LotLevel;
  cap: number;
}

/** 免费首建（天使卡、机器工人、魔法屋加盖、神明显灵）：只选类型，不付钱 */
export interface FacilityTypeOptions {
  lot: FacilityLotId;
  types: FacilityTypeRow[];
}

export interface ResearchOptions {
  lot: FacilityLotId;
  level: LotLevel;
  current: { project: ResearchProject; days: number } | null;
  /** 可选项目 1..level（研发一律 5 天、不收费，到期交付道具 8+project） */
  projects: { project: ResearchProject; item: ItemId; days: number }[];
}

/** 百货公司的一笔交易（SHOP_TRADE 事件与 ShopOptions.visit.trades 共用；points 为这笔花掉或得到的点券） */
export interface ShopTradeRecord {
  op: 'buyCard' | 'sellCard' | 'buyItem' | 'sellItem';
  card: CardId | null;
  item: ItemId | null;
  qty: number;
  points: number;
}

/** 每次进店的交易次数上限（防刷；到上限后只能 LEAVE） */
export const SHOP_TRADE_LIMIT = 60;

export interface ShopOptions {
  points: number;
  handCount: number;
  handMax: number;
  /**
   * 真人座位：本次货架（进店时 rand15()%10+6 张，按牌堆剩余张数加权、不放回；买走的从货架移除）；
   * 电脑座位（fullDeck=true）：牌堆里每种剩余的卡各一行。idx 即 SHOP_BUY_CARD.shelfIdx。
   * buyable=false：手牌已满、点券不足或牌堆里已没有这张。
   */
  shelf: { idx: number; card: CardId; price: number; buyable: boolean }[];
  fullDeck: boolean;
  /** 只卖道具 1..8；maxQty = min(库存, 9 − 持有, 点券 / 单价)，为 0 表示不能买 */
  items: { item: ItemId; price: number; pool: number; own: number; maxQty: number }[];
  /** value / unitValue 为卖回价 trunc(标价 × 数量 × 0.9) */
  sell: {
    cards: { slot: number; card: CardId; value: number }[];
    items: { item: ItemId; count: number; unitValue: number }[];
  };
  /** 本次进店：进店时的点券、已完成的交易、剩余可交易次数（AI 据此推算进度，客户端可忽略） */
  visit: { entryPoints: number; trades: ShopTradeRecord[]; remaining: number };
}

export interface LotteryOptions {
  cash: number;
  /** 每注 1000 元（不乘 PI，只用现金，进公库） */
  price: number;
  /** 36 个号码的持有者（下标 0 = 显示的 1 号）；LOTTERY_BUY.number 用下标 */
  sold: (SeatIndex | null)[];
  pool: number;
}

export interface BailOptions {
  where: 'jail' | 'hospital';
  points: number;
  inmates: { seat: SeatIndex; remaining: number }[];
  villains: { kind: VillainKind; available: boolean }[];
  costs: { bail: number; hire: number };
}

export interface MinigameOptions {
  minigameId: MinigameId;
  /** 规则上限（企鹅 188）；无固定上限时为 null */
  maxScore: number | null;
}

export interface MagicCastOptions {
  condition: MagicConditionId;
  targets: SeatIndex[];
  effects: MagicEffectId[];
}

export interface ConstructionPickOptions {
  company: CompanyLotId;
  /** 停留者是本公司董事长：免费加盖 levels 级 */
  chairman: boolean;
  /** 本次加盖的级数：非董事长 1，董事长 = rules.constructionChairmanLevels（到 5 级或上限即止） */
  levels: number;
  /**
   * 可选目标：自己的住宅（非连锁店、未满 5 级）与自己已建成、未到上限的设施。
   * cost = 工程费（非董事长：该地地价 × PI，付给公司，可用存款、付不起即破产；董事长 0）；rent = 当前等级租金（设施为 0）
   */
  lots: { lot: LotId; level: LotLevel; cost: number; rent: number }[];
  /** CONSTRUCTION_PICK 能否跳过（V-R19 ⚑：PROGRAM 下为 false，原版真人界面与 AI 都会选一块） */
  canSkip: boolean;
}

export interface SubscribeSharesOptions {
  company: CompanyLotId;
  stock: number;
  /** 每股单价 = trunc(资产额 / 10000)（元，不乘 PI，只用现金） */
  unitPrice: number;
  /** min(1000, trunc(现金 / 单价), 公司保留股) */
  max: number;
  cash: number;
  reserved: number;
}

/** 被动卡询问的场景 */
export type PassiveContext = 'toll' | 'fee' | 'taxAudit' | 'fine' | 'frame' | 'sleepwalk' | 'confine';

export interface UseFreeCardOptions {
  context: PassiveContext;
  amount: number;
  payer: SeatIndex;
  lot: LotId | null;
  /** 将被消耗的免费卡所在卡槽 */
  slot: number;
}

export interface ScapegoatOptions {
  context: PassiveContext;
  amount: number | null;
  days: number | null;
  candidates: SeatIndex[];
  slot: number;
}

export type BidIncrement = 0 | 100 | 500 | 1000 | 5000 | 10000;

export interface AuctionBidOptions {
  lot: LotId;
  level: LotLevel;
  seller: SeatIndex | null;
  start: number;
  price: number;
  leader: SeatIndex | null;
  /** inc=0 只在 leader==null 时出现（按起拍价出价）；只列出价后不超过现金的档位 */
  increments: BidIncrement[];
  cash: number;
  /**
   * 除自己与领先者以外现在还能出价的竞拍者人数（未放弃、未退出、在场且现金 ≥ 下一口价；AI：只剩自己可出价时
   * 压成最小档）。
   * M7 起引擎总会给出；可选只是为了兼容旧存档与测试桩。
   */
  others?: number;
  /** 拍卖来源（拍卖卡、破产、投降、新闻、魔法屋）；同上，引擎总会给出 */
  source?: 'card' | 'bankrupt' | 'surrender' | 'news' | 'magic';
}

export interface BirthdayPickOptions {
  victims: { seat: SeatIndex; cards: { slot: number; card: CardId }[] }[];
}

export interface DiscardCardOptions {
  hand: { slot: number; card: CardId; price: number }[];
  incoming: CardId;
}

export interface DeathGodTargetOptions {
  candidates: SeatIndex[];
}

export interface DecisionOptionsMap {
  TURN_MENU: TurnMenuOptions;
  BANK_ATM: BankAtmOptions;
  BANK_COUNTER: BankCounterOptions;
  BUY_LAND: BuyLandOptions;
  UPGRADE_LAND: UpgradeLandOptions;
  BUY_FACILITY: BuyFacilityOptions;
  BUILD_FACILITY: BuildFacilityOptions;
  UPGRADE_FACILITY: UpgradeFacilityOptions;
  FACILITY_TYPE: FacilityTypeOptions;
  RESEARCH: ResearchOptions;
  SHOP: ShopOptions;
  LOTTERY: LotteryOptions;
  BAIL: BailOptions;
  MINIGAME: MinigameOptions;
  MAGIC_CAST: MagicCastOptions;
  CONSTRUCTION_PICK: ConstructionPickOptions;
  SUBSCRIBE_SHARES: SubscribeSharesOptions;
  USE_FREE_CARD: UseFreeCardOptions;
  SCAPEGOAT: ScapegoatOptions;
  AUCTION_BID: AuctionBidOptions;
  BIRTHDAY_PICK: BirthdayPickOptions;
  DISCARD_CARD: DiscardCardOptions;
  DEATH_GOD_TARGET: DeathGodTargetOptions;
}

export type DecisionOptions = DecisionOptionsMap[DecisionKind];

// ───────────────────────── PendingDecision ─────────────────────────

/** 所有观察者可见的决策摘要（例如「正在考虑是否购买 台北」） */
export interface DecisionPublicInfo<K extends DecisionKind = DecisionKind> {
  kind: K;
  seat: SeatIndex;
  lot: LotId | null;
  amount: number | null;
  labelKey: string | null;
}

/** 小游戏种子只放在决策里（state.pending 从不整体下发），MINIGAME_STARTED 事件不带种子 */
export interface PendingMinigame {
  minigameId: MinigameId;
  seed: number;
  params: MinigameParams;
}

export interface PendingDecision<K extends DecisionKind = DecisionKind> {
  /** `d${n}`，确定且单调递增，时光机回滚也不回退 */
  id: string;
  /** 发出本决策的帧 */
  frameId: number;
  seat: SeatIndex;
  kind: K;
  /** 渲染和 AI 所需的全部数值与合法候选（可能含私密信息，只下发给 seat） */
  options: DecisionOptionsMap[K];
  publicInfo: DecisionPublicInfo<K>;
  /** 超时或兜底时使用，必须合法 */
  defaultIntent: PlayerIntent;
  timing: DecisionTimingClass;
  /** key 相同的连续决策继承剩余时间（TURN_MENU：turnMenuBudgetKey(turnNo, seat)）；无则 null */
  budgetKey: string | null;
  /** 只有 MINIGAME 决策非 null */
  minigame: PendingMinigame | null;
}

/** 按 kind 展开的判别联合，便于 switch 收窄 */
export type AnyPendingDecision = { [K in DecisionKind]: PendingDecision<K> }[DecisionKind];

export function isDecisionKind(x: unknown): x is DecisionKind {
  return typeof x === 'string' && (DECISION_KINDS as readonly string[]).includes(x);
}

/** 收窄 PendingDecision 的 kind（options 随之收窄） */
export function isDecisionOf<K extends DecisionKind>(d: PendingDecision, kind: K): d is PendingDecision<K> {
  return d.kind === kind;
}

/** 转成判别联合以便 switch(d.kind) 收窄（kind 与 options 的对应由引擎保证） */
export function asAnyPending(d: PendingDecision): AnyPendingDecision {
  return d as AnyPendingDecision;
}
