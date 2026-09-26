// 演出时长不超预算（design/client.md §12.1「timing」；architecture §5.9）：服务器按 EVENT_BUDGET_MS 计算截止时间，
// handler 在 1x 时钟下的实际用时不能超过预算（与 EventPlayer 开发告警同一容差）。棋盘端口按真实特效时长等待。
import type { GameEvent, GameEventOf } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { eventBudgetMs, STEP_MS } from '@rich4/shared/view';
import { beforeAll, describe, expect, it } from 'vitest';
import { AnimClock } from '../../game/anim/AnimClock';
import { COIN_FLIGHT_MS, FLAG_MS, HOP_MS, POP_MS } from '../../game/fx/timings';
import { initI18n } from '../../i18n';
import { tx } from '../../i18n/tx';
import { selfPlay } from '../../test/selfPlay';
import { BUDGET_TOLERANCE } from '../EventPlayer';
import { makeNames } from '../names';
import type { BoardPort, PresentationContext } from '../types';
import { createUiPresenter } from '../UiPresenter';
import { HANDLERS } from '.';

beforeAll(() => {
  initI18n('original');
});

function timedBoard(clock: AnimClock): BoardPort {
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
  };
}

/** 在 1x 时钟下运行一个 handler，返回用掉的时钟毫秒 */
async function measure(e: GameEvent, view: GameView): Promise<number> {
  const clock = new AnimClock();
  const signal = new AbortController().signal;
  const ctx: PresentationContext = {
    signal,
    wait: (ms) => clock.wait(ms, signal),
    board: timedBoard(clock),
    ui: createUiPresenter({ wait: (ms, s) => clock.wait(ms, s) }),
    audio: { play: () => {} },
    me: 0,
    role: 'player',
    view: () => view,
    map: null,
    names: makeNames({ t: tx, view: () => view, map: () => null }),
    t: tx,
  };
  const h = HANDLERS[e.type] as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>;
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

function within(e: GameEvent, used: number): void {
  const budget = eventBudgetMs(e);
  expect(used, `${e.type} 用时 ${used}ms，预算 ${budget}ms`).toBeLessThanOrEqual(budget * BUDGET_TOLERANCE + 50);
}

describe('handler 用时 ≤ EVENT_BUDGET_MS', () => {
  it('自对弈出现的全部事件', async () => {
    const sp = selfPlay({ seed: 17, steps: 120 });
    let view = sp.initial.view;
    const seen = new Set<string>();
    for (const b of sp.batches) {
      for (const e of b.events) {
        if (seen.has(e.type) && e.type !== 'MOVE_SEGMENT') continue;
        seen.add(e.type);
        within(e, await measure(e, view));
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
    for (const e of events) within(e, await measure(e, view));
  });
});
