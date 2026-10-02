/**
 * stubEngine：12 格环形棋盘的迷你规则，完整实现 EngineApi 契约（design/net.md §11.1），服务端开发不必等真实引擎。
 *
 * 棋盘（格号 1..12，顺时针）：1 起点；2/3、5/6、8/9、11/12 为四条街的住宅地 L1..L8；4 拍卖格；7 小游戏格（企鹅）；10 卡片格。
 * 规则：
 * - TURN_MENU：ROLL（1 颗骰子）为终结操作；STOCK_BUY/STOCK_SELL（只有 1 支股票）为非终结操作，
 *   以新 id、相同 budgetKey 重发 TURN_MENU，本回合超过 MENU_ACTION_LIMIT 次抛 MENU_LIMIT。
 * - 住宅地：无主且买得起 → BUY_LAND；自己的 → UPGRADE_LAND（最高 3 级）；别人的 → 收租（同街两块同主 ×2），付不起即破产。
 * - 拍卖格：随机一块无主地起拍，所有在场座位并发 AUCTION_BID；出价后其余人以新 id 重新询问；PASS/QUIT 退出；
 *   没人待决时成交或流拍。
 * - 小游戏格：controller=human 且 minigames='play' 时发 MINIGAME 决策（只允许 MINIGAME_DECLINE，系统 action
 *   MINIGAME_RESULT 结算）；电脑座位直接走不玩分支（50 + rand15()%20）。
 * - 卡片格：抽 1 张卡（CARD_GAINED 为 redactHand 事件，用来测私密模式脱敏）。
 * - 每个事件都带 post（对公开世界做实体级 diff）；天数推进发 DAY_ADVANCED + DAY_END；限时、破产、真人全出局结束。
 * - 确定性：只用 state.secret.rng（xoshiro）；SYS_DEBUG forceNext{purpose:'dice'} 可指定点数。
 */
import { type DataRegistry, fixtureRegistry } from '@rich4/shared/data';
import {
  AI_PRESET_PERSONALITY,
  type AiTraits,
  type AuctionBidOptions,
  type CardId,
  type DecisionKind,
  type DecisionOptionsMap,
  type DiceFace,
  type EngineApi,
  EngineRuleError,
  type FrameOf,
  type GameAction,
  type GameConfig,
  type GameEvent,
  type GameResult,
  type GameState,
  isIntentAllowed,
  isSystemAction,
  type LandLotId,
  type LandState,
  type LotLevel,
  MENU_ACTION_LIMIT,
  type PendingDecision,
  type PlayerIntent,
  type PlayerSetup,
  type PlayerState,
  type PostPatch,
  type RandPurpose,
  type SeatIndex,
  STATE_SCHEMA_VERSION,
  type SystemAction,
  type TurnMenuOptions,
  timingOf,
  turnMenuBudgetKey,
} from '@rich4/shared/engine';
import { seedFromHex, xoshiroNext32, xoshiroRand15 } from '@rich4/shared/util';

export const STUB_ENGINE_VERSION = '0.0.0-stub';
export const STUB_TILES = 12;
export const AUCTION_TILE = 4;
export const MINIGAME_TILE = 7;
export const CARD_TILE = 10;
export const HAND_MAX = 15;
export const STUB_STOCK_PRICE_CENTS = 1000;

interface LandSquare {
  tile: number;
  lot: LandLotId;
  street: string;
  price: number;
}

export const STUB_LANDS: readonly LandSquare[] = Object.freeze([
  { tile: 2, lot: 'L1', street: 'A', price: 1000 },
  { tile: 3, lot: 'L2', street: 'A', price: 1200 },
  { tile: 5, lot: 'L3', street: 'B', price: 1400 },
  { tile: 6, lot: 'L4', street: 'B', price: 1600 },
  { tile: 8, lot: 'L5', street: 'C', price: 1800 },
  { tile: 9, lot: 'L6', street: 'C', price: 2000 },
  { tile: 11, lot: 'L7', street: 'D', price: 2200 },
  { tile: 12, lot: 'L8', street: 'D', price: 2400 },
] as LandSquare[]);

/** 各级过路费占地价的百分比 */
const TOLL_PCT = [30, 60, 100, 150] as const;
const MAX_LEVEL = 3;
const BID_INCS = [100, 500, 1000] as const;

const landAtTile = (tile: number) => STUB_LANDS.find((l) => l.tile === tile);
const landDef = (lot: string) => STUB_LANDS.find((l) => l.lot === lot)!;

function fail(rule: string, msg?: string): never {
  throw new EngineRuleError(rule, msg);
}

// ───────────────────────── 事件与 post ─────────────────────────

type Snap = {
  players: Record<number, Record<string, string>>;
  lands: Record<string, Record<string, string>>;
  stocks: Record<number, Record<string, string>>;
  clock: Record<string, string>;
  econ: Record<string, string>;
  pools: string;
  lottery: string;
  status: string;
  result: string;
};

function fields(o: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) out[k] = JSON.stringify(v);
  return out;
}

function snap(s: GameState): Snap {
  const players: Snap['players'] = {};
  for (const p of s.players) players[p.seat] = fields(p);
  const lands: Snap['lands'] = {};
  for (const l of s.lands) lands[l.id] = fields(l);
  const stocks: Snap['stocks'] = {};
  for (const st of s.stocks) stocks[st.idx] = fields(st);
  return {
    players,
    lands,
    stocks,
    clock: fields(s.clock),
    econ: fields(s.econ),
    pools: JSON.stringify(s.pools),
    lottery: JSON.stringify(s.lottery),
    status: JSON.stringify(s.status),
    result: JSON.stringify(s.result),
  };
}

function changed<T extends object>(prev: Record<string, string> | undefined, cur: T): Partial<T> | null {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [k, v] of Object.entries(cur)) {
    const j = JSON.stringify(v);
    if (!prev || prev[k] !== j) {
      out[k] = structuredClone(v);
      any = true;
    }
  }
  return any ? (out as Partial<T>) : null;
}

function diff(prev: Snap, s: GameState): PostPatch | null {
  const post: PostPatch = {};
  const players = s.players
    .map((p) => ({ seat: p.seat, set: changed(prev.players[p.seat], p) }))
    .filter((x) => x.set !== null);
  if (players.length) post.players = players as NonNullable<PostPatch['players']>;
  const lands = s.lands.map((l) => ({ id: l.id, set: changed(prev.lands[l.id], l) })).filter((x) => x.set !== null);
  if (lands.length) post.lands = lands as NonNullable<PostPatch['lands']>;
  const stocks = s.stocks
    .map((st) => ({ idx: st.idx, set: changed(prev.stocks[st.idx], st) }))
    .filter((x) => x.set !== null);
  if (stocks.length) post.stocks = stocks as NonNullable<PostPatch['stocks']>;
  const clock = changed(prev.clock, s.clock);
  if (clock) post.clock = clock;
  const econ = changed(prev.econ, s.econ);
  if (econ) post.econ = econ;
  if (JSON.stringify(s.pools) !== prev.pools) post.pools = structuredClone(s.pools);
  if (JSON.stringify(s.lottery) !== prev.lottery) post.lottery = structuredClone(s.lottery);
  if (JSON.stringify(s.status) !== prev.status) post.status = s.status;
  if (JSON.stringify(s.result) !== prev.result) post.result = structuredClone(s.result);
  return Object.keys(post).length > 0 ? post : null;
}

type EventInput = GameEvent extends infer E ? (E extends GameEvent ? Omit<E, 'post'> : never) : never;

class Ctx {
  readonly events: GameEvent[] = [];
  private last: Snap;

  constructor(readonly s: GameState) {
    this.last = snap(s);
  }

  emit(e: EventInput): void {
    const post = diff(this.last, this.s);
    this.last = snap(this.s);
    this.events.push((post ? { ...e, post } : e) as GameEvent);
  }

  /** action 结束时公布未经事件公布的变化 */
  flush(): void {
    const post = diff(this.last, this.s);
    if (post) this.events.push({ type: 'SYNC', reason: 'flush', post });
    this.last = snap(this.s);
  }

  player(seat: SeatIndex): PlayerState {
    const p = this.s.players.find((x) => x.seat === seat);
    if (!p) fail('BAD_SEAT', `seat ${seat}`);
    return p;
  }

  land(lot: string): LandState {
    return this.s.lands.find((l) => l.id === lot)!;
  }

  /** SYS_DEBUG forceNext 预置的语义结果（按 purpose 出队）；没有则 null */
  forced(purpose: RandPurpose): number | null {
    const q = this.s.secret.debugQueue;
    const i = q.findIndex((x) => x.purpose === purpose && x.values.length > 0);
    if (i < 0) return null;
    const v = q[i]!.values.shift()!;
    if (q[i]!.values.length === 0) q.splice(i, 1);
    return v;
  }

  rand15(): number {
    return xoshiroRand15(this.s.secret.rng);
  }

  /** 1..6；forceNext{purpose:'dice'} 可以指定 */
  dice(): DiceFace {
    const f = this.forced('dice');
    if (f !== null && f >= 1 && f <= 6) return f as DiceFace;
    return ((this.rand15() % 6) + 1) as DiceFace;
  }
}

// ───────────────────────── 构造 ─────────────────────────

function traitsFor(ps: PlayerSetup): AiTraits {
  const base: AiTraits = { personality: 1, useCards: true, useItems: true, loanRatio: 0, cashRatio: 50, stockRatio: 0 };
  const preset = ps.ai?.preset ?? 'character';
  const personality = AI_PRESET_PERSONALITY[preset];
  return { ...base, ...(personality === null ? {} : { personality }), ...(ps.ai?.overrides ?? {}) };
}

function newPlayer(ps: PlayerSetup, cash: number): PlayerState {
  return {
    seat: ps.seat,
    character: ps.character,
    controller: ps.controller,
    aiTraits: traitsFor(ps),
    alive: true,
    out: null,
    cash,
    deposit: 0,
    loan: 0,
    loanDue: 0,
    finance: 0,
    points: 0,
    placed: true,
    node: 1,
    prevNode: STUB_TILES,
    savedPrevNode: null,
    vehicle: 'walk',
    diceCount: 1,
    engineer: null,
    st: { hotel: 0, away: 0, jail: 0, hospital: 0, hibernate: 0, sleepwalk: 0, stay: 0, tortoise: 0 },
    returning: false,
    bankReject: 0,
    insuranceDays: 0,
    alliance: null,
    god: null,
    bomb: null,
    luck: { bad: 0, wealth: 0, fortune: 0 },
    hostility: [0, 0, 0, 0],
    cards: [],
    items: new Array<number>(14).fill(0),
    holdings: [{ shares: 0, costCents: 0 }],
    quota: [1000],
    monthly: { loss: 0, gain: 0, badDays: 0, interest: 0 },
    turn: freshTurn(),
  };
}

function freshTurn(): PlayerState['turn'] {
  return { forcedSteps: null, teleportedSelf: false, cardsUsed: 0, itemsUsed: 0, menuActions: 0, log: [] };
}

function shuffled(n: number, rng: GameState['secret']['rng']): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = xoshiroNext32(rng) % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function nextDate(d: number): number {
  let y = Math.trunc(d / 10000);
  let m = Math.trunc(d / 100) % 100;
  let day = (d % 100) + 1;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const len = m === 2 && leap ? 29 : MONTH_DAYS[m - 1]!;
  if (day > len) {
    day = 1;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return y * 10000 + m * 100 + day;
}

/** 蔡勒公式：0 = 星期日 */
function weekdayOf(d: number): GameState['clock']['weekday'] {
  let y = Math.trunc(d / 10000);
  let m = Math.trunc(d / 100) % 100;
  const q = d % 100;
  if (m < 3) {
    m += 12;
    y--;
  }
  const k = y % 100;
  const j = Math.trunc(y / 100);
  const h = (q + Math.trunc((13 * (m + 1)) / 5) + k + Math.trunc(k / 4) + Math.trunc(j / 4) + 5 * j) % 7;
  return ((h + 6) % 7) as GameState['clock']['weekday'];
}

// ───────────────────────── 决策 ─────────────────────────

function ask<K extends DecisionKind>(
  ctx: Ctx,
  seat: SeatIndex,
  kind: K,
  options: DecisionOptionsMap[K],
  defaultIntent: PlayerIntent,
  extra: { lot?: string; amount?: number; budgetKey?: string; minigame?: PendingDecision['minigame'] } = {},
): void {
  const s = ctx.s;
  s.counters.decision++;
  const d: PendingDecision<K> = {
    id: `d${s.counters.decision}`,
    frameId: s.flow.at(-1)?.fid ?? 0,
    seat,
    kind,
    options,
    publicInfo: {
      kind,
      seat,
      lot: (extra.lot as PendingDecision['publicInfo']['lot']) ?? null,
      amount: extra.amount ?? null,
      labelKey: null,
    },
    defaultIntent,
    timing: timingOf(kind),
    budgetKey: extra.budgetKey ?? null,
    minigame: extra.minigame ?? null,
  };
  s.pending.push(d as PendingDecision);
}

function turnMenu(ctx: Ctx, seat: SeatIndex): void {
  const s = ctx.s;
  const p = ctx.player(seat);
  const st = s.stocks[0]!;
  const maxBuy = Math.min(p.quota[0] ?? 0, Math.trunc((p.cash * 100) / st.priceCents));
  const options: TurnMenuOptions = {
    dice: { allowed: [1], current: 1, locked: null },
    cards: p.cards.map((card, slot) => ({ slot, card, usable: false, reason: 'passive', targets: { t: 'none' } })),
    items: [],
    stock: {
      open: true,
      reason: null,
      rows: [
        {
          idx: 0,
          priceCents: st.priceCents,
          changePct10: 0,
          quota: p.quota[0] ?? 0,
          float: st.float,
          limitUp: false,
          limitDown: false,
          suspended: false,
          shares: p.holdings[0]?.shares ?? 0,
          costCents: p.holdings[0]?.costCents ?? 0,
          maxBuy,
          maxSell: p.holdings[0]?.shares ?? 0,
          chairman: st.chairman,
        },
      ],
      deposit: p.deposit,
    },
    board: { listings: [], mine: 0, canList: false, lotCaps: [] },
    canSurrender: false,
    timeMachine: { usable: false, anchorTurn: null },
    turnLog: [...p.turn.log],
    menuActions: { used: p.turn.menuActions, limit: MENU_ACTION_LIMIT },
  };
  ask(ctx, seat, 'TURN_MENU', options, { type: 'ROLL' }, { budgetKey: turnMenuBudgetKey(s.clock.turnNo, seat) });
}

function removePending(s: GameState, id: string): void {
  const i = s.pending.findIndex((d) => d.id === id);
  if (i >= 0) s.pending.splice(i, 1);
}

// ───────────────────────── 流程 ─────────────────────────

function netWorth(s: GameState, p: PlayerState): number {
  let w = p.cash + p.deposit - p.loan;
  for (const l of s.lands) if (l.owner === p.seat) w += l.landPrice * (1 + l.level);
  w += Math.trunc(((p.holdings[0]?.shares ?? 0) * (s.stocks[0]?.priceCents ?? 0)) / 100);
  return w;
}

function finish(ctx: Ctx, reason: GameResult['reason']): void {
  const s = ctx.s;
  const ranking = s.players
    .map((p) => ({ seat: p.seat, netWorth: p.alive ? netWorth(s, p) : 0, alive: p.alive }))
    .sort((a, b) => Number(b.alive) - Number(a.alive) || b.netWorth - a.netWorth || a.seat - b.seat);
  const humans = s.players.filter((p) => p.controller === 'human');
  const winner = ranking[0]?.alive ? ranking[0].seat : null;
  const humanAlive = humans.some((p) => p.alive);
  const result: GameResult = {
    reason,
    code: !humanAlive ? 1 : humans.length <= 1 ? 2 : 3,
    winner,
    date: s.clock.date,
    elapsedDays: s.clock.elapsedDays,
    ranking,
  };
  s.status = 'over';
  s.result = result;
  s.pending = [];
  s.flow = [];
  ctx.emit({ type: 'GAME_OVER', result });
}

function checkOver(ctx: Ctx): boolean {
  const s = ctx.s;
  if (s.status === 'over') return true;
  const alive = s.players.filter((p) => p.alive);
  if (alive.length <= 1) {
    finish(ctx, 'lastStanding');
    return true;
  }
  const hadHumans = s.players.some((p) => p.controller === 'human');
  if (s.config.rules.endWhenNoHumans && hadHumans && !alive.some((p) => p.controller === 'human')) {
    finish(ctx, 'noHumansLeft');
    return true;
  }
  return false;
}

function startTurn(ctx: Ctx, seat: SeatIndex): void {
  const s = ctx.s;
  s.clock.turnNo++;
  s.clock.cursor = { t: 'seat', seat };
  const p = ctx.player(seat);
  p.turn = freshTurn();
  p.quota = [1000];
  ctx.emit({ type: 'TURN_STARTED', actor: { t: 'seat', seat }, turnNo: s.clock.turnNo });
  turnMenu(ctx, seat);
}

function advanceDay(ctx: Ctx): boolean {
  const s = ctx.s;
  s.clock.date = nextDate(s.clock.date);
  s.clock.weekday = weekdayOf(s.clock.date);
  s.clock.elapsedDays++;
  ctx.emit({ type: 'DAY_ADVANCED', date: s.clock.date, weekday: s.clock.weekday, elapsed: s.clock.elapsedDays });
  ctx.emit({ type: 'DAY_END', date: s.clock.date, elapsed: s.clock.elapsedDays });
  const limit = s.config.timeLimitDays;
  if (limit > 0 && s.clock.elapsedDays >= limit) {
    finish(ctx, 'timeLimit');
    return true;
  }
  const target = s.config.winMultiple * s.config.initialFund;
  if (target > 0 && s.players.some((p) => p.alive && netWorth(s, p) >= target)) {
    finish(ctx, 'wealthTarget');
    return true;
  }
  return false;
}

function endTurn(ctx: Ctx): void {
  const s = ctx.s;
  const cur = s.clock.cursor.t === 'seat' ? s.clock.cursor.seat : 0;
  ctx.emit({ type: 'TURN_ENDED', actor: { t: 'seat', seat: cur } });
  if (checkOver(ctx)) return;
  const alive = s.players.filter((p) => p.alive).map((p) => p.seat);
  const next = alive.find((x) => x > cur) ?? alive[0]!;
  if (next <= cur && advanceDay(ctx)) return;
  startTurn(ctx, next);
}

function bankrupt(ctx: Ctx, seat: SeatIndex, creditor: SeatIndex, lot: string): void {
  const s = ctx.s;
  const p = ctx.player(seat);
  p.alive = false;
  p.out = 'bankrupt';
  p.cash = 0;
  for (const l of s.lands) {
    if (l.owner === seat) {
      l.owner = null;
      l.level = 0;
    }
  }
  s.pending = s.pending.filter((d) => d.seat !== seat);
  ctx.emit({
    type: 'BANKRUPT',
    seat,
    cause: { k: 'toll', ref: lot, by: creditor },
    creditor: { t: 'seat', seat: creditor },
  });
}

function tollOf(s: GameState, land: LandState): number {
  const def = landDef(land.id);
  const street = STUB_LANDS.filter((l) => l.street === def.street);
  const full = street.every((l) => s.lands.find((x) => x.id === l.lot)?.owner === land.owner);
  return Math.trunc((land.landPrice * TOLL_PCT[land.level as 0 | 1 | 2 | 3]) / 100) * (full ? 2 : 1);
}

function payToll(ctx: Ctx, seat: SeatIndex, land: LandState): boolean {
  const s = ctx.s;
  const owner = land.owner!;
  const payer = ctx.player(seat);
  const recv = ctx.player(owner);
  const amount = tollOf(s, land);
  const paid = Math.min(amount, Math.max(0, payer.cash));
  payer.cash -= paid;
  recv.cash += paid;
  land.lastToll = paid;
  ctx.emit({
    type: 'TOLL_PAID',
    payer: seat,
    owner,
    ally: null,
    amount: paid,
    allyAmount: 0,
    lots: [land.id],
    mods: [],
  });
  if (paid < amount) {
    bankrupt(ctx, seat, owner, land.id);
    return false;
  }
  return true;
}

function settleMinigame(ctx: Ctx, seat: SeatIndex, mode: 'played' | 'skipped', score: number): void {
  const p = ctx.player(seat);
  const speechSlot = mode === 'skipped' ? ((ctx.rand15() & 1) as 0 | 1) : null;
  p.points = Math.min(65535, p.points + score);
  ctx.emit({ type: 'MINIGAME_ENDED', seat, minigameId: 'penguin', mode, score, speechSlot });
}

function skipScore(ctx: Ctx): number {
  return 50 + (ctx.rand15() % 20);
}

function land(ctx: Ctx, seat: SeatIndex): void {
  const s = ctx.s;
  const p = ctx.player(seat);
  const tile = p.node;
  const sq = landAtTile(tile);
  if (sq) {
    const l = ctx.land(sq.lot);
    if (l.owner === null) {
      if (p.cash >= l.landPrice) {
        const street = STUB_LANDS.filter((x) => x.street === sq.street).map((x) => x.lot);
        ask(
          ctx,
          seat,
          'BUY_LAND',
          {
            lot: l.id,
            price: l.landPrice,
            cash: p.cash,
            level: l.level,
            street: { lots: street, owners: street.map((id) => ctx.land(id).owner) },
            tollAfter: Math.trunc((l.landPrice * TOLL_PCT[0]) / 100),
            fortuneBonus: false,
          },
          { type: 'DECLINE' },
          { lot: l.id, amount: l.landPrice },
        );
        return;
      }
      ctx.emit({ type: 'CANNOT_AFFORD', seat, lot: l.id, price: l.landPrice });
    } else if (l.owner === seat) {
      const cost = Math.trunc(l.landPrice / 2);
      if (l.level < MAX_LEVEL && p.cash >= cost) {
        const to = (l.level + 1) as LotLevel;
        ask(
          ctx,
          seat,
          'UPGRADE_LAND',
          {
            lot: l.id,
            cost,
            cash: p.cash,
            fromLevel: l.level,
            toLevel: to,
            tollBefore: tollOf(s, l),
            tollAfter: Math.trunc((l.landPrice * TOLL_PCT[to as 0 | 1 | 2 | 3]) / 100),
          },
          { type: 'DECLINE' },
          { lot: l.id, amount: cost },
        );
        return;
      }
    } else if (ctx.player(l.owner).alive) {
      if (!payToll(ctx, seat, l)) {
        if (checkOver(ctx)) return;
        // 破产者的回合直接结束
      }
    }
  } else if (tile === AUCTION_TILE) {
    const free = s.lands.filter((l) => l.owner === null);
    if (free.length > 0) {
      startAuction(ctx, free[ctx.rand15() % free.length]!);
      if (s.pending.length > 0) return;
    }
  } else if (tile === MINIGAME_TILE) {
    if (p.controller === 'human' && s.config.minigames === 'play') {
      ctx.emit({ type: 'MINIGAME_STARTED', seat, minigameId: 'penguin' });
      ask(
        ctx,
        seat,
        'MINIGAME',
        { minigameId: 'penguin', maxScore: 188 },
        { type: 'MINIGAME_DECLINE' },
        { minigame: { minigameId: 'penguin', seed: xoshiroNext32(s.secret.rng), params: { ruleset: 'exe311' } } },
      );
      return;
    }
    ctx.emit({ type: 'MINIGAME_STARTED', seat, minigameId: 'penguin' });
    settleMinigame(ctx, seat, 'skipped', skipScore(ctx));
  } else if (tile === CARD_TILE) {
    if (p.cards.length < HAND_MAX) {
      const card = ((ctx.rand15() % 30) + 1) as CardId;
      p.cards.push(card);
      s.pools.cards[card] = Math.max(0, (s.pools.cards[card] ?? 0) - 1);
      ctx.emit({ type: 'CARD_GAINED', seat, card, source: 'square' });
    }
  }
  endTurn(ctx);
}

// ───────────────────────── 拍卖 ─────────────────────────

type AuctionFrame = FrameOf<'AUCTION'>;

function auctionFrame(s: GameState): AuctionFrame | undefined {
  const f = s.flow.at(-1);
  return f && f.k === 'AUCTION' ? f : undefined;
}

function startAuction(ctx: Ctx, l: LandState): void {
  const s = ctx.s;
  s.counters.frame++;
  const start = Math.trunc(l.landPrice / 2);
  const bidders = s.players.filter((p) => p.alive).map((p) => p.seat);
  const f: AuctionFrame = {
    fid: s.counters.frame,
    k: 'AUCTION',
    lot: l.id,
    seller: null,
    source: 'card',
    start,
    price: start,
    leader: null,
    bidders: bidders.map((seat) => ({ seat, st: 'active' })),
    unsold: 'keep',
    stage: 'wait',
  };
  s.flow.push(f);
  ctx.emit({ type: 'AUCTION_STARTED', lot: l.id, seller: null, source: 'card', start, bidders });
  askBidders(ctx, f);
}

function bidOptions(ctx: Ctx, f: AuctionFrame, seat: SeatIndex): AuctionBidOptions {
  const cash = ctx.player(seat).cash;
  const increments: AuctionBidOptions['increments'] = [];
  if (f.leader === null && f.start <= cash) increments.push(0);
  for (const inc of BID_INCS) if ((f.leader === null ? f.start : f.price) + inc <= cash) increments.push(inc);
  return {
    lot: f.lot,
    level: ctx.land(f.lot).level,
    seller: f.seller,
    start: f.start,
    price: f.price,
    leader: f.leader,
    increments,
    cash,
  };
}

function askBidders(ctx: Ctx, f: AuctionFrame): void {
  const s = ctx.s;
  s.pending = s.pending.filter((d) => d.kind !== 'AUCTION_BID');
  for (const b of f.bidders) {
    if (b.st !== 'active' || b.seat === f.leader || !ctx.player(b.seat).alive) continue;
    ask(ctx, b.seat, 'AUCTION_BID', bidOptions(ctx, f, b.seat), { type: 'PASS' }, { lot: f.lot, amount: f.price });
  }
}

function settleAuction(ctx: Ctx, f: AuctionFrame): void {
  const s = ctx.s;
  s.flow.pop();
  const l = ctx.land(f.lot);
  if (f.leader !== null && ctx.player(f.leader).cash >= f.price) {
    ctx.player(f.leader).cash -= f.price;
    l.owner = f.leader;
    ctx.emit({ type: 'AUCTION_ENDED', lot: f.lot, winner: f.leader, price: f.price });
  } else {
    ctx.emit({ type: 'AUCTION_ENDED', lot: f.lot, winner: null, price: f.price });
  }
  endTurn(ctx);
}

// ───────────────────────── 应用 action ─────────────────────────

function applyIntent(ctx: Ctx, a: PlayerIntent & { seat: SeatIndex; decisionId: string }): void {
  const s = ctx.s;
  const d = s.pending.find((x) => x.id === a.decisionId);
  if (!d) fail('STALE_DECISION');
  if (d.seat !== a.seat) fail('NOT_YOUR_DECISION');
  if (!isIntentAllowed(d.kind, a.type)) fail('INTENT_NOT_ALLOWED', `${a.type} for ${d.kind}`);
  const seat = a.seat;
  const p = ctx.player(seat);
  switch (d.kind) {
    case 'TURN_MENU': {
      if (a.type === 'ROLL') {
        if (a.dice !== undefined && a.dice > 1) fail('OUT_OF_RANGE', 'dice');
        removePending(s, d.id);
        const steps = ctx.dice();
        ctx.emit({ type: 'DICE_ROLLED', seat, dice: [steps], steps, forced: false, diceCount: 1 });
        const path: number[] = [];
        let node = p.node;
        for (let i = 0; i < steps; i++) {
          node = (node % STUB_TILES) + 1;
          path.push(node);
        }
        p.prevNode = path.length >= 2 ? path.at(-2)! : p.node;
        p.node = node;
        ctx.emit({ type: 'MOVE_SEGMENT', actor: { t: 'seat', seat }, path, remaining: 0 });
        ctx.emit({ type: 'LANDED', actor: { t: 'seat', seat }, node });
        land(ctx, seat);
        return;
      }
      if (a.type === 'STOCK_BUY' || a.type === 'STOCK_SELL') {
        if (p.turn.menuActions >= MENU_ACTION_LIMIT) fail('MENU_LIMIT');
        if (a.stock !== 0) fail('INVALID_TARGET', 'stock');
        const st = s.stocks[0]!;
        const h = p.holdings[0]!;
        const amount = Math.trunc((a.shares * st.priceCents) / 100);
        if (a.type === 'STOCK_BUY') {
          if (a.shares > (p.quota[0] ?? 0)) fail('OUT_OF_RANGE', 'quota');
          if (amount > p.cash) fail('CANNOT_AFFORD');
          p.cash -= amount;
          h.shares += a.shares;
          h.costCents += a.shares * st.priceCents;
          p.quota[0] = (p.quota[0] ?? 0) - a.shares;
          p.turn.log.push('stockBuy');
        } else {
          if (a.shares > h.shares) fail('OUT_OF_RANGE', 'shares');
          p.cash += amount;
          h.costCents = Math.trunc((h.costCents * (h.shares - a.shares)) / h.shares);
          h.shares -= a.shares;
          p.turn.log.push('stockSell');
        }
        p.turn.menuActions++;
        removePending(s, d.id);
        ctx.emit({
          type: 'STOCK_TRADED',
          seat,
          stock: 0,
          side: a.type === 'STOCK_BUY' ? 'buy' : 'sell',
          shares: a.shares,
          priceCents: st.priceCents,
          amount,
        });
        turnMenu(ctx, seat);
        return;
      }
      fail('NOT_ALLOWED', a.type);
      break;
    }
    case 'BUY_LAND': {
      const o = d.options as DecisionOptionsMap['BUY_LAND'];
      removePending(s, d.id);
      if (a.type === 'CONFIRM') {
        const l = ctx.land(o.lot);
        if (p.cash < l.landPrice) fail('CANNOT_AFFORD');
        p.cash -= l.landPrice;
        l.owner = seat;
        ctx.emit({ type: 'LAND_BOUGHT', seat, lot: l.id, price: l.landPrice });
      }
      endTurn(ctx);
      return;
    }
    case 'UPGRADE_LAND': {
      const o = d.options as DecisionOptionsMap['UPGRADE_LAND'];
      removePending(s, d.id);
      if (a.type === 'CONFIRM') {
        const l = ctx.land(o.lot);
        if (p.cash < o.cost) fail('CANNOT_AFFORD');
        p.cash -= o.cost;
        const from = l.level;
        l.level = o.toLevel;
        ctx.emit({ type: 'LOT_LEVEL', lot: l.id, from, to: l.level, cause: { k: 'system', ref: null, by: seat } });
      }
      endTurn(ctx);
      return;
    }
    case 'AUCTION_BID': {
      const f = auctionFrame(s);
      if (!f) fail('STALE_DECISION', 'no auction');
      const b = f.bidders.find((x) => x.seat === seat)!;
      if (a.type === 'BID') {
        const o = d.options as DecisionOptionsMap['AUCTION_BID'];
        if (!o.increments.includes(a.inc)) fail('OUT_OF_RANGE', 'inc');
        const amount = f.leader === null ? f.start + a.inc : f.price + a.inc;
        if (amount > p.cash) fail('CANNOT_AFFORD');
        f.price = amount;
        f.leader = seat;
        ctx.emit({ type: 'AUCTION_BID', seat, price: amount });
        askBidders(ctx, f);
      } else {
        b.st = a.type === 'PASS' ? 'passed' : 'quit';
        removePending(s, d.id);
        ctx.emit(a.type === 'PASS' ? { type: 'AUCTION_PASS', seat } : { type: 'AUCTION_QUIT', seat });
      }
      if (!s.pending.some((x) => x.kind === 'AUCTION_BID')) settleAuction(ctx, f);
      return;
    }
    case 'MINIGAME': {
      removePending(s, d.id);
      settleMinigame(ctx, seat, 'skipped', skipScore(ctx));
      endTurn(ctx);
      return;
    }
    default:
      fail('NOT_ALLOWED', d.kind);
  }
}

function applySystem(ctx: Ctx, a: SystemAction): void {
  const s = ctx.s;
  switch (a.type) {
    case 'SYS_SET_CONTROLLER':
      ctx.player(a.seat).controller = a.controller;
      ctx.emit({ type: 'CONTROLLER_CHANGED', seat: a.seat, controller: a.controller });
      checkOver(ctx);
      return;
    case 'SYS_SET_AI_TRAITS':
      ctx.player(a.seat).aiTraits = { ...a.traits };
      ctx.emit({ type: 'AI_TRAITS_CHANGED', seat: a.seat });
      return;
    case 'MINIGAME_RESULT': {
      const d = s.pending.find((x) => x.id === a.decisionId);
      if (d?.kind !== 'MINIGAME') fail('STALE_DECISION');
      if (d.seat !== a.seat) fail('NOT_YOUR_DECISION');
      removePending(s, d.id);
      settleMinigame(ctx, a.seat, 'played', Math.max(0, Math.min(188, Math.trunc(a.score))));
      endTurn(ctx);
      return;
    }
    case 'SYS_DEBUG': {
      if (!s.config.debug) fail('NOT_DEBUG');
      const op = a.op;
      switch (op.op) {
        case 'forceNext':
          s.secret.debugQueue.push({ purpose: op.purpose, values: [...op.values] });
          break;
        case 'setCash': {
          const p = ctx.player(op.seat);
          p.cash = op.cash;
          if (op.deposit !== null) p.deposit = op.deposit;
          break;
        }
        case 'setPoints':
          ctx.player(op.seat).points = op.points;
          break;
        case 'teleport':
          if (op.node < 1 || op.node > STUB_TILES) fail('OUT_OF_RANGE', 'node');
          ctx.player(op.seat).node = op.node;
          break;
        case 'give':
          ctx.player(op.seat).cards.push(...op.cards.slice(0, HAND_MAX - ctx.player(op.seat).cards.length));
          break;
        case 'setDate':
          s.clock.date = op.date;
          s.clock.weekday = weekdayOf(op.date);
          break;
        case 'clearBoard':
          break;
      }
      ctx.emit({ type: 'DEBUG_APPLIED', op: op.op });
      return;
    }
  }
}

// ───────────────────────── EngineApi ─────────────────────────

export interface StubEngineOptions {
  registry?: DataRegistry;
}

export function createStubEngine(opts: StubEngineOptions = {}): EngineApi {
  const reg = opts.registry ?? fixtureRegistry;

  function createGame(config: GameConfig, players: PlayerSetup[], seedHex: string): GameState {
    if (players.length < 2 || players.length > 4) throw new Error('stub: 2..4 players');
    const seats = new Set(players.map((p) => p.seat));
    const chars = new Set(players.map((p) => p.character));
    if (seats.size !== players.length || chars.size !== players.length) throw new Error('stub: duplicate seat/char');
    let mapHash = 'stub';
    try {
      mapHash = reg.getMap(config.mapId).def.meta.dataHash;
    } catch {
      // stub 不依赖地图内容
    }
    const rng = seedFromHex(seedHex);
    const sorted = [...players].sort((a, b) => a.seat - b.seat);
    const date = Math.min(Math.max(config.startDate, 19980101), 20100101);
    const s: GameState = {
      v: STATE_SCHEMA_VERSION,
      engine: STUB_ENGINE_VERSION,
      dataRef: { mapId: config.mapId, mapHash, tablesHash: reg.tablesHash },
      config: structuredClone({ ...config, startDate: date }),
      status: 'playing',
      result: null,
      clock: {
        date,
        weekday: weekdayOf(date),
        elapsedDays: 0,
        turnNo: 0,
        cursor: { t: 'seat', seat: sorted[0]!.seat },
        marketOpen: true,
        holiday: null,
      },
      econ: {
        initialFund: config.initialFund,
        priceIndex: 100,
        pool: 0,
        bankRunDays: 0,
        marketClosedDays: 0,
        ledger: { minted: config.initialFund * players.length, burned: 0 },
      },
      players: sorted.map((ps) => newPlayer(ps, config.initialFund)),
      villains: [],
      lands: STUB_LANDS.map((l) => ({
        id: l.lot,
        owner: null,
        level: 0,
        chain: false,
        landPrice: l.price,
        mark: null,
        tenure: 0,
        lastToll: 0,
      })),
      facilities: [],
      companies: [],
      objects: [],
      gods: [],
      beggars: [],
      stocks: [
        {
          idx: 0,
          priceCents: STUB_STOCK_PRICE_CENTS,
          prevCents: STUB_STOCK_PRICE_CENTS,
          openCents: STUB_STOCK_PRICE_CENTS,
          momentum: 0,
          up: 0,
          down: 0,
          suspend: 0,
          float: 100000,
          chairman: null,
          history: [],
        },
      ],
      pools: { cards: [0, ...new Array<number>(30).fill(3)], items: [0, ...new Array<number>(8).fill(10)] },
      lottery: { owners: new Array<null>(36).fill(null) },
      noticeBoard: [],
      flow: [],
      pending: [],
      counters: { action: 0, decision: 0, frame: 0, object: 0, listing: 0 },
      secret: {
        rng,
        newsOrder: shuffled(36, rng) as GameState['secret']['newsOrder'],
        newsCursor: 0,
        fateOrder: shuffled(37, rng) as GameState['secret']['fateOrder'],
        fateCursor: 0,
        timeAnchor: null,
        timeAnchors: [],
        aiSeed: xoshiroNext32(rng),
        debugQueue: [],
      },
    };
    const ctx = new Ctx(s);
    startTurn(ctx, sorted[0]!.seat);
    return s;
  }

  function applyAction(state: GameState, action: GameAction): { state: GameState; events: GameEvent[] } {
    if (state.status === 'over') fail('GAME_OVER');
    const s = structuredClone(state);
    const ctx = new Ctx(s);
    s.counters.action++;
    if (isSystemAction(action)) applySystem(ctx, action);
    else applyIntent(ctx, action);
    ctx.flush();
    return { state: s, events: ctx.events };
  }

  function validateState(x: unknown): x is GameState {
    if (!x || typeof x !== 'object') return false;
    const s = x as Partial<GameState>;
    return (
      s.v === STATE_SCHEMA_VERSION &&
      Array.isArray(s.players) &&
      Array.isArray(s.pending) &&
      Array.isArray(s.lands) &&
      !!s.secret &&
      Array.isArray(s.secret.rng) &&
      s.secret.rng.length === 4
    );
  }

  return {
    ENGINE_VERSION: STUB_ENGINE_VERSION,
    STATE_SCHEMA_VERSION,
    createGame,
    applyAction,
    getPendingDecisions: (s) => (s.status === 'over' ? [] : s.pending.map((d) => d)),
    getResult: (s) => s.result,
    validateState,
    migrateState(state, fromVersion) {
      if (fromVersion !== STATE_SCHEMA_VERSION || !validateState(state)) throw new Error('stub: cannot migrate');
      return state;
    },
  };
}
