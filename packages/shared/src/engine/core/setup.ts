/**
 * 开局（design/engine.md §5 createGame 步骤；docs/research/g_arbitration.md §2.h）。
 *
 * 1 校验配置（人数 2..4、座位与角色不重复）；取地图；rng = seedFromHex(seedHex)
 * 2 date = clampStartDate(startDate)；星期、开市、节日；PI = 1
 * 3 每个座位：真人现金 = 总资金 / 2，电脑现金 = 总资金 × 角色现金比例 / 100，其余进存款；
 *   开局道具 1,2,3,4,8,9 各 1 件（1..8 从共享库存扣）；机车 / 汽车从库存扣，骰子数 = 交通工具上限
 * 4 恶人：小偷、强盗在监狱，流氓、间谍在医院（关押格），不在场
 * 5 地块、设施、企业、股票按地图初始化（公司保留股 = 10000 − 流通股）
 * 6 牌堆 100 张；神明 14 槽
 * 7 secret：新闻 36 张、命运 37 张各洗一次；aiSeed
 * 7b 随机摆放小财神、小福神、小穷神、小衰神、天使、恶犬、礼物、宝箱（互不重叠的空道路格，purpose 'place'）
 * 8 flow = [ROOT]，由调用方 run 到第一个待决策（首回合跳伞在那时发生）
 */
import type { DataRegistry } from '../../data/maps/registry';
import { initialDeck } from '../../data/tables/cards';
import { resolveTraits } from '../../data/tables/characters';
import { ECON } from '../../data/tables/economy';
import { FATE_IDS, GOD, GOD_KINDS, isPoolItem, NEWS_IDS, VILLAIN_HOME, VILLAIN_KINDS } from '../../data/tables/ids';
import { initialItemPool } from '../../data/tables/items';
import { START_FUND_SPLIT, START_ITEMS, VEHICLE_ITEM } from '../../data/tables/setup';
import { divTrunc } from '../../util/int32';
import { seedFromHex } from '../../util/rng/xoshiro';
import { placeInitialObjects } from '../effects/objects';
import { EngineRuleError } from '../errors';
import { applyCalendar } from '../flow/day';
import { freshTurnState } from '../flow/turn';
import { isValidDate } from '../rules/calendar';
import { emptyCounters } from '../rules/counters';
import { maxDice } from '../rules/movement';
import { clampStartDate, type GameConfig, type PlayerSetup } from '../types/config';
import type { CompanyLotId, FacilityLotId, LandLotId } from '../types/ids';
import type { GameState, GodSlot, PlayerState } from '../types/state';
import { GameConfigSchema, PlayerSetupSchema } from '../validate/schema';
import { ENGINE_VERSION, STATE_SCHEMA_VERSION } from '../version';
import { type EngineMap, engineMap } from './mapCache';
import { next32, shuffle } from './random';

function badConfig(msg: string): never {
  throw new EngineRuleError('BAD_CONFIG', msg);
}

function validateSetup(config: GameConfig, setups: readonly PlayerSetup[], seedHex: string): void {
  const c = GameConfigSchema.safeParse(config);
  if (!c.success) badConfig(c.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  if (!Array.isArray(setups) || setups.length < 2 || setups.length > 4) badConfig('need 2..4 players');
  for (const ps of setups) {
    const r = PlayerSetupSchema.safeParse(ps);
    if (!r.success) badConfig(`player setup: ${r.error.issues[0]?.message ?? 'invalid'}`);
  }
  if (new Set(setups.map((p) => p.seat)).size !== setups.length) badConfig('duplicate seat');
  if (new Set(setups.map((p) => p.character)).size !== setups.length) badConfig('duplicate character');
  if (typeof seedHex !== 'string' || !/^[0-9a-fA-F]{1,64}$/.test(seedHex))
    badConfig('seedHex must be 1..64 hex digits');
}

function newGods(): GodSlot[] {
  const kinds = [...GOD_KINDS, GOD.DEATH];
  return kinds.map((kind, slot) => ({ slot, kind, where: { t: 'absent' } }));
}

/** 生成开局 state（尚未 run：flow 只有 ROOT，pending 为空） */
export function createInitialState(
  reg: DataRegistry,
  config: GameConfig,
  setups: readonly PlayerSetup[],
  seedHex: string,
): { s: GameState; em: EngineMap } {
  validateSetup(config, setups, seedHex);
  const index = reg.getMap(config.mapId);
  const em = engineMap(index);
  const def = em.def;
  const date = clampStartDate(config.startDate);
  if (!isValidDate(date)) badConfig(`startDate ${config.startDate} is not a valid date`);

  const pools = { cards: initialDeck(), items: initialItemPool() };
  const sorted = setups.slice().sort((a, b) => a.seat - b.seat);
  const fund = config.initialFund;

  const players: PlayerState[] = sorted.map((ps) => {
    const aiTraits = resolveTraits(ps.character, ps.ai);
    const cashPct = ps.controller === 'human' ? START_FUND_SPLIT.humanCashPct : aiTraits.cashRatio;
    const cash = divTrunc(fund * cashPct, 100);
    const items = new Array<number>(14).fill(0);
    for (const it of START_ITEMS.items) {
      items[it] = (items[it] ?? 0) + 1;
      if (isPoolItem(it)) pools.items[it] = pools.items[it]! - 1;
    }
    const vItem = VEHICLE_ITEM[config.vehicle];
    if (vItem !== null) pools.items[vItem] = pools.items[vItem]! - 1;
    return {
      seat: ps.seat,
      character: ps.character,
      controller: ps.controller,
      aiTraits,
      alive: true,
      out: null,
      cash,
      deposit: fund - cash,
      loan: 0,
      loanDue: 0,
      finance: 0,
      points: 0,
      placed: false,
      node: 0,
      prevNode: 0,
      savedPrevNode: null,
      vehicle: config.vehicle,
      diceCount: maxDice(config.vehicle),
      engineer: null,
      st: emptyCounters(),
      returning: false,
      bankReject: 0,
      insuranceDays: 0,
      alliance: null,
      god: null,
      bomb: null,
      luck: { bad: 0, wealth: 0, fortune: 0 },
      hostility: [0, 0, 0, 0],
      cards: [],
      items,
      holdings: def.stocks.map(() => ({ shares: 0, costCents: 0 })),
      quota: def.stocks.map(() => 0),
      monthly: { loss: 0, gain: 0, badDays: 0, interest: 0 },
      turn: freshTurnState(),
    };
  });

  const rng = seedFromHex(seedHex);
  const s: GameState = {
    v: STATE_SCHEMA_VERSION,
    engine: ENGINE_VERSION,
    dataRef: { mapId: def.id, mapHash: def.meta.dataHash, tablesHash: reg.tablesHash },
    config: { ...structuredClone(config), startDate: date },
    status: 'playing',
    result: null,
    clock: {
      date,
      weekday: 0,
      elapsedDays: 0,
      turnNo: 0,
      cursor: { t: 'seat', seat: players[0]!.seat },
      marketOpen: false,
      holiday: null,
    },
    econ: {
      initialFund: fund,
      priceIndex: ECON.PRICE_INDEX_INIT,
      pool: 0,
      bankRunDays: 0,
      marketClosedDays: 0,
      ledger: { minted: 0, burned: 0 },
    },
    players,
    villains: VILLAIN_KINDS.map((kind) => {
      const home = VILLAIN_HOME[kind];
      const hold = home === 'jail' ? index.jailHold : index.hospitalHold;
      return {
        kind,
        home,
        onBoard: false,
        node: hold,
        prevNode: hold,
        homeNode: hold,
        leftHome: false,
        employer: null,
        st: { jail: 0, hospital: 0, hibernate: 0, sleepwalk: 0, stay: 0, tortoise: 0 },
      };
    }),
    lands: em.lands.map((l) => ({
      id: l.id as LandLotId,
      owner: null,
      level: 0,
      chain: false,
      landPrice: l.landPrice,
      mark: null,
      tenure: 0,
      lastToll: 0,
    })),
    facilities: em.facilities.map((f) => ({
      id: f.id as FacilityLotId,
      owner: null,
      level: 0,
      type: 'park',
      landPrice: f.landPrice,
      mark: null,
      tenure: 0,
      lastFee: 0,
      research: null,
    })),
    companies: em.companies.map((c) => {
      const sd = def.stocks[c.stockIndex];
      const reserved = sd ? Math.max(0, ECON.STOCK_TOTAL_SHARES - sd.float) : 0;
      return { id: c.id as CompanyLotId, stock: c.stockIndex, reserved, surplusMonth: 0, surplusTotal: 0 };
    }),
    objects: [],
    gods: newGods(),
    beggars: [],
    stocks: def.stocks.map((sd) => ({
      idx: sd.index,
      priceCents: sd.initPriceCents,
      prevCents: sd.initPriceCents,
      openCents: sd.initPriceCents,
      momentum: 0,
      up: 0,
      down: 0,
      suspend: 0,
      float: sd.float,
      chairman: null,
      history: [sd.initPriceCents],
    })),
    pools,
    lottery: { owners: new Array<null>(ECON.LOTTERY_NUMBERS).fill(null) },
    noticeBoard: [],
    flow: [{ k: 'ROOT', fid: 1, stage: 'seat', nextSeatFrom: 0, villainIdx: 0 }],
    pending: [],
    counters: { action: 0, decision: 0, frame: 1, object: 0, listing: 0 },
    secret: {
      rng,
      newsOrder: [],
      newsCursor: 0,
      fateOrder: [],
      fateCursor: 0,
      timeAnchor: null,
      timeAnchors: config.rules.timeMachine === 'perSeat' ? [null, null, null, null] : [],
      aiSeed: 0,
      debugQueue: [],
    },
  };
  applyCalendar(s, def.holidays);
  s.secret.newsOrder = shuffle(s, 'news', NEWS_IDS.slice());
  s.secret.fateOrder = shuffle(s, 'fate', FATE_IDS.slice());
  s.secret.aiSeed = next32(s, 'aiSeed');
  placeInitialObjects(s, em);
  return { s, em };
}
