/**
 * GameEvent（architecture §5.6；事件清单见 design/engine.md §12.2，按 architecture 修订：
 * 删除 DICE_SET；DICE_ROLLED 带 diceCount；MINIGAME_RESULT 事件改名 MINIGAME_ENDED；MINIGAME_STARTED 不带种子；
 * 每次日推进结束 emit DAY_END）。
 *
 * - 判别字段 type（SCREAMING_SNAKE）；EventBase = { type; post?: PostPatch }。
 * - post 由引擎在 ctx.emit 时对公开世界做实体级 diff 自动生成（受影响实体各字段的绝对值）；handler 必须先改状态再 emit。
 * - 事件本身只带演出需要的参数；缺省值一律用 null，不用 undefined。
 * - EVENT_META 是脱敏与重置的唯一依据；客户端 handlers / soundMap / EVENT_BUDGET_MS 以 GameEventType 为键并用 satisfies 穷举。
 */

import type { PassiveContext, TeleportDest, TeleportSource } from './decision';
import type { AuctionSource, ConfineWhere, FeeKind, TollExemptReason, TollMod } from './frames';
import type {
  ActorRef,
  CardId,
  Cause,
  CompanyLotId,
  Controller,
  DateNum,
  DiceCount,
  DiceFace,
  FacilityLotId,
  FacilityType,
  FateId,
  GodKind,
  ItemId,
  LandLotId,
  LotId,
  LotLevel,
  MagicConditionId,
  MagicEffectId,
  MinigameId,
  MoneyReason,
  NewsId,
  Party,
  ResearchProject,
  SeatIndex,
  TileId,
  Vehicle,
  VillainKind,
} from './ids';
import type { DebugOp, UseTarget } from './intent';
import type {
  Beggar,
  ClockState,
  CompanyState,
  EconomyState,
  FacilityState,
  GameResult,
  GameStatus,
  GodSlot,
  LandState,
  Listing,
  LotteryState,
  PlayerState,
  Pools,
  RoadObject,
  StockState,
  VillainState,
} from './state';

// ───────────────────────── PostPatch ─────────────────────────

/**
 * 玩家实体的字段级 set。引擎生成时带 cards（完整手牌）与 items（完整背包）；view/project 投影时：
 * public 模式补上 cardCount / itemCount，private 模式对非本人把 cards / items 改写为 null 并给出 cardCount / itemCount。
 */
export type PlayerPatch = Partial<Omit<PlayerState, 'cards' | 'items'>> & {
  cards?: CardId[] | null;
  cardCount?: number;
  items?: number[] | null;
  itemCount?: number;
};

/**
 * 事件里的出卡目标：与 UseTarget 相同，只是抢夺卡抢道具时 take.item 可为 null
 * （私密手牌模式下出卡人、被抢人以外的观察者看不到被抢的道具种类；UseTarget 可以直接赋给它）
 */
export type EventUseTarget =
  | Exclude<UseTarget, { t: 'rob' }>
  | { t: 'rob'; seat: SeatIndex; take: { k: 'card'; slot: number } | { k: 'item'; item: ItemId | null } };

/** 事件发生后受影响实体各字段的绝对值（数组、对象字段整体替换；objects/gods/beggars 等整表替换） */
export interface PostPatch {
  players?: { seat: SeatIndex; set: PlayerPatch }[];
  villains?: { kind: VillainKind; set: Partial<VillainState> }[];
  lands?: { id: LandLotId; set: Partial<LandState> }[];
  facilities?: { id: FacilityLotId; set: Partial<FacilityState> }[];
  companies?: { id: CompanyLotId; set: Partial<CompanyState> }[];
  stocks?: { idx: number; set: Partial<StockState> }[];
  objects?: RoadObject[];
  gods?: GodSlot[];
  beggars?: Beggar[];
  clock?: Partial<ClockState>;
  econ?: Partial<EconomyState>;
  pools?: Pools;
  lottery?: LotteryState;
  noticeBoard?: Listing[];
  status?: GameStatus;
  result?: GameResult | null;
}

export interface EventBase {
  type: string;
  post?: PostPatch;
}

// ───────────────────────── 事件载荷 ─────────────────────────

export type TurnBlockReason = 'hotel' | 'away' | 'jail' | 'hospital' | 'hibernate';
export type BlessingCategory = 'reward' | 'penalty' | 'misfortune';
export type BlessingResult = 'high' | 'none' | 'low';
export type CardSource =
  | 'square' // 卡片格
  | 'shop' // 百货公司购买
  | 'god' // 福神发威、请神
  | 'holiday' // 圣诞节
  | 'chairmanGift' // 百货董事长赠卡
  | 'rob' // 抢夺卡
  | 'birthday' // 命运「生日」
  | 'villain' // 恶人偷卡交给雇主
  | 'magic' // 魔法屋
  | 'board' // 公布栏成交
  | 'debug';
export type CardLossCause =
  | 'used' // 主动使用（CARD_USED 同时发出）
  | 'passive' // 被动卡消耗
  | 'sold' // 卖给百货公司
  | 'discard' // 满手弃牌
  | 'robbed'
  | 'birthday'
  | 'stolen' // 恶人偷卡
  | 'badLuckGod' // 衰神发威丢卡
  | 'deathGod' // 死神没收
  | 'magic' // 魔法屋卖卡
  | 'fate' // 命运卖光卡片道具
  | 'board' // 公布栏卖出
  | 'bankrupt';
export type ItemChangeSource =
  | 'setup'
  | 'shop'
  | 'gift'
  | 'research'
  | 'rob'
  | 'villain'
  | 'chairmanGift'
  | 'board'
  | 'used'
  | 'sold'
  | 'robbed'
  | 'stolen'
  | 'deathGod'
  | 'magic'
  | 'fate'
  | 'vehicleSwap'
  | 'bankrupt'
  | 'debug';
/** VEHICLE.via：不是用道具换车、原版只刷新外观的座驾切换（见 VEHICLE） */
export type VehicleSwitchVia = 'sleepwalk' | 'wake' | 'expire' | 'sold';
export type StrikeKind = 'missile' | 'nuke' | 'alien' | 'typhoon' | 'bomb3x3';
export type GodLeaveReason = 'expired' | 'displaced' | 'dispelled' | 'swept' | 'struck' | 'bitten' | 'bankrupt';
export type GodManifestEffect = 'levelUp' | 'levelDown' | 'seize';
export type StatusKey = 'stay' | 'tortoise' | 'hibernate' | 'sleepwalk' | 'bankReject' | 'insurance' | 'engineer';
export type VillainActionKind =
  | 'stealPoints' // 小偷：点券减半给雇主
  | 'stealObject' // 小偷：拿走路面物件
  | 'robDeposit' // 强盗：存款 20%
  | 'stealCard' // 偷卡
  | 'extort' // 流氓：收地价
  | 'spySurplus' // 间谍：公司本月盈余
  | 'spyToll'; // 间谍：上次过路费 ⚑
export type ListingRemoveReason = 'delisted' | 'sold' | 'invalid' | 'bankrupt';
export type MarketClosedReason = 'sunday' | 'holiday' | 'halted';
/** 点券来源：点券格（落点码 10/11/12）、宝箱 */
export type PointsSource = 'square' | 'chest';

/** 新闻、命运文案插值参数（地名、公司名、人名等以 id/key 传给客户端做 i18n） */
export type EventParams = Record<string, number | string | null>;

/** type → 载荷；GameEvent 由它按 type 展开 */
export interface GameEventPayloads {
  // turn
  GAME_STARTED: { seats: SeatIndex[]; date: DateNum };
  TURN_STARTED: { actor: ActorRef; turnNo: number };
  PARACHUTE: { seat: SeatIndex; node: TileId; prev: TileId };
  TURN_BLOCKED: { seat: SeatIndex; reason: TurnBlockReason; remaining: number };
  RELEASED: { actor: ActorRef; from: ConfineWhere };
  RETURNED: { seat: SeatIndex; node: TileId };
  TURN_ENDED: { actor: ActorRef };
  // move
  DICE_ROLLED: { seat: SeatIndex; dice: DiceFace[]; steps: number; forced: boolean; diceCount: DiceCount };
  MOVE_SEGMENT: { actor: ActorRef; path: TileId[]; remaining: number };
  ROADBLOCK_HIT: { actor: ActorRef; node: TileId };
  REVERSED: { actor: ActorRef };
  LANDED: { actor: ActorRef; node: TileId };
  // money
  MONEY: { from: Party; to: Party; amount: number; paid: number; reason: MoneyReason; ref: LotId | null };
  LOAN: { seat: SeatIndex; amount: number; due: DateNum };
  REPAY: { seat: SeatIndex; amount: number };
  LOAN_REMINDER: { seat: SeatIndex; daysLeft: number };
  LOAN_FORCED: { seat: SeatIndex; amount: number; paid: number };
  ATM: { seat: SeatIndex; op: 'deposit' | 'withdraw'; amount: number };
  FINANCE: { seat: SeatIndex; amount: number };
  RESERVE_SHORTFALL: { chairman: SeatIndex; amount: number };
  INSURANCE_PAYOUT: { seat: SeatIndex; amount: number; days: number };
  /** 点券增加（点券格、宝箱）；点券后置值在 post 里（小游戏另发 MINIGAME_ENDED） */
  POINTS_GAINED: { seat: SeatIndex; amount: number; source: PointsSource };
  // property
  LAND_BOUGHT: { seat: SeatIndex; lot: LotId; price: number };
  LOT_LEVEL: { lot: LotId; from: LotLevel; to: LotLevel; cause: Cause };
  FACILITY_BUILT: { lot: FacilityLotId; facility: FacilityType; seat: SeatIndex | null };
  /** mode 0 拆一级 / 1 清为无主 / 2 夷平保留地主 */
  LOT_MUTATED: { lot: LotId; mode: 0 | 1 | 2; cause: Cause };
  TOLL_PAID: {
    payer: SeatIndex;
    owner: SeatIndex;
    ally: SeatIndex | null;
    amount: number;
    allyAmount: number;
    lots: LotId[];
    mods: TollMod[];
  };
  TOLL_EXEMPT: { payer: SeatIndex; lot: LotId; reason: TollExemptReason };
  FEE_PAID: {
    payer: SeatIndex;
    lot: LotId;
    feeKind: Exclude<FeeKind, 'company'>;
    wheel: number | null;
    amount: number;
  };
  HOTEL_STAY: { seat: SeatIndex; lot: FacilityLotId; days: number };
  COMPANY_FEE: { seat: SeatIndex; company: CompanyLotId; industry: number; amount: number; wheel: number | null };
  SUBSCRIBED: { seat: SeatIndex; stock: number; shares: number; unit: number };
  INVEST_BLOCKED: { seat: SeatIndex; lot: LotId; god: GodKind | null };
  CANNOT_AFFORD: { seat: SeatIndex; lot: LotId; price: number };
  MARK_SET: { lots: LotId[]; kind: 'raise' | 'seal'; days: number };
  MARK_EXPIRED: { lots: LotId[]; kind: 'raise' | 'seal' };
  TENURE_EXPIRED: { lots: LotId[] };
  RESEARCH_STARTED: { seat: SeatIndex; lot: FacilityLotId; project: ResearchProject; days: number };
  /** delivered=false：持有已满 9 个，研发成果作废 */
  RESEARCH_DONE: { seat: SeatIndex; lot: FacilityLotId; project: ResearchProject; item: ItemId; delivered: boolean };
  RESEARCH_CANCELLED: { seat: SeatIndex; lot: FacilityLotId; project: ResearchProject };
  // card / item 里 privacy='redactHand' 的事件（见 EVENT_META）：私密手牌模式下对无权看的观察者把卡号 / 道具号置 null
  CARD_GAINED: { seat: SeatIndex; card: CardId | null; source: CardSource };
  CARD_LOST: { seat: SeatIndex; card: CardId | null; cause: CardLossCause };
  /** 出卡是公开动作（原版亮卡）；只有抢夺卡抢道具时 target.take.item 对出卡人、被抢人以外的观察者置 null */
  CARD_USED: { seat: SeatIndex; card: CardId; target: EventUseTarget };
  CARD_NO_EFFECT: { seat: SeatIndex; card: CardId };
  /**
   * 被动卡生效（免罪 21 / 嫁祸 19 / 复仇 18 / 免费 20）。other = 对方：原版持卡人亮卡、说完卡片台词之后，接一句反应台词
   * （卡片台词表 mode 2，0x47e51a + 4×(60 + 卡号 − 1)）的人——复仇是出卡者（exe 0x443383，当前玩家），嫁祸是被改嫁的
   * 新目标（0x443645），免费是过路费 / 设施费的地主（0x419e89、0x419654）或查税卡的出卡者（0x443ede）；免罪（0x44381f 只有
   * 一句）、企业消费（0x41a796 传 -1）与罚款没有对方，为 null
   */
  PASSIVE: { seat: SeatIndex; card: CardId; context: PassiveContext; other: SeatIndex | null };
  /** shelf 只给进店的人（私密手牌模式下其他观察者为空数组：货架 + 点券变化可以缩小成交的范围） */
  SHOP_OPENED: { seat: SeatIndex; shelf: CardId[]; fullDeck: boolean };
  SHOP_TRADE: {
    seat: SeatIndex;
    op: 'buyCard' | 'sellCard' | 'buyItem' | 'sellItem';
    card: CardId | null;
    item: ItemId | null;
    qty: number;
    points: number;
  };
  CHAIRMAN_GIFT: { seat: SeatIndex; card: CardId | null; item: ItemId | null };
  // item
  /** item 为 null：私密手牌模式下别人的道具种类（数量与来源仍公开） */
  ITEM_GAINED: { seat: SeatIndex; item: ItemId | null; qty: number; source: ItemChangeSource };
  ITEM_LOST: { seat: SeatIndex; item: ItemId | null; qty: number; cause: ItemChangeSource };
  ITEM_USED: { seat: SeatIndex; item: ItemId; target: UseTarget };
  /**
   * 换了交通工具（vehicle = 换后的座驾）。原版各条路径都只调 0x40b425 刷新外观，不出对话框、没有换车音效，客户端一律只换外观、
   * 记日志（architecture §34）。没有 stowed / via 的是用机车、汽车、工程车道具换车（原版另整屏重画、说道具台词，台词随 ITEM_USED）；
   * - stowed：真人从回合菜单收起机车 / 汽车（STOW_VEHICLE，0x4467b1），值为收回背包的那台；
   * - via（0.6.0 起；from = 切换前的座驾）：'sleepwalk' 中梦游卡、座驾停放（0x442fa8）；'wake' 梦游结束装回停放的座驾
   *   （0x41c1aa）；'expire' 工程车到期换回原车或步行（0x41c4d3）；'sold' 魔法屋「卖光道具」连座驾一起折价（0x4446de）
   */
  VEHICLE: {
    seat: SeatIndex;
    vehicle: Vehicle;
    dice: DiceCount;
    stowed?: 'moto' | 'car';
    via?: VehicleSwitchVia;
    from?: Vehicle;
  };
  /**
   * 交通工具没了（机车 / 汽车回共享库存，工程车作废）。via 'fate'（0.6.0 起）：命运 10 / 11 机车被偷、汽车撞毁——原版直接把
   * 模式写成步行、刷新外观、说事件槽 3 / 4 的台词（0x44b4eb / 0x44b5fc），不走地雷炸弹那条毁车路径（0x40c7cd），客户端不播车毁
   */
  VEHICLE_DESTROYED: { seat: SeatIndex; vehicle: Vehicle; via?: 'fate' };
  OBJECT_PLACED: { obj: RoadObject };
  OBJECT_REMOVED: { obj: RoadObject; cause: Cause };
  DOLL_WALK: { seat: SeatIndex; path: TileId[]; clearedObjects: number[]; clearedGods: GodKind[] };
  BOMB_ATTACHED: { seat: SeatIndex; fuse: number };
  BOMB_TRANSFERRED: { from: SeatIndex; to: SeatIndex; fuse: number };
  BOMB_EXPLODED: { seat: SeatIndex; node: TileId; lot: LotId | null };
  STRIKE: { kind: StrikeKind; center: TileId; half: number; lots: LotId[]; actors: ActorRef[] };
  TELEPORTED: { by: SeatIndex; source: TeleportSource; dest: TeleportDest };
  /** resetsView：客户端直接用批尾 view reset；随后引擎补发一个完整 SYNC */
  TIME_REWOUND: { bySeat: SeatIndex; toTurnNo: number };
  // god
  GOD_ATTACHED: { seat: SeatIndex; kind: GodKind; displaced: GodKind | null };
  /** slot：老虎机位数与结果（不乘 PI）；transfers：发威造成的逐人金额（正为收入） */
  GOD_POWER: {
    seat: SeatIndex;
    kind: GodKind;
    slot: { digits: number; value: number } | null;
    transfers: { seat: SeatIndex; amount: number }[];
  };
  GOD_LEFT: { seat: SeatIndex | null; kind: GodKind; reason: GodLeaveReason };
  GOD_SPAWNED: { kind: GodKind; node: TileId };
  GOD_MANIFEST: { seat: SeatIndex; kind: GodKind; lot: LotId; effect: GodManifestEffect };
  DOG_BITE: { seat: SeatIndex; node: TileId };
  DOG_KNOCKED: { seat: SeatIndex; node: TileId };
  DEATH_GOD_SUMMONED: { by: SeatIndex; target: SeatIndex };
  // status
  CONFINED: { actor: ActorRef; where: ConfineWhere; days: number; total: number; cause: Cause };
  BLESSING: { seat: SeatIndex; category: BlessingCategory; result: BlessingResult };
  STATUS_SET: { actor: ActorRef; status: StatusKey; value: number };
  ALLIANCE_FORMED: { a: SeatIndex; b: SeatIndex; days: number };
  ALLIANCE_BROKEN: { a: SeatIndex; b: SeatIndex; reason: 'hostility' | 'newAlliance' | 'bankrupt' };
  ALLIANCE_EXPIRED: { a: SeatIndex; b: SeatIndex };
  /**
   * 银行不受理：reason='rejected' 为拒绝往来（days = 剩余天数，含今天）；
   * reason='sunday' 为 sundayBankClosed（MANUAL）下星期日休息（days=0），ATM 与柜台都只弹提示
   */
  BANK_REJECTED: { seat: SeatIndex; days: number; reason: 'rejected' | 'sunday' };
  // event
  NEWS: { id: NewsId; params: EventParams; affected: SeatIndex[] };
  FATE: { seat: SeatIndex; id: FateId; amount: number | null; blessing: BlessingResult | null };
  MAGIC_CONDITION: { caster: SeatIndex; cond: MagicConditionId; targets: SeatIndex[] };
  MAGIC_CAST: { caster: SeatIndex; effect: MagicEffectId; targets: SeatIndex[] };
  LOTTERY_TICKET: { seat: SeatIndex; number: number };
  /** 无人购票不开奖：number=null */
  LOTTERY_DRAW: { number: number | null; winner: SeatIndex | null; prize: number };
  MINIGAME_STARTED: { seat: SeatIndex; minigameId: MinigameId };
  /** speechSlot：不玩分支的台词槽（rand15()&1）；played 时为 null。点券后置值在 post 里 */
  MINIGAME_ENDED: {
    seat: SeatIndex;
    minigameId: MinigameId;
    mode: 'played' | 'skipped';
    score: number;
    speechSlot: 0 | 1 | null;
  };
  BAIL: { by: SeatIndex; seat: SeatIndex; cost: number };
  VILLAIN_HIRED: { by: SeatIndex; kind: VillainKind; cost: number };
  VILLAIN_ACTION: {
    kind: VillainKind;
    employer: SeatIndex | null;
    victim: SeatIndex | null;
    what: VillainActionKind;
    amount: number;
  };
  VILLAIN_HOME: { kind: VillainKind };
  BEGGAR_ALMS: { payer: SeatIndex; beggar: SeatIndex; amount: number; newNode: TileId };
  // stock
  STOCK_TRADED: {
    seat: SeatIndex;
    stock: number;
    side: 'buy' | 'sell';
    shares: number;
    priceCents: number;
    amount: number;
  };
  CHAIRMAN_CHANGED: { stock: number; from: SeatIndex | null; to: SeatIndex | null };
  STOCK_FLAG: { stock: number; up: number; down: number; byCard: boolean };
  SUSPENDED: { stock: number; days: number };
  RESUMED: { stock: number };
  MARKET_TICK: { date: DateNum };
  MARKET_CLOSED: { reason: MarketClosedReason };
  LISTING_ADDED: { listing: Listing };
  LISTING_REMOVED: { listingId: number; reason: ListingRemoveReason };
  LISTING_SOLD: { listingId: number; seller: SeatIndex; buyer: SeatIndex; price: number };
  // auction
  AUCTION_STARTED: { lot: LotId; seller: SeatIndex | null; source: AuctionSource; start: number; bidders: SeatIndex[] };
  AUCTION_BID: { seat: SeatIndex; price: number };
  AUCTION_PASS: { seat: SeatIndex };
  AUCTION_QUIT: { seat: SeatIndex };
  /** 流拍：winner=null（拍卖卡来源时该地变为无主） */
  AUCTION_ENDED: { lot: LotId; winner: SeatIndex | null; price: number };
  // day
  DAY_ADVANCED: { date: DateNum; weekday: number; elapsed: number };
  PRICE_INDEX: { from: number; to: number };
  /** 节日；圣诞送卡另发 CARD_GAINED{source:'holiday'} */
  HOLIDAY: { key: string; giveCard: boolean };
  DIVIDENDS: { rows: { company: CompanyLotId; seat: SeatIndex; amount: number }[] };
  MONTHLY_REPORT: {
    rows: { seat: SeatIndex; netWorth: number; loss: number; gain: number; interest: number }[];
    champion: SeatIndex | null;
    tragic: SeatIndex | null;
  };
  OBJECTS_RESPAWNED: { objects: number[] };
  /** 每次日推进结束都发；服务器用它触发自动存档 */
  DAY_END: { date: DateNum; elapsed: number };
  // end
  BANKRUPT: { seat: SeatIndex; cause: Cause; creditor: Party | null };
  LIQUIDATION: { seat: SeatIndex; stocks: number[]; lots: LotId[]; auctionLots: LotId[] };
  BECAME_BEGGAR: { seat: SeatIndex; node: TileId };
  SURRENDERED: { seat: SeatIndex };
  GAME_OVER: { result: GameResult };
  // system
  CONTROLLER_CHANGED: { seat: SeatIndex; controller: Controller };
  AI_TRAITS_CHANGED: { seat: SeatIndex };
  DEBUG_APPLIED: { op: DebugOp['op'] };
  /** 引擎在 action 结束时补发，公布此前未经任何事件公布的变化；开发 / 测试模式下除 TIME_REWOUND 之后外视为缺陷 */
  SYNC: { reason: 'flush' | 'timeRewind' };
}

export type GameEventType = keyof GameEventPayloads;

export type GameEventOf<T extends GameEventType> = { type: T; post?: PostPatch } & GameEventPayloads[T];

/** 可辨识联合（判别字段 type） */
export type GameEvent = { [T in GameEventType]: GameEventOf<T> }[GameEventType];

// ───────────────────────── EVENT_META ─────────────────────────

export type EventCat =
  | 'turn'
  | 'move'
  | 'money'
  | 'property'
  | 'card'
  | 'item'
  | 'god'
  | 'status'
  | 'event'
  | 'stock'
  | 'auction'
  | 'day'
  | 'end'
  | 'system';

/**
 * public：所有观察者看到同一份载荷（post 仍按私密模式改写 cards / items、去掉 pools）；
 * redactHand：载荷含 seat 与卡号 / 道具号（或货架、抢夺目标），私密手牌模式下由 view/project 的 HAND_REDACTORS
 * 按事件类型逐项置 null（对 seat 以外的观察者；抢夺卡另外对被抢人可见）。
 */
export type EventPrivacy = 'public' | 'redactHand';

export interface EventMeta {
  readonly cat: EventCat;
  readonly privacy: EventPrivacy;
  /** 客户端遇到它直接用批尾 view reset（目前只有 TIME_REWOUND） */
  readonly resetsView?: true;
}

const pub = <C extends EventCat>(cat: C) => ({ cat, privacy: 'public' }) as const;
const redact = <C extends EventCat>(cat: C) => ({ cat, privacy: 'redactHand' }) as const;

/** 脱敏与重置的唯一依据（对 GameEventType 穷举） */
export const EVENT_META = Object.freeze({
  GAME_STARTED: pub('turn'),
  TURN_STARTED: pub('turn'),
  PARACHUTE: pub('turn'),
  TURN_BLOCKED: pub('turn'),
  RELEASED: pub('turn'),
  RETURNED: pub('turn'),
  TURN_ENDED: pub('turn'),
  DICE_ROLLED: pub('move'),
  MOVE_SEGMENT: pub('move'),
  ROADBLOCK_HIT: pub('move'),
  REVERSED: pub('move'),
  LANDED: pub('move'),
  MONEY: pub('money'),
  LOAN: pub('money'),
  REPAY: pub('money'),
  LOAN_REMINDER: pub('money'),
  LOAN_FORCED: pub('money'),
  ATM: pub('money'),
  FINANCE: pub('money'),
  RESERVE_SHORTFALL: pub('money'),
  INSURANCE_PAYOUT: pub('money'),
  POINTS_GAINED: pub('money'),
  LAND_BOUGHT: pub('property'),
  LOT_LEVEL: pub('property'),
  FACILITY_BUILT: pub('property'),
  LOT_MUTATED: pub('property'),
  TOLL_PAID: pub('property'),
  TOLL_EXEMPT: pub('property'),
  FEE_PAID: pub('property'),
  HOTEL_STAY: pub('property'),
  COMPANY_FEE: pub('property'),
  SUBSCRIBED: pub('property'),
  INVEST_BLOCKED: pub('property'),
  CANNOT_AFFORD: pub('property'),
  MARK_SET: pub('property'),
  MARK_EXPIRED: pub('property'),
  TENURE_EXPIRED: pub('property'),
  RESEARCH_STARTED: pub('property'),
  RESEARCH_DONE: pub('property'),
  RESEARCH_CANCELLED: pub('property'),
  CARD_GAINED: redact('card'),
  CARD_LOST: redact('card'),
  CARD_USED: redact('card'),
  CARD_NO_EFFECT: pub('card'),
  PASSIVE: pub('card'),
  SHOP_OPENED: redact('card'),
  SHOP_TRADE: redact('card'),
  CHAIRMAN_GIFT: redact('card'),
  ITEM_GAINED: redact('item'),
  ITEM_LOST: redact('item'),
  ITEM_USED: pub('item'),
  VEHICLE: pub('item'),
  VEHICLE_DESTROYED: pub('item'),
  OBJECT_PLACED: pub('item'),
  OBJECT_REMOVED: pub('item'),
  DOLL_WALK: pub('item'),
  BOMB_ATTACHED: pub('item'),
  BOMB_TRANSFERRED: pub('item'),
  BOMB_EXPLODED: pub('item'),
  STRIKE: pub('item'),
  TELEPORTED: pub('item'),
  TIME_REWOUND: { cat: 'item', privacy: 'public', resetsView: true },
  GOD_ATTACHED: pub('god'),
  GOD_POWER: pub('god'),
  GOD_LEFT: pub('god'),
  GOD_SPAWNED: pub('god'),
  GOD_MANIFEST: pub('god'),
  DOG_BITE: pub('god'),
  DOG_KNOCKED: pub('god'),
  DEATH_GOD_SUMMONED: pub('god'),
  CONFINED: pub('status'),
  BLESSING: pub('status'),
  STATUS_SET: pub('status'),
  ALLIANCE_FORMED: pub('status'),
  ALLIANCE_BROKEN: pub('status'),
  ALLIANCE_EXPIRED: pub('status'),
  BANK_REJECTED: pub('status'),
  NEWS: pub('event'),
  FATE: pub('event'),
  MAGIC_CONDITION: pub('event'),
  MAGIC_CAST: pub('event'),
  LOTTERY_TICKET: pub('event'),
  LOTTERY_DRAW: pub('event'),
  MINIGAME_STARTED: pub('event'),
  MINIGAME_ENDED: pub('event'),
  BAIL: pub('event'),
  VILLAIN_HIRED: pub('event'),
  VILLAIN_ACTION: pub('event'),
  VILLAIN_HOME: pub('event'),
  BEGGAR_ALMS: pub('event'),
  STOCK_TRADED: pub('stock'),
  CHAIRMAN_CHANGED: pub('stock'),
  STOCK_FLAG: pub('stock'),
  SUSPENDED: pub('stock'),
  RESUMED: pub('stock'),
  MARKET_TICK: pub('stock'),
  MARKET_CLOSED: pub('stock'),
  LISTING_ADDED: pub('stock'),
  LISTING_REMOVED: pub('stock'),
  LISTING_SOLD: pub('stock'),
  AUCTION_STARTED: pub('auction'),
  AUCTION_BID: pub('auction'),
  AUCTION_PASS: pub('auction'),
  AUCTION_QUIT: pub('auction'),
  AUCTION_ENDED: pub('auction'),
  DAY_ADVANCED: pub('day'),
  PRICE_INDEX: pub('day'),
  HOLIDAY: pub('day'),
  DIVIDENDS: pub('day'),
  MONTHLY_REPORT: pub('day'),
  OBJECTS_RESPAWNED: pub('day'),
  DAY_END: pub('day'),
  BANKRUPT: pub('end'),
  LIQUIDATION: pub('end'),
  BECAME_BEGGAR: pub('end'),
  SURRENDERED: pub('end'),
  GAME_OVER: pub('end'),
  CONTROLLER_CHANGED: pub('system'),
  AI_TRAITS_CHANGED: pub('system'),
  DEBUG_APPLIED: pub('system'),
  SYNC: pub('system'),
} as const satisfies { readonly [T in GameEventType]: EventMeta });

/** 全部事件类型（顺序同 EVENT_META） */
export const GAME_EVENT_TYPES: readonly GameEventType[] = Object.freeze(Object.keys(EVENT_META) as GameEventType[]);

/** privacy='redactHand' 的事件类型（view/project 的 HAND_REDACTORS 对它穷举） */
export type RedactHandEventType = {
  [T in GameEventType]: (typeof EVENT_META)[T]['privacy'] extends 'redactHand' ? T : never;
}[GameEventType];

/** resetsView 的事件类型 */
export type ResetsViewEventType = {
  [T in GameEventType]: (typeof EVENT_META)[T] extends { resetsView: true } ? T : never;
}[GameEventType];

export function isGameEventType(x: unknown): x is GameEventType {
  return typeof x === 'string' && Object.hasOwn(EVENT_META, x);
}

/**
 * 不是用道具换车、也不是被炸毁的座驾切换（VEHICLE 带 stowed 或 via：真人收起、中梦游卡、梦游结束装回、工程车到期、魔法屋卖光；
 * VEHICLE_DESTROYED 带 via 'fate'：命运 10 / 11 失车，客户端据此不播车毁、改说事件槽台词）。原版这些都不说道具台词（architecture §34）
 */
export function isQuietVehicleSwitch(e: GameEventOf<'VEHICLE'> | GameEventOf<'VEHICLE_DESTROYED'>): boolean {
  return e.type === 'VEHICLE' ? e.stowed !== undefined || e.via !== undefined : e.via !== undefined;
}
