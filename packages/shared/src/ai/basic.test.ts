import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../data/maps/registry';
import { isIntentAllowed } from '../engine/decisions/allowed';
import { decisionForSeat, newGame, simpleView } from '../engine/testing/index';
import { DECISION_KINDS, type DecisionKind, type GameAction, PlayerIntentSchema } from '../engine/types/index';
import { mix32 } from '../util/hash';
import { WatcomRng } from '../util/rng/watcom';
import type { DecisionForYou, GameView } from '../view/types';
import { BASIC_HANDLERS, BasicAiPolicy, buyReserve } from './basic';
import type { AiContext, AiRng } from './types';

function aiRng(seed: number): AiRng {
  const w = WatcomRng.fromSeed(seed);
  return {
    next15: () => w.rand15(),
    mod: (n) => w.int(n),
    bit: () => (w.rand15() & 1) as 0 | 1,
    scale: (n) => w.scale(n),
  };
}

function ctxFor(view: GameView, seat: 0 | 1 | 2 | 3, key: number): AiContext {
  const p = view.players.find((x) => x.seat === seat)!;
  return {
    seat,
    traits: p.aiTraits,
    rng: aiRng(mix32(12345, seat, key)),
    turnRng: (salt) => aiRng(mix32(12345, seat, view.clock.turnNo, salt.length)),
    map: fixtureRegistry.getMap(view.dataRef.mapId),
    handVisibility: 'public',
  };
}

describe('BasicAiPolicy', () => {
  it('覆盖全部 23 种决策', () => {
    expect(Object.keys(BASIC_HANDLERS).sort()).toEqual([...DECISION_KINDS].sort());
    expect(BasicAiPolicy.id).toBe('basic');
  });

  it('四个 AI 自对弈：每个 intent 都能通过 PlayerIntentSchema 与 ALLOWED_INTENTS，引擎全部接受，限时局结束', {
    timeout: 120_000,
  }, () => {
    for (const seed of ['a1', 'b2', 'c3']) {
      const g = newGame({ seed, players: ['ai', 'ai', 'ai', 'ai'], config: { timeLimitDays: 91 } });
      let s = g.state;
      let n = 0;
      const kinds = new Set<DecisionKind>();
      while (s.status === 'playing' && n < 5000) {
        const d = s.pending[0]!;
        const view = simpleView(s) as GameView;
        const intent = BasicAiPolicy.decide(view, decisionForSeat(d) as DecisionForYou, ctxFor(view, d.seat, n));
        expect(PlayerIntentSchema.safeParse(intent).success).toBe(true);
        expect(isIntentAllowed(d.kind, intent.type)).toBe(true);
        kinds.add(d.kind);
        s = g.engine.applyAction(s, { ...intent, seat: d.seat, decisionId: d.id } as GameAction).state;
        n++;
      }
      expect(s.status).toBe('over');
      expect(kinds.has('TURN_MENU')).toBe(true);
      expect(s.lands.some((l) => l.owner !== null)).toBe(true);
    }
  });

  it('买地保留额：min(trunc(开局资金 × 5%), 7000) × PI', () => {
    const { state } = newGame({ players: ['ai', 'ai'] });
    const view = simpleView(state) as GameView;
    expect(buyReserve(view)).toBe(7000);
    const d: DecisionForYou<'BUY_LAND'> = {
      decisionId: 'd9',
      seat: 0,
      kind: 'BUY_LAND',
      timing: 'confirm',
      options: {
        lot: 'L1',
        price: 0,
        cash: 0,
        level: 0,
        street: { lots: ['L1'], owners: [null] },
        tollAfter: 0,
        fortuneBonus: false,
      },
      defaultIntent: { type: 'DECLINE' },
      deadlineAt: null,
    };
    const p = view.players[0]!;
    const total = p.cash + p.deposit;
    const at = (price: number) =>
      BasicAiPolicy.decide(view, { ...d, options: { ...d.options, price } } as DecisionForYou, ctxFor(view, 0, 1)).type;
    expect(at(total - 7001)).toBe(p.cash >= total - 7001 ? 'CONFIRM' : 'DECLINE');
    expect(at(total - 7000)).toBe('DECLINE');
    expect(at(p.cash + 1)).toBe('DECLINE');
    expect(at(2000)).toBe('CONFIRM');
  });

  it('M1 之外的决策也给出合法回答（合成 options）', () => {
    const { state } = newGame({ players: ['ai', 'ai'] });
    const view = simpleView(state) as GameView;
    const mk = <K extends DecisionKind>(kind: K, options: unknown, defaultIntent: object): DecisionForYou =>
      ({ decisionId: 'd5', seat: 0, kind, timing: 'pick', options, defaultIntent, deadlineAt: null }) as DecisionForYou;
    const cases: DecisionForYou[] = [
      mk(
        'LOTTERY',
        { cash: 5000, price: 1000, sold: Array.from({ length: 36 }, (_, i) => (i < 35 ? 1 : null)), pool: 0 },
        {
          type: 'SKIP',
        },
      ),
      mk(
        'MAGIC_CAST',
        { condition: 0, targets: [1], effects: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
        {
          type: 'MAGIC_CAST',
          effect: 3,
        },
      ),
      mk(
        'BUILD_FACILITY',
        {
          lot: 'F1',
          cost: 4000,
          cash: 100000,
          types: [
            { type: 'park', cap: 1, feePreview: 0 },
            { type: 'hotel', cap: 5, feePreview: 0 },
            { type: 'mall', cap: 5, feePreview: 0 },
            { type: 'gas', cap: 1, feePreview: 0 },
            { type: 'lab', cap: 5, feePreview: 0 },
          ],
        },
        { type: 'DECLINE' },
      ),
      mk(
        'DISCARD_CARD',
        {
          hand: [
            { slot: 0, card: 9, price: 160 },
            { slot: 1, card: 22, price: 10 },
          ],
          incoming: 3,
        },
        {
          type: 'DISCARD',
          slot: 0,
        },
      ),
      mk('SCAPEGOAT', { context: 'frame', amount: null, days: 5, candidates: [1], slot: 0 }, { type: 'DECLINE' }),
      mk(
        'AUCTION_BID',
        { lot: 'L1', level: 0, seller: null, start: 3000, price: 3000, leader: null, increments: [0, 100], cash: 9 },
        {
          type: 'PASS',
        },
      ),
      mk('MINIGAME', { minigameId: 'penguin', maxScore: 188 }, { type: 'MINIGAME_DECLINE' }),
    ];
    for (const d of cases) {
      const intent = BasicAiPolicy.decide(view, d, ctxFor(view, 0, 3));
      expect(PlayerIntentSchema.safeParse(intent).success, d.kind).toBe(true);
      expect(isIntentAllowed(d.kind, intent.type), d.kind).toBe(true);
    }
    expect(BasicAiPolicy.decide(view, cases[0]!, ctxFor(view, 0, 3))).toEqual({ type: 'LOTTERY_BUY', number: 35 });
    expect(BasicAiPolicy.decide(view, cases[3]!, ctxFor(view, 0, 3))).toEqual({ type: 'DISCARD', slot: 1 });
    expect(BasicAiPolicy.decide(view, cases[4]!, ctxFor(view, 0, 3))).toEqual({ type: 'SCAPEGOAT', target: 1 });
    const built = BasicAiPolicy.decide(view, cases[2]!, ctxFor(view, 0, 3));
    expect(built.type).toBe('BUILD_FACILITY');
    expect(built).not.toMatchObject({ facility: 'park' });
  });
});
