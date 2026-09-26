import type { AiPolicy } from '@rich4/shared/ai';
import { fixtureRegistry } from '@rich4/shared/data';
import type { PlayerIntent } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { describe, expect, it } from 'vitest';
import { AiDriver, makeAiContext, makeAiRng } from '../../src/game/AiDriver';
import { DEFAULT_TIMING } from '../../src/game/Deadlines';
import { silentLogger } from '../../src/infra/logger';
import { makeRunner } from '../helpers/runnerHarness';

function keysDeep(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) for (const v of x) keysDeep(v, out);
  else if (x !== null && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

function input(h: ReturnType<typeof makeRunner>) {
  const d = h.pendingOf(0)!;
  return {
    state: h.runner.state,
    decision: d,
    you: h.runner.decisionFor(0)!,
    map: fixtureRegistry.getMap('test'),
    handVisibility: 'public' as const,
  };
}

describe('AiDriver', () => {
  it('AI 拿到的视图不含 secret/flow/pending/counters，改动视图不影响权威状态', () => {
    let seen: GameView | null = null;
    const policy: AiPolicy = {
      id: 'basic',
      decide(view, d) {
        seen = view;
        view.players[0]!.cash = -1;
        return d.defaultIntent;
      },
    };
    const h = makeRunner();
    const drv = new AiDriver({ policy, log: silentLogger });
    const out = drv.decide(input(h));
    expect(out).toMatchObject({ intent: { type: 'ROLL' }, fallback: null });
    const keys = keysDeep(seen);
    for (const k of ['secret', 'rng', 'aiSeed', 'newsOrder', 'flow', 'pending', 'counters'])
      expect(keys.has(k)).toBe(false);
    expect(h.runner.state.players[0]!.cash).toBe(30000);
  });

  it('非法 intent 退回 defaultIntent：schema 不过、kind 不允许、抛异常', () => {
    const h = makeRunner();
    const mk = (fn: () => unknown) =>
      new AiDriver({ policy: { id: 'basic', decide: fn as () => PlayerIntent }, log: silentLogger });
    expect(mk(() => ({ type: 'ROLL', dice: 7 })).decide(input(h))).toMatchObject({ fallback: 'schema' });
    expect(mk(() => ({ type: 'MINIGAME_RESULT', score: 1 })).decide(input(h))).toMatchObject({ fallback: 'schema' });
    expect(mk(() => ({ type: 'CONFIRM' })).decide(input(h))).toMatchObject({
      fallback: 'notAllowed',
      intent: { type: 'ROLL' },
    });
    expect(
      mk(() => {
        throw new Error('x');
      }).decide(input(h)),
    ).toMatchObject({ fallback: 'threw', intent: { type: 'ROLL' } });
  });

  it('延迟 = 动画 × pace 倍率 + 思考时间', () => {
    const drv = new AiDriver({
      policy: { id: 'basic', decide: (_v, d) => d.defaultIntent },
      log: silentLogger,
      random: () => 0.5,
    });
    expect(drv.delayMs(2000, 'normal', DEFAULT_TIMING)).toBe(2000 + 800);
    expect(drv.delayMs(2000, 'fast', DEFAULT_TIMING)).toBe(1000 + 225);
    expect(drv.delayMs(2000, 'normal', { ...DEFAULT_TIMING, animScale: 0 })).toBe(800);
  });

  it('AI 随机数按 (aiSeed, seat, decisionId) 派生，可复现', () => {
    const base = {
      aiSeed: 123,
      seat: 1 as const,
      turnNo: 5,
      traits: { personality: 1 as const, useCards: true, useItems: true, loanRatio: 0, cashRatio: 50, stockRatio: 0 },
      map: fixtureRegistry.getMap('test'),
      handVisibility: 'public' as const,
    };
    const seq = (c: ReturnType<typeof makeAiContext>) => [c.rng.next15(), c.rng.mod(10), c.turnRng('x').next15()];
    expect(seq(makeAiContext({ ...base, decisionId: 'd1' }))).toEqual(
      seq(makeAiContext({ ...base, decisionId: 'd1' })),
    );
    expect(seq(makeAiContext({ ...base, decisionId: 'd1' }))).not.toEqual(
      seq(makeAiContext({ ...base, decisionId: 'd2' })),
    );
    const r = makeAiRng(1);
    const vals = Array.from({ length: 50 }, () => r.next15());
    expect(vals.every((v) => v >= 0 && v < 32768)).toBe(true);
  });

  it('决策已过期时不提交：真人抢先操作后 AI 定时器作废', () => {
    const h = makeRunner({ thinkMs: [3000, 3000] });
    h.runner.setAutopilot(0, true);
    h.sched.advance(1000);
    expect(h.act(0, { type: 'ROLL' }).ok).toBe(true);
    const n = h.rec.batches.length;
    h.sched.advance(2500);
    expect(h.rec.batches.slice(n).filter((b) => b.cause.seat === 0 && b.cause.intentType === 'ROLL')).toHaveLength(0);
    expect(h.rec.batches.slice(0, n).every((b) => b.cause.by === 'player')).toBe(true);
  });
});
