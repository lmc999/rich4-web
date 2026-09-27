/**
 * 玩家 intent、系统 action 与 zod 校验（architecture §5.5；design/engine.md §9.4）。
 * PlayerIntentSchema 只含玩家 intent：服务器 guard 与 AiDriver 都用它校验；SystemAction 只能由服务器产生。
 */
import { z } from 'zod';
import { INT32_MAX } from '../../util/int32';
import type { BidIncrement, TeleportDest, TeleportSource } from './decision';
import {
  type ActorRef,
  type AiTraits,
  CARD_IDS,
  type CardId,
  type Controller,
  type DateNum,
  type DiceCount,
  type DiceFace,
  FACILITY_TYPES,
  type FacilityType,
  ITEM_IDS,
  type ItemId,
  type LotId,
  MAGIC_EFFECT_IDS,
  type MagicEffectId,
  RAND_PURPOSES,
  type RandPurpose,
  type ResearchProject,
  type SeatIndex,
  type TileId,
  VILLAIN_KINDS,
  type VillainKind,
} from './ids';
import type { ListingAsset } from './state';

// ───────────────────────── 目标 ─────────────────────────

/**
 * 卡片、道具的目标（与 TargetCandidates 一一对应，合法性由引擎按候选校验）：
 * none / auto → {t:'none'}；seat；actor；lot（0 级设施首建附带 facility）；underfoot（改建卡附带目标类型）；
 * lotPair（换地、换屋）；lotOrObject → lot 或 object；stock；node / anyNode → node；dice；rob；teleport。
 */
export type UseTarget =
  | { t: 'none' }
  | { t: 'seat'; seat: SeatIndex }
  | { t: 'actor'; actor: ActorRef }
  | { t: 'lot'; lot: LotId; facility: FacilityType | null }
  | { t: 'underfoot'; facility: FacilityType | null }
  | { t: 'lotPair'; from: LotId; to: LotId }
  | { t: 'object'; object: number }
  | { t: 'stock'; stock: number }
  | { t: 'node'; node: TileId }
  | { t: 'dice'; value: DiceFace }
  | { t: 'rob'; seat: SeatIndex; take: { k: 'card'; slot: number } | { k: 'item'; item: ItemId } }
  | { t: 'teleport'; source: TeleportSource; dest: TeleportDest };

export type CardTarget = UseTarget;
export type ItemTarget = UseTarget;

// ───────────────────────── 玩家 intent ─────────────────────────

export type PlayerIntent =
  /** dice 可选：引擎校验不超过交通工具上限，并写入 player.diceCount */
  | { type: 'ROLL'; dice?: DiceCount }
  | { type: 'USE_CARD'; slot: number; card: CardId; target: CardTarget }
  | { type: 'USE_ITEM'; item: ItemId; target: ItemTarget }
  | { type: 'STOCK_BUY'; stock: number; shares: number }
  | { type: 'STOCK_SELL'; stock: number; shares: number }
  | { type: 'BOARD_LIST'; asset: ListingAsset; price: number }
  | { type: 'BOARD_DELIST'; listingId: number }
  | { type: 'BOARD_BUY'; listingId: number }
  | { type: 'SURRENDER' }
  | { type: 'CONFIRM' }
  | { type: 'DECLINE' }
  | { type: 'SKIP' }
  | { type: 'LEAVE' }
  | { type: 'BUILD_FACILITY'; facility: FacilityType }
  | { type: 'CHOOSE_FACILITY_TYPE'; facility: FacilityType }
  | { type: 'ATM'; op: 'deposit' | 'withdraw'; amount: number }
  | { type: 'LOAN'; amount: number }
  | { type: 'REPAY'; amount: number }
  | { type: 'FINANCE'; amount: number }
  | { type: 'SHOP_BUY_CARD'; shelfIdx: number }
  | { type: 'SHOP_SELL_CARD'; slot: number }
  | { type: 'SHOP_BUY_ITEM'; item: ItemId; qty: number }
  | { type: 'SHOP_SELL_ITEM'; item: ItemId; qty: number }
  /** number 为 0..35（下标 0 = 显示的 1 号） */
  | { type: 'LOTTERY_BUY'; number: number }
  /** target：被保释的座位（不能叫 seat：GameAction 的 seat 是提交者，服务器按会话覆盖） */
  | { type: 'BAIL'; target: SeatIndex }
  | { type: 'HIRE'; villain: VillainKind }
  | { type: 'MAGIC_CAST'; effect: MagicEffectId }
  | { type: 'RESEARCH'; project: ResearchProject }
  | { type: 'PICK_LOT'; lot: LotId }
  | { type: 'SUBSCRIBE'; shares: number }
  | { type: 'BID'; inc: BidIncrement }
  | { type: 'PASS' }
  | { type: 'QUIT' }
  | { type: 'SCAPEGOAT'; target: SeatIndex }
  | { type: 'PICK_CARDS'; picks: { from: SeatIndex; slot: number }[] }
  | { type: 'DISCARD'; slot: number }
  /** target：被死神附身的座位（同 BAIL，不能叫 seat） */
  | { type: 'DEATH_GOD_TARGET'; target: SeatIndex }
  /** MINIGAME 决策唯一允许的客户端 intent（开局后提交会被 Referee 拒绝） */
  | { type: 'MINIGAME_DECLINE' };

export type IntentType = PlayerIntent['type'];
export type IntentOf<T extends IntentType> = Extract<PlayerIntent, { type: T }>;

const INTENT_TYPE_SET = {
  ROLL: true,
  USE_CARD: true,
  USE_ITEM: true,
  STOCK_BUY: true,
  STOCK_SELL: true,
  BOARD_LIST: true,
  BOARD_DELIST: true,
  BOARD_BUY: true,
  SURRENDER: true,
  CONFIRM: true,
  DECLINE: true,
  SKIP: true,
  LEAVE: true,
  BUILD_FACILITY: true,
  CHOOSE_FACILITY_TYPE: true,
  ATM: true,
  LOAN: true,
  REPAY: true,
  FINANCE: true,
  SHOP_BUY_CARD: true,
  SHOP_SELL_CARD: true,
  SHOP_BUY_ITEM: true,
  SHOP_SELL_ITEM: true,
  LOTTERY_BUY: true,
  BAIL: true,
  HIRE: true,
  MAGIC_CAST: true,
  RESEARCH: true,
  PICK_LOT: true,
  SUBSCRIBE: true,
  BID: true,
  PASS: true,
  QUIT: true,
  SCAPEGOAT: true,
  PICK_CARDS: true,
  DISCARD: true,
  DEATH_GOD_TARGET: true,
  MINIGAME_DECLINE: true,
} as const satisfies { readonly [T in IntentType]: true };

/** 全部玩家 intent 类型（编译期对 IntentType 穷举） */
export const INTENT_TYPES: readonly IntentType[] = Object.freeze(Object.keys(INTENT_TYPE_SET) as IntentType[]);

// ───────────────────────── 系统 action（只能由服务器产生） ─────────────────────────

/** SYS_DEBUG 的操作（要求 config.debug=true；debug:act 只在 RICH4_TEST_MODE=1 时注册） */
export type DebugOp =
  /** 按 purpose 预置随机结果，逐个出队替换语义结果（例如 dice 值 1..6、fork 为候选下标） */
  | { op: 'forceNext'; purpose: RandPurpose; values: number[] }
  | { op: 'setCash'; seat: SeatIndex; cash: number; deposit: number | null }
  | { op: 'setPoints'; seat: SeatIndex; points: number }
  /** prev 可选：指定来路（决定之后的前进方向），须为 node 的邻格；缺省时沿用原来路（若相邻）或第一个邻格 */
  | { op: 'teleport'; seat: SeatIndex; node: TileId; prev?: TileId }
  | { op: 'give'; seat: SeatIndex; cards: CardId[]; items: { item: ItemId; qty: number }[] }
  | { op: 'setDate'; date: DateNum }
  /** 收走路上的神明与路面物件（路障、地雷、炸弹回共享库存）：E2E 在开局后调用，排除开局随机摆放对强制路线的干扰 */
  | { op: 'clearBoard' }
  /** 让新闻 / 命运牌堆接下来依次抽到 ids（换到游标处，牌序仍是完整排列；M7 集成测试与 E2E 用） */
  | { op: 'stackDeck'; deck: 'news' | 'fate'; ids: number[] };

export type SystemAction =
  /** MinigameReferee 重放后提交；score 以服务器重放为准 */
  | { type: 'MINIGAME_RESULT'; seat: SeatIndex; decisionId: string; score: number; logHash: number }
  /** 被踢时转为纯电脑；托管不改 controller */
  | { type: 'SYS_SET_CONTROLLER'; seat: SeatIndex; controller: Controller }
  /** 托管设置写入 state.players[seat].aiTraits，随存档保存 */
  | { type: 'SYS_SET_AI_TRAITS'; seat: SeatIndex; traits: AiTraits }
  | { type: 'SYS_DEBUG'; op: DebugOp };

export type SystemActionType = SystemAction['type'];

const SYSTEM_ACTION_TYPE_SET = {
  MINIGAME_RESULT: true,
  SYS_SET_CONTROLLER: true,
  SYS_SET_AI_TRAITS: true,
  SYS_DEBUG: true,
} as const satisfies { readonly [T in SystemActionType]: true };

export const SYSTEM_ACTION_TYPES: readonly SystemActionType[] = Object.freeze(
  Object.keys(SYSTEM_ACTION_TYPE_SET) as SystemActionType[],
);

/** 玩家（含 AI、托管、超时代决）提交的 action：seat 只从 session 取 */
export type PlayerAction = PlayerIntent & { seat: SeatIndex; decisionId: string };

export type GameAction = PlayerAction | SystemAction;

export function isSystemAction(a: GameAction): a is SystemAction {
  return Object.hasOwn(SYSTEM_ACTION_TYPE_SET, a.type);
}

// ───────────────────────── zod ─────────────────────────

const LOT_ID_RE = /^[LFC][1-9]\d{0,3}$/;

const int = (min: number, max: number) => z.int().min(min).max(max);
const SeatSchema = z.literal([0, 1, 2, 3]);
const CardIdSchema = z.literal(CARD_IDS);
const ItemIdSchema = z.literal(ITEM_IDS);
const FacilityTypeSchema = z.enum(FACILITY_TYPES);
const VillainKindSchema = z.enum(VILLAIN_KINDS);
const LotIdSchema = z.custom<LotId>((v) => typeof v === 'string' && LOT_ID_RE.test(v), { message: 'invalid LotId' });
const TileIdSchema = int(1, 9999);
/** 卡槽、货架下标 */
const SlotSchema = int(0, 63);
/** 股票下标 */
const StockIdxSchema = int(0, 255);
const AmountSchema = int(0, INT32_MAX);
const PriceSchema = int(1, INT32_MAX);
const SharesSchema = int(1, INT32_MAX);
const QtySchema = int(1, 99);
const IdSchema = int(0, INT32_MAX);

const ActorRefSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('seat'), seat: SeatSchema }),
  z.strictObject({ t: z.literal('villain'), kind: VillainKindSchema }),
]);

const TeleportSourceSchema = z.discriminatedUnion('k', [
  z.strictObject({ k: z.literal('actor'), actor: ActorRefSchema }),
  z.strictObject({ k: z.literal('god'), slot: int(0, 63) }),
  z.strictObject({ k: z.literal('object'), object: IdSchema }),
  z.strictObject({ k: z.literal('house'), lot: LotIdSchema }),
]);

const TeleportDestSchema = z.discriminatedUnion('k', [
  z.strictObject({ k: z.literal('road'), node: TileIdSchema }),
  z.strictObject({ k: z.literal('lot'), lot: LotIdSchema }),
]);

export const UseTargetSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('none') }),
  z.strictObject({ t: z.literal('seat'), seat: SeatSchema }),
  z.strictObject({ t: z.literal('actor'), actor: ActorRefSchema }),
  z.strictObject({ t: z.literal('lot'), lot: LotIdSchema, facility: FacilityTypeSchema.nullable() }),
  z.strictObject({ t: z.literal('underfoot'), facility: FacilityTypeSchema.nullable() }),
  z.strictObject({ t: z.literal('lotPair'), from: LotIdSchema, to: LotIdSchema }),
  z.strictObject({ t: z.literal('object'), object: IdSchema }),
  z.strictObject({ t: z.literal('stock'), stock: StockIdxSchema }),
  z.strictObject({ t: z.literal('node'), node: TileIdSchema }),
  z.strictObject({ t: z.literal('dice'), value: z.literal([1, 2, 3, 4, 5, 6]) }),
  z.strictObject({
    t: z.literal('rob'),
    seat: SeatSchema,
    take: z.discriminatedUnion('k', [
      z.strictObject({ k: z.literal('card'), slot: SlotSchema }),
      z.strictObject({ k: z.literal('item'), item: ItemIdSchema }),
    ]),
  }),
  z.strictObject({ t: z.literal('teleport'), source: TeleportSourceSchema, dest: TeleportDestSchema }),
]);

export const ListingAssetSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('stock'), stock: StockIdxSchema, shares: SharesSchema }),
  z.strictObject({ t: z.literal('lot'), lot: LotIdSchema }),
  z.strictObject({ t: z.literal('card'), card: CardIdSchema }),
  z.strictObject({ t: z.literal('item'), item: ItemIdSchema, qty: QtySchema }),
]);

const bare = <T extends IntentType>(type: T) => z.strictObject({ type: z.literal(type) });

/** 只含玩家 intent（不含 MINIGAME_RESULT 等系统 action）；未知字段一律拒绝 */
export const PlayerIntentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ROLL'), dice: z.literal([1, 2, 3]).optional() }),
  z.strictObject({ type: z.literal('USE_CARD'), slot: SlotSchema, card: CardIdSchema, target: UseTargetSchema }),
  z.strictObject({ type: z.literal('USE_ITEM'), item: ItemIdSchema, target: UseTargetSchema }),
  z.strictObject({ type: z.literal('STOCK_BUY'), stock: StockIdxSchema, shares: SharesSchema }),
  z.strictObject({ type: z.literal('STOCK_SELL'), stock: StockIdxSchema, shares: SharesSchema }),
  z.strictObject({ type: z.literal('BOARD_LIST'), asset: ListingAssetSchema, price: PriceSchema }),
  z.strictObject({ type: z.literal('BOARD_DELIST'), listingId: IdSchema }),
  z.strictObject({ type: z.literal('BOARD_BUY'), listingId: IdSchema }),
  bare('SURRENDER'),
  bare('CONFIRM'),
  bare('DECLINE'),
  bare('SKIP'),
  bare('LEAVE'),
  z.strictObject({ type: z.literal('BUILD_FACILITY'), facility: FacilityTypeSchema }),
  z.strictObject({ type: z.literal('CHOOSE_FACILITY_TYPE'), facility: FacilityTypeSchema }),
  z.strictObject({ type: z.literal('ATM'), op: z.enum(['deposit', 'withdraw']), amount: AmountSchema }),
  z.strictObject({ type: z.literal('LOAN'), amount: AmountSchema }),
  z.strictObject({ type: z.literal('REPAY'), amount: AmountSchema }),
  z.strictObject({ type: z.literal('FINANCE'), amount: AmountSchema }),
  z.strictObject({ type: z.literal('SHOP_BUY_CARD'), shelfIdx: SlotSchema }),
  z.strictObject({ type: z.literal('SHOP_SELL_CARD'), slot: SlotSchema }),
  z.strictObject({ type: z.literal('SHOP_BUY_ITEM'), item: ItemIdSchema, qty: QtySchema }),
  z.strictObject({ type: z.literal('SHOP_SELL_ITEM'), item: ItemIdSchema, qty: QtySchema }),
  z.strictObject({ type: z.literal('LOTTERY_BUY'), number: int(0, 35) }),
  z.strictObject({ type: z.literal('BAIL'), target: SeatSchema }),
  z.strictObject({ type: z.literal('HIRE'), villain: VillainKindSchema }),
  z.strictObject({ type: z.literal('MAGIC_CAST'), effect: z.literal(MAGIC_EFFECT_IDS) }),
  z.strictObject({ type: z.literal('RESEARCH'), project: z.literal([1, 2, 3, 4, 5]) }),
  z.strictObject({ type: z.literal('PICK_LOT'), lot: LotIdSchema }),
  z.strictObject({ type: z.literal('SUBSCRIBE'), shares: SharesSchema }),
  z.strictObject({ type: z.literal('BID'), inc: z.literal([0, 100, 500, 1000, 5000, 10000]) }),
  bare('PASS'),
  bare('QUIT'),
  z.strictObject({ type: z.literal('SCAPEGOAT'), target: SeatSchema }),
  z.strictObject({
    type: z.literal('PICK_CARDS'),
    picks: z.array(z.strictObject({ from: SeatSchema, slot: SlotSchema })).max(3),
  }),
  z.strictObject({ type: z.literal('DISCARD'), slot: SlotSchema }),
  z.strictObject({ type: z.literal('DEATH_GOD_TARGET'), target: SeatSchema }),
  bare('MINIGAME_DECLINE'),
]);

/** debug:act 的 payload.op；SYS_DEBUG 同样使用 */
export const DebugOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('forceNext'),
    purpose: z.enum(RAND_PURPOSES),
    values: z.array(z.int().min(0).max(INT32_MAX)).min(1).max(64),
  }),
  z.strictObject({
    op: z.literal('setCash'),
    seat: SeatSchema,
    cash: int(-INT32_MAX, INT32_MAX),
    deposit: int(-INT32_MAX, INT32_MAX).nullable(),
  }),
  z.strictObject({ op: z.literal('setPoints'), seat: SeatSchema, points: int(0, 65535) }),
  z.strictObject({ op: z.literal('teleport'), seat: SeatSchema, node: TileIdSchema, prev: TileIdSchema.optional() }),
  z.strictObject({
    op: z.literal('give'),
    seat: SeatSchema,
    cards: z.array(CardIdSchema).max(15),
    items: z.array(z.strictObject({ item: ItemIdSchema, qty: QtySchema })).max(13),
  }),
  z.strictObject({ op: z.literal('setDate'), date: int(19980101, 21001231) }),
  z.strictObject({ op: z.literal('clearBoard') }),
  z.strictObject({
    op: z.literal('stackDeck'),
    deck: z.enum(['news', 'fate']),
    ids: z.array(z.int().min(0).max(36)).min(1).max(37),
  }),
]);
