// /dev/decisions 与组件测试共用的假数据：测试地图（fixture 'test'）上的 4 人局面，以及 23 种决策各一份 options。
// 数字只求合理、便于目测，不经过引擎（前端不能依赖引擎实现）；defaultIntent 用 shared 的 defaultIntentFor 生成，保证合法。
import { buildMapIndex, buildTestMap, type LandLot, type MapIndex } from '@rich4/shared/data';
import {
  CARD,
  cardDef,
  DECISION_KINDS,
  DECISION_TIMING_CLASS,
  type DecisionKind,
  type DecisionOptionsMap,
  defaultGameConfig,
  defaultIntentFor,
  ENGINE_VERSION,
  type FacilityType,
  ITEM,
  initialDeck,
  initialItemPool,
  type LotId,
  type SeatIndex,
  STATE_SCHEMA_VERSION,
  type StockRow,
  type TargetCandidates,
  type TurnMenuOptions,
} from '@rich4/shared/engine';
import type { DecisionForYou, GameView, PlayerView } from '@rich4/shared/view';

/** 确定性的伪随机（假数据用，保证截图稳定） */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}

export function demoMap(): MapIndex {
  return buildMapIndex(buildTestMap());
}

const CHARACTERS = [9, 4, 0, 3] as const;
const NODES = [5, 11, 17, 7] as const;

function demoPlayer(seat: SeatIndex, stockCount: number): PlayerView {
  const rnd = lcg(seat * 97 + 13);
  const cards =
    seat === 0
      ? [CARD.EQUAL_POVERTY, CARD.ANGEL, CARD.ROB, CARD.STAY, CARD.FREE, CARD.RED, CARD.TORTOISE]
      : seat === 1
        ? [CARD.FRAME, CARD.DEMOLISH, CARD.BUY_LAND]
        : seat === 2
          ? [CARD.SLEEPWALK]
          : [];
  const items = Array.from({ length: 14 }, () => 0);
  if (seat === 0) {
    items[ITEM.ROADBLOCK] = 2;
    items[ITEM.REMOTE_DICE] = 1;
    items[ITEM.TELEPORTER] = 1;
    items[ITEM.TIME_MACHINE] = 1;
  }
  if (seat === 1) items[ITEM.MINE] = 1;
  return {
    seat,
    character: CHARACTERS[seat],
    controller: seat === 0 ? 'human' : seat === 3 ? 'ai' : 'human',
    aiTraits: { personality: 1, useCards: true, useItems: true, loanRatio: 30, cashRatio: 40, stockRatio: 30 },
    alive: true,
    out: null,
    cash: [48800, 91200, 12500, 150300][seat],
    deposit: [120000, 30000, 0, 45000][seat],
    loan: seat === 2 ? 30000 : 0,
    loanDue: seat === 2 ? 19980610 : 0,
    finance: 0,
    points: [350, 120, 40, 900][seat],
    placed: true,
    node: NODES[seat],
    prevNode: NODES[seat] - 1,
    savedPrevNode: null,
    vehicle: seat === 0 ? 'moto' : seat === 1 ? 'car' : 'walk',
    diceCount: seat === 0 ? 2 : seat === 1 ? 3 : 1,
    engineer: null,
    st: {
      hotel: 0,
      away: 0,
      jail: seat === 2 ? 3 : 0,
      hospital: 0,
      hibernate: 0,
      sleepwalk: 0,
      stay: 0,
      tortoise: seat === 1 ? 2 : 0,
    },
    returning: false,
    bankReject: 0,
    insuranceDays: seat === 3 ? 5 : 0,
    alliance: null,
    god: seat === 0 ? { kind: 2, days: 4 } : seat === 3 ? { kind: 7, days: 2 } : null,
    bomb: null,
    luck: { bad: 0, wealth: 0, fortune: 0 },
    hostility: [0, 0, 0, 0],
    cards,
    cardCount: cards.length,
    items,
    holdings: Array.from({ length: stockCount }, (_, i) => {
      const shares = (i + seat) % 3 === 0 ? Math.trunc(rnd() * 20 + 1) * 100 : 0;
      return { shares, costCents: shares * Math.trunc(4000 + rnd() * 6000) };
    }),
    quota: Array.from({ length: stockCount }, () => 1000),
    monthly: { loss: 0, gain: 0, badDays: 0, interest: 0 },
    turn: { forcedSteps: null, teleportedSelf: false, cardsUsed: 0, itemsUsed: 0, menuActions: 3, log: [] },
  };
}

/** 测试地图上的 4 人局面（seat 0 = 孙小美，是「我」） */
export function demoView(map: MapIndex): GameView {
  const def = map.def;
  const owners: Record<string, { owner: SeatIndex | null; level: 0 | 1 | 2 | 3 | 4 | 5 }> = {
    L1: { owner: 0, level: 2 },
    L2: { owner: 1, level: 3 },
    L3: { owner: null, level: 0 },
    L4: { owner: 2, level: 1 },
    L5: { owner: 0, level: 5 },
    F1: { owner: 3, level: 2 },
  };
  const stocks = def.stocks.map((sd, i) => {
    const rnd = lcg(sd.index * 31 + 7);
    const history: number[] = [];
    let p = sd.initPriceCents;
    for (let d = 0; d < 40; d++) {
      p = Math.max(100, Math.trunc(p * (0.94 + rnd() * 0.12)));
      history.push(p);
    }
    const prev = history[history.length - 2] ?? p;
    return {
      idx: sd.index,
      priceCents: p,
      prevCents: prev,
      openCents: prev,
      momentum: 0,
      up: 0,
      down: 0,
      suspend: i === 5 ? 3 : 0,
      float: sd.float,
      chairman: i === 0 ? (0 as SeatIndex) : i === 2 ? (3 as SeatIndex) : null,
      history,
    };
  });
  const lottery: (SeatIndex | null)[] = Array.from({ length: 36 }, () => null);
  lottery[2] = 0;
  lottery[7] = 1;
  lottery[8] = 1;
  lottery[20] = 3;
  lottery[35] = 2;
  return {
    v: STATE_SCHEMA_VERSION,
    engine: ENGINE_VERSION,
    dataRef: { mapId: def.id, mapHash: def.meta.dataHash, tablesHash: 'dev' },
    config: defaultGameConfig(def.id, 19980101),
    status: 'playing',
    result: null,
    clock: {
      date: 19980312,
      weekday: 4,
      elapsedDays: 70,
      turnNo: 23,
      cursor: { t: 'seat', seat: 0 },
      marketOpen: true,
      holiday: null,
    },
    econ: {
      initialFund: 200000,
      priceIndex: 1,
      pool: 18000,
      bankRunDays: 0,
      marketClosedDays: 0,
      ledger: { minted: 0, burned: 0 },
    },
    players: [0, 1, 2, 3].map((seat) => demoPlayer(seat as SeatIndex, def.stocks.length)),
    villains: (['thief', 'robber', 'thug', 'spy'] as const).map((kind) => {
      const home = kind === 'thief' || kind === 'robber' ? 'jail' : 'hospital';
      const node = home === 'jail' ? map.jailHold : map.hospitalHold;
      return {
        kind,
        home,
        onBoard: kind === 'thief',
        node: kind === 'thief' ? 13 : node,
        prevNode: kind === 'thief' ? 12 : node,
        homeNode: node,
        leftHome: kind === 'thief',
        employer: kind === 'thief' ? (1 as SeatIndex) : null,
        st: { jail: 0, hospital: 0, hibernate: 0, sleepwalk: 0, stay: 0, tortoise: 0 },
      };
    }),
    lands: def.lots
      .filter((l): l is LandLot => l.kind === 'land')
      .map((l) => ({
        id: l.id as `L${number}`,
        owner: owners[l.id]?.owner ?? null,
        level: owners[l.id]?.level ?? 0,
        chain: false,
        landPrice: l.landPrice,
        mark: l.id === 'L2' ? { kind: 'raise' as const, days: 3 } : null,
        tenure: 0,
        lastToll: 0,
      })),
    facilities: def.lots
      .filter((l) => l.kind === 'facility')
      .map((l) => ({
        id: l.id as `F${number}`,
        owner: owners[l.id]?.owner ?? null,
        level: owners[l.id]?.level ?? 0,
        type: 'hotel' as FacilityType,
        landPrice: l.landPrice,
        mark: null,
        tenure: 0,
        lastFee: 0,
        research: null,
      })),
    companies: def.companies.map((c) => ({
      id: c.id as `C${number}`,
      stock: c.stockIndex,
      reserved: 10000 - (def.stocks.find((x) => x.index === c.stockIndex)?.float ?? 10000),
      surplusMonth: 3200,
      surplusTotal: 15000,
    })),
    objects: [
      { id: 1, kind: 'roadblock', node: 12, placedBy: 1 },
      { id: 2, kind: 'mine', node: 18, placedBy: null },
    ],
    gods: [
      { slot: 0, kind: 1, where: { t: 'road', node: 3 } },
      { slot: 1, kind: 2, where: { t: 'attached', seat: 0 } },
      { slot: 6, kind: 7, where: { t: 'attached', seat: 3 } },
    ],
    beggars: [],
    stocks,
    pools: { cards: initialDeck(), items: initialItemPool() },
    lottery: { owners: lottery },
    noticeBoard: [],
  };
}

function stockRows(view: GameView, seat: SeatIndex): StockRow[] {
  const p = view.players.find((x) => x.seat === seat)!;
  return view.stocks.map((st, i) => ({
    idx: st.idx,
    priceCents: st.priceCents,
    changePct10: st.prevCents > 0 ? Math.trunc(((st.priceCents - st.prevCents) * 1000) / st.prevCents) : 0,
    quota: p.quota[i] ?? 0,
    float: st.float,
    limitUp: i === 1,
    limitDown: i === 4,
    suspended: st.suspend > 0,
    shares: p.holdings[i]?.shares ?? 0,
    costCents: p.holdings[i]?.costCents ?? 0,
    maxBuy: st.suspend > 0 || i === 1 ? 0 : Math.min(p.quota[i] ?? 0, Math.trunc((p.deposit * 100) / st.priceCents)),
    maxSell: i === 4 ? 0 : (p.holdings[i]?.shares ?? 0),
    chairman: st.chairman,
  }));
}

export function demoTurnMenu(view: GameView, seat: SeatIndex = 0): TurnMenuOptions {
  const p = view.players.find((x) => x.seat === seat)!;
  const others = view.players.filter((x) => x.seat !== seat).map((x) => x.seat);
  const cardTargets: Partial<Record<number, TargetCandidates>> = {
    [CARD.EQUAL_POVERTY]: { t: 'seat', seats: others },
    [CARD.ANGEL]: { t: 'lot', lots: ['L1', 'L3', 'F1'], needType: [] },
    [CARD.ROB]: {
      t: 'rob',
      victims: [
        {
          seat: 1,
          cards: [
            { slot: 0, card: CARD.FRAME },
            { slot: 1, card: CARD.DEMOLISH },
          ],
          items: [{ item: ITEM.MINE, count: 1 }],
        },
      ],
    },
    [CARD.STAY]: {
      t: 'actor',
      actors: [
        { t: 'seat', seat: 0 },
        { t: 'seat', seat: 1 },
        { t: 'villain', kind: 'thief' },
      ],
    },
    [CARD.RED]: { t: 'stock', stocks: view.stocks.map((s) => s.idx) },
    [CARD.TORTOISE]: { t: 'actor', actors: [{ t: 'seat', seat: 1 }] },
  };
  return {
    dice: { allowed: [1, 2], current: p.diceCount, locked: null },
    cards: (p.cards ?? []).map((card, slot) => {
      const targets = cardTargets[card];
      const passive = card === CARD.FREE;
      return {
        slot,
        card,
        usable: !passive && targets !== undefined,
        reason: passive ? 'passive' : targets === undefined ? 'noTarget' : null,
        targets: targets ?? { t: 'none' },
      };
    }),
    items: [
      { item: ITEM.ROADBLOCK, count: 2, usable: true, reason: null, targets: { t: 'node', nodes: [4, 6, 8, 9] } },
      {
        item: ITEM.REMOTE_DICE,
        count: 1,
        usable: true,
        reason: null,
        targets: { t: 'dice', values: [1, 2, 3, 4, 5, 6] },
      },
      { item: ITEM.TIME_MACHINE, count: 1, usable: false, reason: 'noAnchor', targets: { t: 'none' } },
      {
        item: ITEM.TELEPORTER,
        count: 1,
        usable: true,
        reason: null,
        targets: {
          t: 'teleport',
          sources: [
            { k: 'actor', actor: { t: 'seat', seat: 0 } },
            { k: 'actor', actor: { t: 'seat', seat: 1 } },
            { k: 'object', object: 1 },
          ],
          roads: [2, 3, 9, 16],
          lands: ['L3'],
        },
      },
    ],
    stock: { open: true, reason: null, rows: stockRows(view, seat), deposit: p.deposit },
    board: {
      listings: [
        { id: 1, seller: 1, price: 5200, asset: { t: 'lot', lot: 'L2' }, mine: false, affordable: true },
        { id: 2, seller: 0, price: 800, asset: { t: 'card', card: CARD.TORTOISE }, mine: true, affordable: true },
        {
          id: 3,
          seller: 3,
          price: 99000,
          asset: { t: 'stock', stock: 2, shares: 500 },
          mine: false,
          affordable: false,
        },
      ],
      mine: 1,
      canList: true,
      lotCaps: [
        { lot: 'L1', cap: 9000 },
        { lot: 'L5', cap: 14000 },
      ],
    },
    canSurrender: true,
    timeMachine: { usable: false, anchorTurn: null },
    turnLog: ['stockBuy'],
    menuActions: { used: 3, limit: 40 },
  };
}

/** 23 种决策各一份 options（seat 为「我」） */
export function demoOptions(view: GameView, seat: SeatIndex = 0): { [K in DecisionKind]: DecisionOptionsMap[K] } {
  const p = view.players.find((x) => x.seat === seat)!;
  const lot = (id: string): LotId => id as LotId;
  return {
    TURN_MENU: demoTurnMenu(view, seat),
    BANK_ATM: { mode: 'stop', cash: p.cash, deposit: p.deposit, canWithdraw: true, reserveShortfallPayer: 3 },
    BANK_COUNTER: {
      cash: p.cash,
      deposit: p.deposit,
      loan: 20000,
      loanDue: 19980520,
      loanLimit: 180000,
      loanBlocked: null,
      dueDatePreview: 19980610,
      repayMax: 20000,
      financeLimit: 75000,
      finance: 0,
    },
    BUY_LAND: {
      lot: 'L3',
      price: 2000,
      cash: p.cash,
      level: 0,
      street: { lots: ['L1', 'L2', 'L3'], owners: [0, 1, null] },
      tollAfter: 400,
      fortuneBonus: false,
    },
    UPGRADE_LAND: { lot: 'L1', cost: 500, cash: p.cash, fromLevel: 2, toLevel: 3, tollBefore: 2500, tollAfter: 6000 },
    BUY_FACILITY: { lot: 'F1', price: 4000, cash: p.cash, level: 0, type: 'park', fortuneBonus: true },
    BUILD_FACILITY: {
      lot: 'F1',
      cost: 800,
      cash: p.cash,
      types: [
        { type: 'park', cap: 1, feePreview: 0 },
        { type: 'hotel', cap: 5, feePreview: 600 },
        { type: 'mall', cap: 5, feePreview: 600 },
        { type: 'gas', cap: 1, feePreview: 600 },
        { type: 'lab', cap: 5, feePreview: 0 },
      ],
    },
    UPGRADE_FACILITY: {
      lot: 'F1',
      type: 'hotel',
      cost: 800,
      cash: p.cash,
      fromLevel: 2,
      toLevel: 3,
      cap: 5,
    },
    FACILITY_TYPE: {
      lot: 'F1',
      types: [
        { type: 'park', cap: 1, feePreview: 0 },
        { type: 'hotel', cap: 5, feePreview: 600 },
        { type: 'mall', cap: 5, feePreview: 600 },
        { type: 'gas', cap: 1, feePreview: 600 },
        { type: 'lab', cap: 5, feePreview: 0 },
      ],
    },
    RESEARCH: {
      lot: 'F1',
      level: 3,
      current: { project: 1, days: 2 },
      projects: [
        { project: 1, item: ITEM.ROBOT_WORKER, days: 5 },
        { project: 2, item: ITEM.TIME_MACHINE, days: 5 },
        { project: 3, item: ITEM.TELEPORTER, days: 5 },
      ],
    },
    SHOP: {
      points: p.points,
      handCount: p.cardCount,
      handMax: 15,
      shelf: [
        { idx: 0, card: CARD.EQUAL_WEALTH, price: 200, buyable: p.points >= 200 },
        { idx: 1, card: CARD.SWAP_LAND, price: 25, buyable: true },
        { idx: 2, card: CARD.DEVIL, price: 180, buyable: p.points >= 180 },
        { idx: 3, card: CARD.SUMMON_GOD, price: 20, buyable: true },
        { idx: 4, card: CARD.TAX_AUDIT, price: 35, buyable: true },
        { idx: 5, card: CARD.ALLIANCE, price: 40, buyable: true },
        { idx: 6, card: CARD.HIBERNATE, price: 100, buyable: false },
      ],
      fullDeck: false,
      items: [
        { item: ITEM.ROBOT_DOLL, price: 15, pool: 8, own: 0, maxQty: 9 },
        { item: ITEM.ROADBLOCK, price: 30, pool: 6, own: 2, maxQty: 6 },
        { item: ITEM.MINE, price: 25, pool: 0, own: 0, maxQty: 0 },
        { item: ITEM.MOTORCYCLE, price: 80, pool: 10, own: 0, maxQty: 4 },
        { item: ITEM.CAR, price: 150, pool: 9, own: 0, maxQty: 2 },
        { item: ITEM.MISSILE, price: 100, pool: 10, own: 0, maxQty: 3 },
      ],
      sell: {
        cards: (p.cards ?? []).map((card, slot) => ({ slot, card, value: Math.trunc((cardDef(card).price * 9) / 10) })),
        items: [
          { item: ITEM.ROADBLOCK, count: 2, unitValue: 27 },
          { item: ITEM.REMOTE_DICE, count: 1, unitValue: 27 },
        ],
      },
      visit: { entryPoints: p.points, trades: [], remaining: 60 },
    },
    LOTTERY: { cash: p.cash, price: 1000, sold: view.lottery.owners.slice(), pool: view.econ.pool },
    BAIL: {
      where: 'jail',
      points: p.points,
      inmates: [{ seat: 2, remaining: 3 }],
      villains: [
        { kind: 'thief', available: false },
        { kind: 'robber', available: true },
      ],
      costs: { bail: 30, hire: 300 },
    },
    MINIGAME: { minigameId: 'penguin', maxScore: 188 },
    MAGIC_CAST: { condition: 0, targets: [3, 1], effects: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
    CONSTRUCTION_PICK: {
      company: 'C2',
      chairman: false,
      levels: 1,
      lots: [
        { lot: 'L1', level: 2, cost: 2000, rent: 2500 },
        { lot: 'L5', level: 4, cost: 1200, rent: 7200 },
        { lot: 'F1', level: 1, cost: 4000, rent: 0 },
      ],
      canSkip: true,
    },
    SUBSCRIBE_SHARES: { company: 'C1', stock: 0, unitPrice: 80, max: 1000, cash: p.cash, reserved: 0 },
    USE_FREE_CARD: { context: 'toll', amount: 6000, payer: seat, lot: lot('L2'), slot: 4 },
    SCAPEGOAT: { context: 'frame', amount: null, days: 5, candidates: [1, 2, 3], slot: 0 },
    AUCTION_BID: {
      lot: 'L4',
      level: 1,
      seller: 2,
      start: 1800,
      price: 2300,
      leader: 1,
      increments: [100, 500, 1000, 5000, 10000],
      cash: p.cash,
    },
    BIRTHDAY_PICK: {
      victims: [
        {
          seat: 1,
          cards: [
            { slot: 0, card: CARD.FRAME },
            { slot: 1, card: CARD.DEMOLISH },
            { slot: 2, card: CARD.BUY_LAND },
          ],
        },
        { seat: 2, cards: [{ slot: 0, card: CARD.SLEEPWALK }] },
        { seat: 3, cards: [] },
      ],
    },
    DISCARD_CARD: {
      hand: (p.cards ?? []).map((card, slot) => ({ slot, card, price: [200, 160, 25, 20, 25, 50, 70][slot] ?? 20 })),
      incoming: CARD.MONSTER,
    },
    DEATH_GOD_TARGET: { candidates: [1, 2, 3] },
  };
}

/** 组装 DecisionForYou（deadlineAt = now + timeoutMs；timeoutMs 为 null 表示不限时） */
export function makeDecision<K extends DecisionKind>(
  kind: K,
  options: DecisionOptionsMap[K],
  o: { seat?: SeatIndex; id?: string; now?: number; timeoutMs?: number | null; minigame?: unknown } = {},
): DecisionForYou<K> {
  const seat = o.seat ?? 0;
  const now = o.now ?? Date.now();
  const timeout = o.timeoutMs === undefined ? 30_000 : o.timeoutMs;
  const d: DecisionForYou<K> = {
    decisionId: o.id ?? `d-${kind}`,
    seat,
    kind,
    timing: DECISION_TIMING_CLASS[kind],
    options,
    defaultIntent: defaultIntentFor(kind, options, seat),
    deadlineAt: timeout === null ? null : now + timeout,
  };
  if (o.minigame !== undefined) d.minigame = o.minigame;
  return d;
}

export function demoDecisions(
  view: GameView,
  o: { seat?: SeatIndex; now?: number; timeoutMs?: number | null } = {},
): { [K in DecisionKind]: DecisionForYou<K> } {
  const opts = demoOptions(view, o.seat ?? 0);
  const out = {} as { [K in DecisionKind]: DecisionForYou<K> };
  for (const kind of DECISION_KINDS) {
    const extra = kind === 'MINIGAME' ? { minigame: { startsAt: (o.now ?? Date.now()) + 3000, sessionId: 'dev' } } : {};
    (out as Record<DecisionKind, unknown>)[kind] = makeDecision(kind, opts[kind], { ...o, ...extra });
  }
  return out;
}
