// 演出时长不超预算（design/client.md §12.1「timing」；architecture §5.9；original-skin.md U3）：服务器按房间演出节奏的
// EVENT_BUDGET_MS[pacing] 计算截止时间，handler 在 1x 时钟下的实际用时不能超过当前节奏的预算（与 EventPlayer 开发告警同一容差）。
// 两种节奏（original / compact）都要满足；棋盘端口按真实特效时长等待。handler 包装的封顶与 EventPlayer 的告警跟随房间节奏。
// 原版舞台（A8，original-skin.md §3 修正 1）：真的 OrigStage（假棋盘 + 合成 FLIC，帧数与帧间隔同原版）下同样不超预算；
// original 节奏下 FLIC 原速完整播放（handler 用时 ≥ FLIC 原长 + FLIC 之外的等待），compact 节奏下 playFit 加速或截取。
import type { GameEvent, GameEventOf } from '@rich4/shared/engine';
import { defaultRoomSettings, type GameBatchMsg } from '@rich4/shared/net';
import type { GameView, PacingProfile } from '@rich4/shared/view';
import { DEFAULT_PACING, eventBudgetMs, flicMs, PACING_PROFILES, STEP_MS } from '@rich4/shared/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnimClock } from '../../game/anim/AnimClock';
import { COIN_FLIGHT_MS, FLAG_MS, HOP_MS, ORIG_FLIC_WAITS, POP_MS } from '../../game/fx/timings';
import { eventFlicOf } from '../../game/orig/stage/flicPlan';
import { buildFakeFlicPack } from '../../game/orig/stage/testing/fakeFlics';
import { StageBench } from '../../game/orig/stage/testing/stageBench';
import { initI18n } from '../../i18n';
import { tx } from '../../i18n/tx';
import { useRoomStore } from '../../store/roomStore';
import { roomView } from '../../test/roomFixtures';
import { selfPlay } from '../../test/selfPlay';
import { registerClassicPopupProbe, usePopupStore } from '../../ui/popups/popupStore';
import { BUDGET_TOLERANCE, EventPlayer } from '../EventPlayer';
import { makeNames } from '../names';
import type { BoardPort, EventHandler, HandlerMap, PresentationContext } from '../types';
import { createUiPresenter } from '../UiPresenter';
import { HANDLERS, RAW_HANDLERS } from '.';
import { budgetMs, currentPacing, setPacingOverride } from './budget';
import type { StagePort } from './stage';
import { recordingStage } from './testStage';
import { wrapHandler } from './wrap';

beforeAll(() => {
  initI18n('original');
});

afterEach(() => {
  setPacingOverride(null);
  useRoomStore.getState().clear();
});

function timedBoard(clock: AnimClock, withStage = false): BoardPort & { stage?: StagePort } {
  const noop = (): void => {};
  const wait = (ms: number) => (_a?: unknown, _b?: unknown, s?: unknown) =>
    clock.wait(ms, s instanceof AbortSignal ? s : undefined);
  return {
    ready: true,
    syncView: noop,
    walk: (_seat, path, signal) => clock.wait(Math.max(0, path.length - 1) * STEP_MS, signal),
    placeActor: noop,
    hop: (_s, signal) => clock.wait(HOP_MS, signal),
    setActorPose: noop,
    setLot: noop,
    focus: (_a, ms, signal) => clock.wait(ms, signal),
    follow: noop,
    floatText: noop,
    coinFlight: wait(COIN_FLIGHT_MS),
    plantFlag: wait(FLAG_MS),
    popBuilding: (_l, signal) => clock.wait(POP_MS, signal),
    pulseTile: noop,
    shake: noop,
    clearFx: noop,
    ...(withStage ? { stage: recordingStage([], clock) } : {}),
  };
}

/** 在 1x 时钟下运行一个 handler，返回用掉的时钟毫秒（raw：不经包装，测「自然」时长；stage：接上计时舞台） */
async function measure(
  e: GameEvent,
  view: GameView,
  o: { raw?: boolean; stage?: boolean; handler?: EventHandler<GameEvent['type']> } = {},
): Promise<number> {
  const clock = new AnimClock();
  const signal = new AbortController().signal;
  const ctx: PresentationContext = {
    signal,
    wait: (ms) => clock.wait(ms, signal),
    board: timedBoard(clock, o.stage ?? false),
    ui: createUiPresenter({ wait: (ms, s) => clock.wait(ms, s) }),
    audio: { play: () => {} },
    me: 0,
    role: 'player',
    view: () => view,
    map: null,
    names: makeNames({ t: tx, view: () => view, map: () => null }),
    t: tx,
  };
  const table = o.raw ? RAW_HANDLERS : HANDLERS;
  const h = (o.handler ?? table[e.type]) as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>;
  let done = false;
  const p = h(e, ctx).then(() => {
    done = true;
  });
  const t0 = clock.now();
  for (let i = 0; i < 2000 && !done; i++) {
    clock.advance(16);
    for (let k = 0; k < 4; k++) await Promise.resolve();
  }
  await p;
  return clock.now() - t0;
}

function within(e: GameEvent, used: number, profile: PacingProfile): void {
  const budget = eventBudgetMs(e, profile);
  expect(used, `${e.type} 用时 ${used}ms，${profile} 预算 ${budget}ms`).toBeLessThanOrEqual(
    budget * BUDGET_TOLERANCE + 50,
  );
}

/** M6 / M7 的全部新 handler 的样本事件（程序化计时舞台与原版舞台共用） */
function m6m7Events(): GameEvent[] {
  const cause = { k: 'card', ref: 17, by: 0 } as const;
  const obj = { id: 1, kind: 'mine', node: 6, placedBy: 0 } as const;
  const result = {
    reason: 'timeLimit',
    code: 3,
    winner: 1,
    date: 19990101,
    elapsedDays: 365,
    ranking: [
      { seat: 1, netWorth: 500000, alive: true },
      { seat: 0, netWorth: 300000, alive: true },
      { seat: 2, netWorth: 100000, alive: true },
      { seat: 3, netWorth: 0, alive: false },
    ],
  } as const;
  return [
    { type: 'CARD_USED', seat: 0, card: 17, target: { t: 'seat', seat: 1 } },
    { type: 'CARD_USED', seat: 0, card: 9, target: { t: 'lot', lot: 'L1', facility: null } },
    { type: 'CARD_NO_EFFECT', seat: 0, card: 22 },
    { type: 'PASSIVE', seat: 1, card: 21, context: 'frame', other: null },
    { type: 'ITEM_USED', seat: 0, item: 2, target: { t: 'node', node: 5 } },
    { type: 'VEHICLE', seat: 0, vehicle: 'car', dice: 3 },
    { type: 'VEHICLE_DESTROYED', seat: 0, vehicle: 'moto' },
    { type: 'OBJECT_PLACED', obj },
    { type: 'OBJECT_REMOVED', obj, cause: { k: 'object', ref: null, by: null } },
    { type: 'DOLL_WALK', seat: 0, path: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11], clearedObjects: [1], clearedGods: [7] },
    { type: 'BOMB_ATTACHED', seat: 1, fuse: 38 },
    { type: 'BOMB_TRANSFERRED', from: 1, to: 2, fuse: 30 },
    { type: 'BOMB_EXPLODED', seat: 2, node: 6, lot: 'L2' },
    { type: 'STRIKE', kind: 'missile', center: 6, half: 100, lots: ['L1', 'L2'], actors: [{ t: 'seat', seat: 1 }] },
    { type: 'STRIKE', kind: 'nuke', center: 6, half: 220, lots: ['L1'], actors: [] },
    { type: 'STRIKE', kind: 'typhoon', center: 6, half: 100, lots: [], actors: [] },
    {
      type: 'TELEPORTED',
      by: 0,
      source: { k: 'actor', actor: { t: 'seat', seat: 1 } },
      dest: { k: 'road', node: 9 },
    },
    { type: 'TIME_REWOUND', bySeat: 0, toTurnNo: 3 },
    { type: 'GOD_SPAWNED', kind: 1, node: 8 },
    { type: 'GOD_ATTACHED', seat: 0, kind: 2, displaced: null },
    { type: 'GOD_POWER', seat: 0, kind: 2, slot: null, transfers: [{ seat: 0, amount: 1000 }] },
    {
      type: 'GOD_POWER',
      seat: 0,
      kind: 6,
      slot: { digits: 4, value: 3721 },
      transfers: [
        { seat: 0, amount: -3721 },
        { seat: 1, amount: 3721 },
      ],
    },
    { type: 'GOD_LEFT', seat: 0, kind: 2, reason: 'expired' },
    { type: 'GOD_LEFT', seat: null, kind: 7, reason: 'swept' },
    { type: 'GOD_MANIFEST', seat: 0, kind: 12, lot: 'L1', effect: 'seize' },
    { type: 'DOG_BITE', seat: 1, node: 7 },
    { type: 'DOG_KNOCKED', seat: 1, node: 7 },
    { type: 'DEATH_GOD_SUMMONED', by: 0, target: 1 },
    { type: 'CONFINED', actor: { t: 'seat', seat: 1 }, where: 'jail', days: 5, total: 5, cause },
    { type: 'CONFINED', actor: { t: 'seat', seat: 2 }, where: 'hospital', days: 3, total: 3, cause },
    { type: 'CONFINED', actor: { t: 'seat', seat: 2 }, where: 'away', days: 3, total: 3, cause },
    { type: 'CONFINED', actor: { t: 'villain', kind: 'thief' }, where: 'jail', days: 3, total: 3, cause },
    { type: 'RELEASED', actor: { t: 'seat', seat: 1 }, from: 'jail' },
    { type: 'RETURNED', seat: 1, node: 14 },
    { type: 'BLESSING', seat: 0, category: 'misfortune', result: 'high' },
    { type: 'STATUS_SET', actor: { t: 'seat', seat: 1 }, status: 'hibernate', value: 5 },
    { type: 'ALLIANCE_FORMED', a: 0, b: 1, days: 7 },
    { type: 'ALLIANCE_BROKEN', a: 0, b: 1, reason: 'hostility' },
    { type: 'ALLIANCE_EXPIRED', a: 0, b: 1 },
    { type: 'BAIL', by: 0, seat: 1, cost: 30 },
    { type: 'NEWS', id: 8, params: { seat: 1, amount: 10000 }, affected: [1] },
    { type: 'NEWS', id: 27, params: { stock: 2 }, affected: [] },
    { type: 'FATE', seat: 0, id: 25, amount: 10000, blessing: 'high' },
    { type: 'FATE', seat: 0, id: 34, amount: null, blessing: null },
    { type: 'MAGIC_CONDITION', caster: 0, cond: 3, targets: [1, 2] },
    { type: 'MAGIC_CAST', caster: 0, effect: 2, targets: [1, 2] },
    { type: 'LOTTERY_DRAW', number: 11, winner: 2, prize: 36000 },
    { type: 'VILLAIN_HIRED', by: 0, kind: 'robber', cost: 3000 },
    { type: 'VILLAIN_ACTION', kind: 'robber', employer: 0, victim: 1, what: 'robDeposit', amount: 4000 },
    { type: 'VILLAIN_ACTION', kind: 'thief', employer: null, victim: null, what: 'stealObject', amount: 0 },
    { type: 'VILLAIN_HOME', kind: 'robber' },
    { type: 'MOVE_SEGMENT', actor: { t: 'villain', kind: 'thief' }, path: [3, 4, 5, 6], remaining: 0 },
    { type: 'BEGGAR_ALMS', payer: 0, beggar: 3, amount: 1000, newNode: 11 },
    { type: 'AUCTION_STARTED', lot: 'L1', seller: 0, source: 'card', start: 2000, bidders: [1, 2, 3] },
    { type: 'AUCTION_BID', seat: 1, price: 2500 },
    { type: 'AUCTION_PASS', seat: 2 },
    { type: 'AUCTION_QUIT', seat: 3 },
    { type: 'AUCTION_ENDED', lot: 'L1', winner: 1, price: 2500 },
    { type: 'LISTING_ADDED', listing: { id: 1, seller: 0, price: 5000, asset: { t: 'card', card: 3 } } },
    { type: 'LISTING_REMOVED', listingId: 1, reason: 'delisted' },
    { type: 'LISTING_SOLD', listingId: 1, seller: 0, buyer: 1, price: 5000 },
    { type: 'SURRENDERED', seat: 3 },
    { type: 'GAME_OVER', result },
  ] as unknown as GameEvent[];
}

describe.each(PACING_PROFILES)('handler 用时 ≤ EVENT_BUDGET_MS[%s]', (profile) => {
  // 外层 afterEach 会清掉覆盖：每个用例前重新固定节奏
  beforeEach(() => setPacingOverride(profile));

  it('自对弈出现的全部事件', async () => {
    const sp = selfPlay({ seed: 17, steps: 120 });
    let view = sp.initial.view;
    const seen = new Set<string>();
    for (const b of sp.batches) {
      for (const e of b.events) {
        if (seen.has(e.type) && e.type !== 'MOVE_SEGMENT') continue;
        seen.add(e.type);
        within(e, await measure(e, view), profile);
      }
      view = b.view;
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('M1/M4 主要事件（构造，含经济事件）', async () => {
    const view = selfPlay({ seed: 1, steps: 2 }).initial.view;
    const events: GameEvent[] = [
      { type: 'TURN_STARTED', actor: { t: 'seat', seat: 1 }, turnNo: 3 },
      { type: 'PARACHUTE', seat: 1, node: 5, prev: 4 },
      { type: 'DICE_ROLLED', seat: 0, dice: [3, 4, 5], steps: 12, forced: false, diceCount: 3 },
      { type: 'MOVE_SEGMENT', actor: { t: 'seat', seat: 0 }, path: [2, 3, 4, 5, 6, 7], remaining: 0 },
      { type: 'LAND_BOUGHT', seat: 0, lot: 'L1', price: 2000 },
      { type: 'LOT_LEVEL', lot: 'L1', from: 1, to: 2, cause: { k: 'system', ref: null, by: 0 } },
      {
        type: 'TOLL_PAID',
        payer: 1,
        owner: 0,
        ally: null,
        amount: 400,
        allyAmount: 0,
        lots: ['L1'],
        mods: [],
      } as GameEventOf<'TOLL_PAID'>,
      { type: 'FEE_PAID', payer: 1, lot: 'F1', feeKind: 'hotel', wheel: null, amount: 300 } as GameEventOf<'FEE_PAID'>,
      {
        type: 'MONEY',
        from: { t: 'seat', seat: 1 },
        to: { t: 'seat', seat: 0 },
        amount: 1,
        paid: 1,
        reason: 'equalize',
        ref: null,
      },
      { type: 'POINTS_GAINED', seat: 0, amount: 30, source: 'square' },
      { type: 'BANKRUPT', seat: 2, cause: { k: 'toll', ref: null, by: 0 }, creditor: null },
      { type: 'HOLIDAY', key: 'h0', giveCard: false },
      { type: 'TURN_BLOCKED', seat: 1, reason: 'jail', remaining: 2 },
      { type: 'NEWS', id: 1, params: {}, affected: [] },
      { type: 'LOTTERY_DRAW', number: 3, winner: 1, prize: 5000 },
      { type: 'LOTTERY_DRAW', number: null, winner: null, prize: 0 },
      { type: 'LOTTERY_TICKET', seat: 0, number: 4 },
      { type: 'STOCK_TRADED', seat: 1, stock: 0, side: 'buy', shares: 300, priceCents: 8000, amount: 24000 },
      { type: 'DIVIDENDS', rows: [{ company: 'C1', seat: 0, amount: -1200 }] },
      { type: 'MONTHLY_REPORT', rows: [], champion: 2, tragic: null },
      { type: 'SHOP_TRADE', seat: 0, op: 'buyItem', card: null, item: 8, qty: 1, points: 30 },
      { type: 'COMPANY_FEE', seat: 1, company: 'C2', industry: 10, amount: 800, wheel: null },
      { type: 'COMPANY_FEE', seat: 1, company: 'C2', industry: 3, amount: 1600, wheel: 2 },
      { type: 'HOTEL_STAY', seat: 1, lot: 'F1', days: 3 },
      { type: 'LOAN_REMINDER', seat: 0, daysLeft: 3 },
      { type: 'LOAN_FORCED', seat: 0, amount: 30000, paid: 3000 },
      { type: 'RESEARCH_DONE', seat: 0, lot: 'F1', project: 2, item: 10, delivered: true },
      { type: 'CHAIRMAN_GIFT', seat: 0, card: null, item: 3 },
      { type: 'SUBSCRIBED', seat: 0, stock: 1, shares: 100, unit: 50 },
    ] as GameEvent[];
    for (const e of events) within(e, await measure(e, view), profile);
  });

  it('M6/M7 全部新 handler（接上计时舞台，不经封顶包装）', async () => {
    const base = selfPlay({ seed: 1, steps: 2 }).initial.view;
    const view: GameView = { ...base, beggars: [{ seat: 3, node: 7 }] };
    const events = m6m7Events();
    // 编排确实在跑（不是空转通过）：这些事件的自然时长至少有紧凑预算的一半（程序化演出按 compact 编排）
    const substantial = new Set(['NEWS', 'FATE', 'GAME_OVER', 'CONFINED', 'GOD_ATTACHED', 'CARD_USED', 'LOTTERY_DRAW']);
    const seen = new Set<string>();
    for (const e of events) {
      seen.add(e.type);
      const used = await measure(e, view, { raw: true, stage: true });
      within(e, used, profile);
      if (substantial.has(e.type) && !(e.type === 'CONFINED' && e.actor.t !== 'seat')) {
        expect(used, `${e.type} 只用了 ${used}ms`).toBeGreaterThanOrEqual(eventBudgetMs(e, 'compact') / 2);
      }
    }
    expect(seen.size).toBeGreaterThan(50);
  });

  it('包装后的 handler 一律封顶在当前节奏的预算内（慢 handler 到点被中止）', async () => {
    const view = selfPlay({ seed: 1, steps: 2 }).initial.view;
    const cause = { k: 'card', ref: 17, by: 0 } as const;
    const events = [
      { type: 'BLESSING', seat: 0, category: 'reward', result: 'high' },
      // 两种节奏预算不同的事件：救护车（original 按原版 FLIC 6.2 s 放宽）
      { type: 'CONFINED', actor: { t: 'seat', seat: 1 }, where: 'hospital', days: 3, total: 3, cause },
    ] as GameEvent[];
    for (const e of events) {
      let finished = false;
      const slow: EventHandler<GameEvent['type']> = async (_e, ctx) => {
        await ctx.wait(10_000);
        finished = true;
      };
      const used = await measure(e, view, { handler: wrapHandler(slow) as EventHandler<GameEvent['type']> });
      expect(finished).toBe(true);
      const budget = eventBudgetMs(e, profile);
      expect(budgetMs(e)).toBe(budget);
      // 测量循环每步推进 16 ms：封顶点落在两步之内
      expect(used, e.type).toBeLessThanOrEqual(budget + 32);
      expect(used, e.type).toBeGreaterThanOrEqual(budget);
    }
  });
});

describe('当前房间的演出节奏', () => {
  it('跟随房间设置；没有房间时用默认节奏；setPacingOverride 优先', () => {
    expect(currentPacing()).toBe(DEFAULT_PACING);
    const base = roomView();
    for (const pacing of PACING_PROFILES) {
      useRoomStore.getState().setRoom({ ...base, settings: { ...base.settings, pacing } });
      expect(currentPacing()).toBe(pacing);
    }
    setPacingOverride('original');
    expect(currentPacing()).toBe('original');
    setPacingOverride(null);
    expect(currentPacing()).toBe('compact');
    expect(defaultRoomSettings(base.settings.game).pacing).toBe('original');
  });

  it('封顶与告警用的预算：original 的 FLIC 事件更长，其余与 compact 相同', () => {
    const hospital = {
      type: 'CONFINED',
      actor: { t: 'seat', seat: 1 },
      where: 'hospital',
      days: 3,
      total: 3,
      cause: { k: 'card', ref: 17, by: 0 },
    } as GameEvent;
    const toll = { type: 'TOLL_EXEMPT', seat: 1, lot: 'L1', reason: 'jail' } as unknown as GameEvent;
    expect(budgetMs(hospital, 'original')).toBeGreaterThan(budgetMs(hospital, 'compact'));
    expect(budgetMs(toll, 'original')).toBe(budgetMs(toll, 'compact'));
  });

  it.each(PACING_PROFILES)('EventPlayer 开发告警按当前房间节奏（%s）判断超预算', async (pacing) => {
    const base = roomView();
    useRoomStore.getState().setRoom({ ...base, settings: { ...base.settings, pacing } });
    const sp = selfPlay({ seed: 1, steps: 2 });
    const clock = new AnimClock();
    const warns: string[] = [];
    // 送医院的 handler 用掉 3 秒：超过 compact 预算（1.5 s），在 original 预算（救护车 6.2 s + 等待）之内
    const handler = async (_e: GameEvent, ctx: PresentationContext): Promise<void> => ctx.wait(3000);
    const handlers = new Proxy({}, { get: () => handler }) as HandlerMap;
    const player = new EventPlayer({
      handlers,
      clock,
      dev: true,
      warn: (m) => warns.push(m),
      requestResync: () => {},
      context: (signal) => ({ signal, wait: (x: number) => clock.wait(x, signal) }) as unknown as PresentationContext,
      sink: {
        reset: () => {},
        commitView: () => {},
        commitBatch: () => {},
        commitPending: () => {},
        setAnim: () => {},
      },
    });
    player.reset(sp.initial);
    const hospital = {
      type: 'CONFINED',
      actor: { t: 'seat', seat: 1 },
      where: 'hospital',
      days: 3,
      total: 3,
      cause: { k: 'card', ref: 17, by: 0 },
    } as GameEvent;
    const msg: GameBatchMsg = {
      epoch: sp.initial.epoch,
      seq: sp.initial.seq + 1,
      cause: { seat: 1, intentType: 'ROLL', by: 'player' },
      events: [hospital],
      animMs: eventBudgetMs(hospital, pacing),
      view: sp.initial.view,
      pending: [],
      serverNow: 0,
    };
    player.enqueue(msg);
    for (let t = 0; t < 10_000 && !player.idle; t += 16) {
      clock.advance(16);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
    expect(player.idle).toBe(true);
    const over = warns.filter((w) => w.includes('超过预算'));
    expect(over).toHaveLength(pacing === 'compact' ? 1 : 0);
  });
});

/** 有原版 FLIC 的事件（全部神明降临、打击、关押去处、节日、得卡得点券、破产、开局跳伞） */
function flicEvents(): GameEvent[] {
  const cause = { k: 'card', ref: 17, by: 0 } as const;
  const out: unknown[] = [
    { type: 'PARACHUTE', seat: 1, node: 5, prev: 4 },
    { type: 'GOD_LEFT', seat: 0, kind: 2, reason: 'expired' },
    { type: 'CONFINED', actor: { t: 'seat', seat: 1 }, where: 'hospital', days: 3, total: 3, cause },
    { type: 'CONFINED', actor: { t: 'seat', seat: 2 }, where: 'jail', days: 3, total: 3, cause },
    { type: 'BOMB_EXPLODED', seat: 2, node: 6, lot: 'L2' },
    {
      type: 'OBJECT_REMOVED',
      obj: { id: 1, kind: 'bomb', node: 6, placedBy: 0 },
      cause: { k: 'object', ref: null, by: null },
    },
    { type: 'CARD_GAINED', seat: 0, card: 3, source: 'square' },
    { type: 'POINTS_GAINED', seat: 0, amount: 30, source: 'square' },
    { type: 'HOLIDAY', key: 'h0', giveCard: false },
    { type: 'HOLIDAY', key: 'h1', giveCard: true },
    { type: 'BANKRUPT', seat: 2, cause: { k: 'toll', ref: null, by: 0 }, creditor: null },
  ];
  for (const kind of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15])
    out.push({ type: 'GOD_ATTACHED', seat: 3, kind, displaced: null });
  for (const kind of ['missile', 'nuke', 'alien', 'typhoon', 'bomb3x3']) {
    out.push({ type: 'STRIKE', kind, center: 6, half: 100, lots: [], actors: [{ t: 'seat', seat: 1 }] });
  }
  return out as GameEvent[];
}

describe.each(PACING_PROFILES)('原版舞台 OrigStage：handler 用时 ≤ EVENT_BUDGET_MS[%s]', (profile) => {
  beforeEach(() => setPacingOverride(profile));

  it('M6/M7 与有原版 FLIC 的事件（合成 FLIC）；original 下 FLIC 原速完整播放', async () => {
    const base = selfPlay({ seed: 1, steps: 2 }).initial.view;
    const view: GameView = { ...base, beggars: [{ seat: 3, node: 7 }] };
    const holidays = [
      { slot: 0, flagsRaw: 0x301 },
      { slot: 1, flagsRaw: 0xf01 },
    ];
    const pack = buildFakeFlicPack();
    const bench = new StageBench({ profile, flics: pack, holidays });
    await bench.fake.flics!.ready;
    // 原版皮肤：演出弹窗一律按原版画面打开（命运板、亮卡、卡片格 / 聖誕節得卡亮卡），按原版的节拍走
    const off = registerClassicPopupProbe(() => true);
    let flics = 0;
    const extra: GameEvent[] = [
      { type: 'CARD_GAINED', seat: 0, card: 3, source: 'holiday' },
      { type: 'CARD_GAINED', seat: 1, card: null, source: 'square' },
      { type: 'FATE', seat: 0, id: 4, amount: 1000, blessing: 'high' },
      { type: 'FATE', seat: 0, id: 35, amount: null, blessing: null },
    ];
    try {
      for (const e of [...m6m7Events(), ...flicEvents(), ...extra]) {
        const { used } = await bench.run(e, view);
        within(e, used, profile);
        const f = eventFlicOf(e, {
          map: { holidays: holidays.map((h) => ({ ...h, month: 1, day: 1, kind: 0 })) },
          characterOf: (s) => bench.fake.host.characterOf(s),
        });
        if (!f) continue;
        flics++;
        const w = ORIG_FLIC_WAITS[f.type];
        if (profile === 'original') {
          expect(used, `${e.type} ${f.use}：FLIC 没有原速播完`).toBeGreaterThanOrEqual(
            flicMs(f.timing) + w.before + w.after - 32,
          );
        }
      }
    } finally {
      off();
      usePopupStore.getState().clear();
    }
    expect(flics).toBeGreaterThan(25);
    // FLIC 确实经 flic-map 载入并播放了（不是空转回退），同步音效经 ctx.audio 放出
    expect(bench.fake.flics!.flicMap).not.toBeNull();
    expect(new Set(pack.loads).size).toBeGreaterThan(25);
    expect(bench.fake.sounds.filter((k) => k.startsWith('sfx.')).length).toBeGreaterThan(20);
  });

  it('素材包没有 FLIC 时全部回退 FxSystem，同样不超预算', async () => {
    const base = selfPlay({ seed: 1, steps: 2 }).initial.view;
    const view: GameView = { ...base, beggars: [{ seat: 3, node: 7 }] };
    const bench = new StageBench({ profile, flics: null });
    for (const e of [...m6m7Events(), ...flicEvents()]) within(e, (await bench.run(e, view)).used, profile);
  });
});
