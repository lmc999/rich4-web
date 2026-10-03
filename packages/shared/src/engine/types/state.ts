/**
 * GameState 完整类型（design/engine.md §4，按 architecture §5.3 修订）。
 *
 * 约束（architecture §4「确定性」）：
 * - state 里只放 JSON 值：用 null 不用 undefined，不用 Map/Set；集合一律用数组，排序比较器最后按 seat 或 id 定序。
 * - 金额按 int32 语义；股价以「分」存整数；唯一允许的浮点字段是 StockState.momentum。
 * - state.flow / pending / counters / secret 永远不下发；publicWorld(state) 给出可下发的世界（PublicWorld）。
 */
import type { XoshiroState } from '../../util/rng/xoshiro';
import type { GameConfig } from './config';
import type { PendingDecision } from './decision';
import type { Frame } from './frames';
import type {
  AiTraits,
  CardId,
  CharacterId,
  CompanyLotId,
  Controller,
  DateNum,
  DiceCount,
  FacilityLotId,
  FacilityType,
  FateId,
  GodKind,
  ItemId,
  LandLotId,
  LotId,
  LotLevel,
  NewsId,
  RandPurpose,
  ResearchProject,
  SeatIndex,
  TileId,
  Vehicle,
  VillainKind,
} from './ids';

/** state 引用的数据版本：mapHash = MapDef.meta.dataHash（sha256），tablesHash = FNV-1a 64(规范化 TABLES) */
export interface DataRef {
  mapId: string;
  mapHash: string;
  tablesHash: string;
}

export type GameStatus = 'playing' | 'over';

export interface GameState {
  /** STATE_SCHEMA_VERSION */
  v: number;
  /** 创建或迁移时的 ENGINE_VERSION */
  engine: string;
  dataRef: DataRef;
  /** 开局后只读 */
  config: GameConfig;
  status: GameStatus;
  result: GameResult | null;
  clock: ClockState;
  econ: EconomyState;
  /** 按 seat 升序，2..4 人；seat 不要求连续 */
  players: PlayerState[];
  /** 固定顺序 VILLAIN_KINDS：[thief, robber, thug, spy] */
  villains: VillainState[];
  /** 按地图 lots 中 kind='land' 的顺序 */
  lands: LandState[];
  /** 按地图 lots 中 kind='facility' 的顺序 */
  facilities: FacilityState[];
  /** 按地图 companies 的顺序 */
  companies: CompanyState[];
  /** 路面物件，每个格至多 1 个（不含神明） */
  objects: RoadObject[];
  /** 固定 14 槽：kind 1..12 各 1 个，死神 2 个 */
  gods: GodSlot[];
  beggars: Beggar[];
  /** 按地图 stocks 的顺序（台湾 12 支） */
  stocks: StockState[];
  pools: Pools;
  lottery: LotteryState;
  /** 公布栏 */
  noticeBoard: Listing[];
  /** 解释器帧栈（不下发） */
  flow: Frame[];
  /** 当前待决策；拍卖时可有多个；游戏结束时为 [] */
  pending: PendingDecision[];
  /** 自增计数器（不下发）；时光机回滚也不回退 */
  counters: Counters;
  /** 永不下发 */
  secret: SecretState;
}

/** 行动游标：座位回合 → 恶人回合 → 日推进 */
export type ClockCursor = { t: 'seat'; seat: SeatIndex } | { t: 'villain'; idx: 0 | 1 | 2 | 3 } | { t: 'day' };

export interface ClockState {
  date: DateNum;
  /** 0 = 星期日；1998-01-01 为星期四 */
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  elapsedDays: number;
  /** 每个演员（玩家或恶人）回合开始时 +1 */
  turnNo: number;
  cursor: ClockCursor;
  /** 今日是否开市（日推进时计算） */
  marketOpen: boolean;
  /** 今日节日 key（MapDef.holidays），无则 null */
  holiday: string | null;
}

export interface EconomyState {
  initialFund: number;
  /** 物价指数 PI（只升不降） */
  priceIndex: number;
  /** 公库，即乐透奖池 */
  pool: number;
  /** 新闻 22：停止放款，ATM 只能存 */
  bankRunDays: number;
  /** 新闻 26：全面停市 */
  marketClosedDays: number;
  /** 资金守恒台账（公开，测试用） */
  ledger: { minted: number; burned: number };
}

/** 阻碍类计数器的原始编码：低 7 位 = 天数；0x80 = 待释放（两段式，design/engine.md §7.2） */
export interface Counters2 {
  /** 主阻碍：住旅馆、消失（出国/绑架/航空）、坐牢、住院 */
  hotel: number;
  away: number;
  jail: number;
  hospital: number;
  hibernate: number;
  sleepwalk: number;
  stay: number;
  tortoise: number;
}

/**
 * 工程车：剩余自己的回合数（原版模式字节 +0x11 的高 6 位）、到期要换回的座驾（+0x64）与换回时恢复的骰子数（+0x65，
 * 开工程车之前的骰子数；0.6.0 起，旧快照由 migrateState 补成换回座驾的上限——与旧版到期时按上限一致）
 */
export interface EngineerState {
  days: number;
  restore: 'walk' | 'moto' | 'car';
  dice: DiceCount;
}

/** 梦游卡停放的座驾：vehicle 为工程车时 engineer 是停放时的工程车状态，否则为 null */
export interface ParkedVehicle {
  vehicle: Exclude<Vehicle, 'walk'>;
  dice: DiceCount;
  engineer: EngineerState | null;
}

/** 本座位本回合已做的自由操作，按发生顺序（AI 的 PRE_ROLL 用它推算进度，architecture §5.3） */
export type TurnLogEntry = 'stockBuy' | 'stockSell' | 'boardList' | 'boardBuy' | 'card' | 'item';

/** 回合临时状态，回合开始时清零 */
export interface PlayerTurnState {
  /** 遥控骰子指定的步数 */
  forcedSteps: number | null;
  /** 本回合对自己用了传送机（视为已掷骰） */
  teleportedSelf: boolean;
  cardsUsed: number;
  itemsUsed: number;
  /** 本回合非终结 TURN_MENU 操作次数；超过 MENU_ACTION_LIMIT 抛 EngineRuleError('MENU_LIMIT') */
  menuActions: number;
  log: TurnLogEntry[];
}

export interface StockHolding {
  shares: number;
  /** 累计成本（分） */
  costCents: number;
}

export interface PlayerState {
  seat: SeatIndex;
  character: CharacterId;
  controller: Controller;
  /** 开局由 resolveTraits 写入；托管设置经 SYS_SET_AI_TRAITS 修改，随存档保存 */
  aiTraits: AiTraits;
  alive: boolean;
  out: null | 'bankrupt' | 'surrender';
  // 资金
  cash: number;
  deposit: number;
  loan: number;
  /** 0 表示无贷款 */
  loanDue: DateNum;
  /** 特别融资余额（已计入 deposit） */
  finance: number;
  /** 点券 0..65535 */
  points: number;
  // 位置与行进
  /** false 表示尚未跳伞落地（首回合） */
  placed: boolean;
  /** 未落地时为 0 */
  node: TileId;
  prevNode: TileId;
  /**
   * 已停用（ENGINE_VERSION 0.5.0 起不再写入，恒为 null）：原先关押期间保存朝向、释放时恢复；
   * 现在获释留在关押格、来路 = 关押格（flow/turn.ts release）。字段保留以免改 state 结构，旧快照里的值在释放时清掉
   */
  savedPrevNode: TileId | null;
  vehicle: Vehicle;
  /** 持久保存；ROLL{dice} 会改写它 */
  diceCount: DiceCount;
  engineer: EngineerState | null;
  /**
   * 梦游卡停放的座驾（原版 +0x66 / +0x67，ENGINE_VERSION 0.6.0 起）：中梦游卡时记下原座驾与骰子数（机车 / 汽车同时退回背包，
   * 工程车连同剩余天数一起停放、梦游期间不倒数），梦游结束的回合开始时装回（effects/items/vehicle.ts wakeVehicle）；
   * 中卡时步行、冬眠卡取消梦游、出局时为 null。旧快照没有这个字段，migrateState 补 null
   */
  parked: ParkedVehicle | null;
  st: Counters2;
  /** 刚释放、本回合走回棋盘（原版 +0x15|=0x10） */
  returning: boolean;
  /** 拒绝往来天数（普通倒数） */
  bankReject: number;
  insuranceDays: number;
  alliance: { seat: SeatIndex; days: number } | null;
  god: { kind: GodKind; days: number } | null;
  /** 身上的定时炸弹（与神明槽相互独立），fuse 为剩余步数 */
  bomb: { fuse: number } | null;
  /** 衰运、财运、福运（神明附身时累加，离身时减回） */
  luck: { bad: number; wealth: number; fortune: number };
  /** hostility[j] = 我对 seat j 的敌意 */
  hostility: [number, number, number, number];
  /** ≤15 张，顺序即卡槽顺序 */
  cards: CardId[];
  /** 长度 14，下标 = ItemId（0 不用）；装备中的机车、汽车不计入 */
  items: number[];
  /** 与 state.stocks 等长 */
  holdings: StockHolding[];
  /** 本回合每支股票可买量，与 state.stocks 等长 */
  quota: number[];
  monthly: { loss: number; gain: number; badDays: number; interest: number };
  turn: PlayerTurnState;
}

export interface VillainState {
  kind: VillainKind;
  home: 'jail' | 'hospital';
  onBoard: boolean;
  node: TileId;
  prevNode: TileId;
  /** 家格（关押格） */
  homeNode: TileId;
  leftHome: boolean;
  employer: SeatIndex | null;
  st: Pick<Counters2, 'jail' | 'hospital' | 'hibernate' | 'sleepwalk' | 'stay' | 'tortoise'>;
}

/** 涨价卡、查封卡的标记；PROGRAM 下后写覆盖前写 */
export interface LotMark {
  kind: 'raise' | 'seal';
  days: number;
}

export interface LandState {
  id: LandLotId;
  owner: SeatIndex | null;
  level: LotLevel;
  /** 连锁店（等级 ≤ 1） */
  chain: boolean;
  /** 运行期地价，初值来自地图；新闻 6/14 会改写 */
  landPrice: number;
  mark: LotMark | null;
  /** 地契到期日；0 表示无限期（不夹日：1/31 + 1 个月 = 2/31，永不到期） */
  tenure: DateNum;
  /** 上一次收到的过路费（间谍偷租金用 ⚑） */
  lastToll: number;
}

export interface FacilityResearch {
  project: ResearchProject;
  days: number;
}

export interface FacilityState {
  id: FacilityLotId;
  owner: SeatIndex | null;
  level: LotLevel;
  /** level 0 时为 'park' */
  type: FacilityType;
  landPrice: number;
  mark: LotMark | null;
  tenure: DateNum;
  lastFee: number;
  research: FacilityResearch | null;
}

export interface CompanyState {
  id: CompanyLotId;
  /** 对应 state.stocks 的下标 */
  stock: number;
  /** 公司保留股，现场认购的来源 */
  reserved: number;
  /** 本月盈余（15 日分红）；可以为负 */
  surplusMonth: number;
  /** 累积盈余；可以为负 */
  surplusTotal: number;
}

export type RoadObjectKind = 'roadblock' | 'mine' | 'bomb' | 'gift' | 'chest';

export interface RoadObject {
  id: number;
  kind: RoadObjectKind;
  node: TileId;
  placedBy: SeatIndex | null;
}

export type GodWhere = { t: 'absent' } | { t: 'road'; node: TileId } | { t: 'attached'; seat: SeatIndex };

export interface GodSlot {
  slot: number;
  kind: GodKind;
  where: GodWhere;
}

/** 破产者的棋子留在原节点成为乞丐 */
export interface Beggar {
  seat: SeatIndex;
  node: TileId;
}

export interface StockState {
  idx: number;
  priceCents: number;
  prevCents: number;
  openCents: number;
  /** 动量：唯一允许的浮点字段（只做四则运算） */
  momentum: number;
  /** 利多 / 利空剩余天数（原版事件字节的两个半字节） */
  up: number;
  down: number;
  /** 停牌剩余天数 */
  suspend: number;
  /** 市场流通可买股数 */
  float: number;
  /** 董事长（持股严格最多者，平手保留现任） */
  chairman: SeatIndex | null;
  /** 最近 144 个开市日收盘价（分） */
  history: number[];
}

export interface Pools {
  /** 下标 = CardId（0 不用），牌堆剩余张数（合计守恒 100） */
  cards: number[];
  /** 下标 = ItemId（0 不用），只统计 1..8 的共享库存 */
  items: number[];
}

export interface LotteryState {
  /** 36 个号码（下标 0 对应显示的 1 号） */
  owners: (SeatIndex | null)[];
}

export type ListingAsset =
  | { t: 'stock'; stock: number; shares: number }
  | { t: 'lot'; lot: LotId }
  | { t: 'card'; card: CardId }
  | { t: 'item'; item: ItemId; qty: number };

/** 公布栏挂牌 */
export interface Listing {
  id: number;
  seller: SeatIndex;
  price: number;
  asset: ListingAsset;
}

export interface Counters {
  action: number;
  decision: number;
  frame: number;
  object: number;
  listing: number;
}

export interface DebugQueueEntry {
  purpose: RandPurpose;
  values: number[];
}

export interface SecretState {
  rng: XoshiroState;
  /** 36 张，开局洗一次，循环抽，不重洗 */
  newsOrder: NewsId[];
  newsCursor: number;
  /** 37 张 */
  fateOrder: FateId[];
  fateCursor: number;
  /** timeMachine='global' 的锚点 */
  timeAnchor: TimeAnchor | null;
  /** timeMachine='perSeat' 的锚点，下标 = seat；其他模式为 [] */
  timeAnchors: (TimeAnchor | null)[];
  /** AI 随机数的根种子（uint32），只有 AiDriver 能读（architecture §4 RNG） */
  aiSeed: number;
  /** 只有 config.debug=true 时才能写入 */
  debugQueue: DebugQueueEntry[];
}

/** 锚点世界：公开世界 + 帧栈 + 新闻命运的牌序和游标（不含 rng、上一个锚点、counters） */
export type AnchorWorld = PublicWorld & {
  flow: Frame[];
  decks: Pick<SecretState, 'newsOrder' | 'newsCursor' | 'fateOrder' | 'fateCursor'>;
};

export interface TimeAnchor {
  takenAtTurn: number;
  seat: SeatIndex;
  world: AnchorWorld;
}

/** 可以下发的世界（再经 view/project 按观察者投影成 GameView） */
export type PublicWorld = Omit<GameState, 'secret' | 'flow' | 'pending' | 'counters'>;

export type GameEndReason = 'timeLimit' | 'wealthTarget' | 'lastStanding' | 'noHumansLeft';

export interface GameResult {
  reason: GameEndReason;
  /** 原版终局码：1 真人全出局，2 单真人局胜，3 多真人局胜 */
  code: 1 | 2 | 3;
  winner: SeatIndex | null;
  date: DateNum;
  elapsedDays: number;
  ranking: { seat: SeatIndex; netWorth: number; alive: boolean }[];
}
