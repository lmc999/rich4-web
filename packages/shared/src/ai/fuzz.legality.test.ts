import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../data/maps/registry';
import { EngineRuleError } from '../engine/errors';
import { newGame } from '../engine/testing/builders';
import { decisionForSeat, simpleView } from '../engine/testing/view';
import type { DecisionKind, GameAction, GameState } from '../engine/types/index';
import type { DecisionForYou, GameView } from '../view/types';
import { isLegalIntent, OriginalAiPolicy } from './policy';
import { makeAiContext } from './rng';
import type { AiPolicy } from './types';

/**
 * AI 合法率 fuzz（architecture §8「AI」、M6 验证 2）：
 * - OriginalAiPolicy 在两张 fixture 上自对弈，每个 intent 都通过 isLegalIntent（schema、ALLOWED_INTENTS、options 自检），
 *   并且被引擎接受（不抛 EngineRuleError）→ 合法率 100%；
 * - 单次决策耗时 p99 < 5ms；
 * - AI 看到的视图里 secret 是一个访问即抛错的 Proxy：策略一旦读 secret 就会失败。
 */
const SECRET_TRAP = new Proxy(
  {},
  {
    get() {
      throw new Error('AI read state.secret');
    },
    has() {
      throw new Error('AI read state.secret');
    },
    ownKeys() {
      throw new Error('AI read state.secret');
    },
  },
);

/** 公平视图 + 一个碰到就抛错的 secret */
function guardedView(s: GameState): GameView {
  const v = simpleView(s) as GameView & { secret?: unknown };
  Object.defineProperty(v, 'secret', { get: () => SECRET_TRAP, enumerable: false });
  return v;
}

function ctxFor(s: GameState, seat: 0 | 1 | 2 | 3, id: string) {
  return makeAiContext({
    aiSeed: s.secret.aiSeed,
    seat,
    decisionId: id,
    turnNo: s.clock.turnNo,
    traits: s.players.find((p) => p.seat === seat)!.aiTraits,
    map: fixtureRegistry.getMap(s.dataRef.mapId),
    handVisibility: 'public',
  });
}

function percentile(xs: number[], p: number): number {
  const a = xs.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length * p) / 100))]!;
}

describe('fuzz.legality（OriginalAiPolicy）', () => {
  it('四个座位（含 controller=human 由 AI 代打）自对弈：合法率 100%，p99 < 5ms，覆盖 M6 决策', {
    timeout: 240_000,
  }, () => {
    const times: number[] = [];
    const kinds = new Set<DecisionKind>();
    const used = { cards: 0, items: 0 };
    let decisions = 0;
    for (const map of ['test', 'test-allkinds']) {
      for (const seed of ['f1', 'f2', 'f3']) {
        const g = newGame({
          map,
          seed,
          players: ['ai', 'human', 'ai', 'human'],
          config: { timeLimitDays: 182 },
          devChecks: false,
        });
        let s = g.state;
        for (let n = 0; n < 6000 && s.status === 'playing'; n++) {
          const d = s.pending[0]!;
          const dfy = decisionForSeat(d) as DecisionForYou;
          const ctx = ctxFor(s, d.seat, d.id);
          const view = guardedView(s);
          const t0 = performance.now();
          const intent = OriginalAiPolicy.decide(view, dfy, ctx);
          times.push(performance.now() - t0);
          decisions++;
          kinds.add(d.kind);
          expect(isLegalIntent(dfy, intent), `${d.kind}: ${JSON.stringify(intent)}`).toBe(true);
          if (intent.type === 'USE_CARD') used.cards++;
          if (intent.type === 'USE_ITEM') used.items++;
          try {
            s = g.engine.applyAction(s, { ...intent, seat: d.seat, decisionId: d.id } as GameAction).state;
          } catch (e) {
            if (e instanceof EngineRuleError)
              throw new Error(`engine rejected ${JSON.stringify(intent)}: ${e.message}`);
            throw e;
          }
        }
      }
    }
    expect(decisions).toBeGreaterThan(5000);
    expect(used.cards).toBeGreaterThan(20);
    expect(used.items).toBeGreaterThan(20);
    for (const k of ['TURN_MENU', 'BUY_LAND', 'USE_FREE_CARD', 'SCAPEGOAT'] as DecisionKind[])
      expect(kinds).toContain(k);
    expect(percentile(times, 99)).toBeLessThan(5);
  });

  it('策略读 state.secret 时 Proxy 抛错（守卫本身有效）；OriginalAiPolicy 不读', () => {
    const g = newGame({ players: ['ai', 'ai'] });
    const s = g.state;
    const d = s.pending[0]!;
    const peek: AiPolicy = {
      id: 'basic',
      decide(view) {
        void (view as unknown as { secret: { rng: unknown } }).secret.rng;
        return { type: 'ROLL' };
      },
    };
    const view = guardedView(s);
    expect(() => peek.decide(view, decisionForSeat(d) as DecisionForYou, ctxFor(s, 0, d.id))).toThrow(/secret/);
    expect(() => OriginalAiPolicy.decide(view, decisionForSeat(d) as DecisionForYou, ctxFor(s, 0, d.id))).not.toThrow();
    expect(JSON.stringify(view)).not.toContain('aiSeed');
  });
});
