/**
 * GameState / GameConfig 的 zod 结构校验（design/engine.md §15 第一步）。
 * - 公开世界、secret、counters 逐字段严格校验（strictObject：未知字段与 undefined 残留都会被拒绝）；
 * - 帧与决策 options 的内部结构只校验判别字段（细节由不变量检查与各帧自己的防御代码负责）。
 */
import { z } from 'zod';
import {
  CARD_IDS,
  CHARACTER_IDS,
  DECISION_KINDS,
  FACILITY_TYPES,
  FATE_IDS,
  FRAME_KINDS,
  GOD_KINDS,
  INITIAL_FUND_OPTIONS,
  ITEM_IDS,
  NEWS_IDS,
  PlayerIntentSchema,
  RAND_PURPOSES,
  START_VEHICLES,
  TENURE_OPTIONS,
  TIME_LIMIT_OPTIONS,
  VILLAIN_KINDS,
  WIN_MULTIPLE_OPTIONS,
} from '../types/index';

const int = z.int();
const nonneg = z.int().min(0);
const seat = z.literal([0, 1, 2, 3]);
const tile = z.int().min(0);
const lotId = z.string().regex(/^[LFC][1-9]\d*$/);
const level = z.literal([0, 1, 2, 3, 4, 5]);
const personality = z.literal([0, 1, 2]);
const vehicle = z.enum(['walk', 'moto', 'car', 'engineer']);

export const RuleConfigSchema = z.strictObject({
  preset: z.enum(['program', 'manual', 'custom']),
  redBlack: z.enum(['program', 'manual']),
  fortuneGodLand: z.enum(['program', 'manual']),
  smallPoorToll: z.enum(['x1.5', 'x2']),
  engineeringVehicle: z.enum(['program', 'manual']),
  bombBlast: z.enum(['program', 'manual3x3']),
  sundayBankClosed: z.boolean(),
  handFull: z.enum(['autoCheapest', 'choose']),
  blessingOnNews: z.boolean(),
  deathGodDispellable: z.boolean(),
  freeCardOnFines: z.boolean(),
  stockSuspendDays: z.literal([15, 10]),
  constructionChairmanLevels: z.literal([1, 2]),
  targetRange: z.enum(['window', 'global']),
  windowHalf: z.int().min(1).max(100000),
  timeMachine: z.enum(['global', 'perSeat', 'disabled']),
  intOverflow: z.enum(['saturate', 'wrap']),
  endWhenNoHumans: z.boolean(),
});

export const GameConfigSchema = z.strictObject({
  mapId: z.string().min(1).max(64),
  initialFund: z.literal(INITIAL_FUND_OPTIONS),
  vehicle: z.enum(START_VEHICLES),
  tenure: z.enum(TENURE_OPTIONS),
  timeLimitDays: z.literal(TIME_LIMIT_OPTIONS),
  winMultiple: z.literal(WIN_MULTIPLE_OPTIONS),
  startDate: int,
  minigames: z.enum(['play', 'skip']),
  rules: RuleConfigSchema,
  debug: z.boolean(),
});

const AiTraitsSchema = z.strictObject({
  personality,
  useCards: z.boolean(),
  useItems: z.boolean(),
  loanRatio: z.int().min(0).max(100),
  cashRatio: z.int().min(0).max(100),
  stockRatio: z.int().min(0).max(100),
});

export const PlayerSetupSchema = z.strictObject({
  seat,
  character: z.literal(CHARACTER_IDS),
  controller: z.enum(['human', 'ai']),
  ai: z
    .strictObject({
      preset: z.enum(['character', 'gentle', 'normal', 'cunning']),
      overrides: AiTraitsSchema.partial().optional(),
    })
    .optional(),
});

const CountersSchema = z.strictObject({
  hotel: nonneg,
  away: nonneg,
  jail: nonneg,
  hospital: nonneg,
  hibernate: nonneg,
  sleepwalk: nonneg,
  stay: nonneg,
  tortoise: nonneg,
});

const PlayerSchema = z.strictObject({
  seat,
  character: z.literal(CHARACTER_IDS),
  controller: z.enum(['human', 'ai']),
  aiTraits: AiTraitsSchema,
  alive: z.boolean(),
  out: z.enum(['bankrupt', 'surrender']).nullable(),
  cash: int,
  deposit: int,
  loan: int,
  loanDue: nonneg,
  finance: int,
  points: z.int().min(0).max(65535),
  placed: z.boolean(),
  node: tile,
  prevNode: tile,
  savedPrevNode: tile.nullable(),
  vehicle,
  diceCount: z.literal([1, 2, 3]),
  engineer: z.strictObject({ days: nonneg, restore: z.enum(['walk', 'moto', 'car']) }).nullable(),
  st: CountersSchema,
  returning: z.boolean(),
  bankReject: nonneg,
  insuranceDays: nonneg,
  alliance: z.strictObject({ seat, days: nonneg }).nullable(),
  god: z.strictObject({ kind: z.literal(GOD_KINDS), days: nonneg }).nullable(),
  bomb: z.strictObject({ fuse: nonneg }).nullable(),
  luck: z.strictObject({ bad: int, wealth: int, fortune: int }),
  hostility: z.tuple([int, int, int, int]),
  cards: z.array(z.literal(CARD_IDS)).max(15),
  items: z.array(z.int().min(0).max(99)).length(14),
  holdings: z.array(z.strictObject({ shares: nonneg, costCents: nonneg })),
  quota: z.array(nonneg),
  monthly: z.strictObject({ loss: int, gain: int, badDays: nonneg, interest: int }),
  turn: z.strictObject({
    forcedSteps: z.int().min(1).max(6).nullable(),
    teleportedSelf: z.boolean(),
    cardsUsed: nonneg,
    itemsUsed: nonneg,
    menuActions: nonneg,
    log: z.array(z.enum(['stockBuy', 'stockSell', 'boardList', 'boardBuy', 'card', 'item'])),
  }),
});

const markSchema = z.strictObject({ kind: z.enum(['raise', 'seal']), days: nonneg }).nullable();

const LandSchema = z.strictObject({
  id: z.string().regex(/^L[1-9]\d*$/),
  owner: seat.nullable(),
  level,
  chain: z.boolean(),
  landPrice: int,
  mark: markSchema,
  tenure: nonneg,
  lastToll: int,
});

const FacilitySchema = z.strictObject({
  id: z.string().regex(/^F[1-9]\d*$/),
  owner: seat.nullable(),
  level,
  type: z.enum(FACILITY_TYPES),
  landPrice: int,
  mark: markSchema,
  tenure: nonneg,
  lastFee: int,
  research: z.strictObject({ project: z.literal([1, 2, 3, 4, 5]), days: nonneg }).nullable(),
});

const CompanySchema = z.strictObject({
  id: z.string().regex(/^C[1-9]\d*$/),
  stock: nonneg,
  reserved: nonneg,
  surplusMonth: int,
  surplusTotal: int,
});

const StockSchema = z.strictObject({
  idx: nonneg,
  priceCents: nonneg,
  prevCents: nonneg,
  openCents: nonneg,
  momentum: z.number().refine(Number.isFinite),
  up: nonneg,
  down: nonneg,
  suspend: nonneg,
  float: nonneg,
  chairman: seat.nullable(),
  history: z.array(nonneg).max(144),
});

const VillainSchema = z.strictObject({
  kind: z.enum(VILLAIN_KINDS),
  home: z.enum(['jail', 'hospital']),
  onBoard: z.boolean(),
  node: tile,
  prevNode: tile,
  homeNode: tile,
  leftHome: z.boolean(),
  employer: seat.nullable(),
  st: z.strictObject({
    jail: nonneg,
    hospital: nonneg,
    hibernate: nonneg,
    sleepwalk: nonneg,
    stay: nonneg,
    tortoise: nonneg,
  }),
});

const ListingSchema = z.strictObject({
  id: nonneg,
  seller: seat,
  price: nonneg,
  asset: z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('stock'), stock: nonneg, shares: nonneg }),
    z.strictObject({ t: z.literal('lot'), lot: lotId }),
    z.strictObject({ t: z.literal('card'), card: z.literal(CARD_IDS) }),
    z.strictObject({ t: z.literal('item'), item: z.literal(ITEM_IDS), qty: nonneg }),
  ]),
});

const ResultSchema = z.strictObject({
  reason: z.enum(['timeLimit', 'wealthTarget', 'lastStanding', 'noHumansLeft']),
  code: z.literal([1, 2, 3]),
  winner: seat.nullable(),
  date: nonneg,
  elapsedDays: nonneg,
  ranking: z.array(z.strictObject({ seat, netWorth: int, alive: z.boolean() })),
});

const FrameSchema = z.looseObject({ fid: z.int().min(1), k: z.enum(FRAME_KINDS) });

const PendingSchema = z.strictObject({
  id: z.string().regex(/^d[1-9]\d*$/),
  frameId: z.int().min(1),
  seat,
  kind: z.enum(DECISION_KINDS),
  options: z.record(z.string(), z.unknown()),
  publicInfo: z.strictObject({
    kind: z.enum(DECISION_KINDS),
    seat,
    lot: lotId.nullable(),
    amount: int.nullable(),
    labelKey: z.string().nullable(),
  }),
  defaultIntent: PlayerIntentSchema,
  timing: z.enum(['menu', 'confirm', 'pick', 'shop', 'bank', 'auction', 'lottery', 'minigame']),
  budgetKey: z.string().nullable(),
  minigame: z
    .strictObject({
      minigameId: z.enum(['penguin', 'balloon', 'xicong']),
      seed: z.int().min(0).max(0xffffffff),
      params: z.strictObject({ ruleset: z.literal('exe311') }),
    })
    .nullable(),
});

const u32 = z.int().min(0).max(0xffffffff);

export const GameStateSchema = z.strictObject({
  v: z.int().min(1),
  engine: z.string(),
  dataRef: z.strictObject({ mapId: z.string(), mapHash: z.string(), tablesHash: z.string() }),
  config: GameConfigSchema,
  status: z.enum(['playing', 'over']),
  result: ResultSchema.nullable(),
  clock: z.strictObject({
    date: nonneg,
    weekday: z.literal([0, 1, 2, 3, 4, 5, 6]),
    elapsedDays: nonneg,
    turnNo: nonneg,
    cursor: z.discriminatedUnion('t', [
      z.strictObject({ t: z.literal('seat'), seat }),
      z.strictObject({ t: z.literal('villain'), idx: z.literal([0, 1, 2, 3]) }),
      z.strictObject({ t: z.literal('day') }),
    ]),
    marketOpen: z.boolean(),
    holiday: z.string().nullable(),
  }),
  econ: z.strictObject({
    initialFund: z.int().min(1),
    priceIndex: z.int().min(1),
    pool: int,
    bankRunDays: nonneg,
    marketClosedDays: nonneg,
    ledger: z.strictObject({ minted: nonneg, burned: nonneg }),
  }),
  players: z.array(PlayerSchema).min(2).max(4),
  villains: z.array(VillainSchema).length(4),
  lands: z.array(LandSchema),
  facilities: z.array(FacilitySchema),
  companies: z.array(CompanySchema),
  objects: z.array(
    z.strictObject({
      id: nonneg,
      kind: z.enum(['roadblock', 'mine', 'bomb', 'gift', 'chest']),
      node: z.int().min(1),
      placedBy: seat.nullable(),
    }),
  ),
  gods: z.array(
    z.strictObject({
      slot: nonneg,
      kind: z.literal(GOD_KINDS),
      where: z.discriminatedUnion('t', [
        z.strictObject({ t: z.literal('absent') }),
        z.strictObject({ t: z.literal('road'), node: z.int().min(1) }),
        z.strictObject({ t: z.literal('attached'), seat }),
      ]),
    }),
  ),
  beggars: z.array(z.strictObject({ seat, node: z.int().min(1) })),
  stocks: z.array(StockSchema),
  pools: z.strictObject({ cards: z.array(nonneg).length(31), items: z.array(nonneg).length(14) }),
  lottery: z.strictObject({ owners: z.array(seat.nullable()).length(36) }),
  noticeBoard: z.array(ListingSchema),
  flow: z.array(FrameSchema).min(1),
  pending: z.array(PendingSchema),
  counters: z.strictObject({ action: nonneg, decision: nonneg, frame: nonneg, object: nonneg, listing: nonneg }),
  secret: z.strictObject({
    rng: z.tuple([u32, u32, u32, u32]),
    newsOrder: z.array(z.literal(NEWS_IDS)).length(NEWS_IDS.length),
    newsCursor: nonneg,
    fateOrder: z.array(z.literal(FATE_IDS)).length(FATE_IDS.length),
    fateCursor: nonneg,
    timeAnchor: z.unknown().nullable(),
    timeAnchors: z.array(z.unknown().nullable()),
    aiSeed: u32,
    debugQueue: z.array(z.strictObject({ purpose: z.enum(RAND_PURPOSES), values: z.array(int).min(1) })),
  }),
});
