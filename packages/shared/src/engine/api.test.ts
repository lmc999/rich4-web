import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../data/maps/registry';
import { resolveTraits } from '../data/tables/characters';
import { createEngine, internal } from './api';
import { engineMap } from './core/mapCache';
import { EngineRuleError } from './errors';
import { act, editState, makeConfig, makeSetups, newGame, pendingOf, testEngine } from './testing/builders';
import { dbg } from './testing/debug';
import { scenario } from './testing/scenario';
import { defaultGameConfig } from './types/config';
import type { GameAction } from './types/intent';
import { checkInvariants } from './validate/invariants';

function ruleOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof EngineRuleError) return e.rule;
    throw e;
  }
}

describe('createGame（design/engine.md §5）', () => {
  it('开局：座位、资金、道具、库存、牌堆、恶人、时钟、ROOT，并运行到 0 号的 TURN_MENU', () => {
    const { state: s, events } = newGame({ players: ['human', 'ai', 'human', 'ai'] });
    expect(events.map((e) => e.type)).toEqual(['GAME_STARTED', 'TURN_STARTED', 'PARACHUTE']);
    expect(s.v).toBe(1);
    expect(s.engine).toBe('0.1.0');
    expect(s.dataRef).toEqual({
      mapId: 'test',
      mapHash: fixtureRegistry.getMap('test').def.meta.dataHash,
      tablesHash: fixtureRegistry.tablesHash,
    });
    expect(s.players.map((p) => [p.seat, p.cash, p.deposit])).toEqual([
      [0, 100000, 100000],
      [1, 80000, 120000], // 阿土伯 40%
      [2, 100000, 100000],
      [3, 120000, 80000], // 钱夫人 60%
    ]);
    expect(s.players[1]!.aiTraits).toEqual(resolveTraits(4));
    for (const p of s.players) {
      expect(p.items).toEqual([0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0]);
      expect(p.diceCount).toBe(1);
      expect(p.holdings).toHaveLength(12);
    }
    expect(s.pools.items).toEqual([0, 6, 6, 6, 6, 10, 10, 10, 6, 0, 0, 0, 0, 0]);
    expect(s.pools.cards.reduce((a, b) => a + b, 0)).toBe(100);
    expect(s.villains.map((v) => [v.kind, v.home, v.node])).toEqual([
      ['thief', 'jail', 14],
      ['robber', 'jail', 14],
      ['thug', 'hospital', 15],
      ['spy', 'hospital', 15],
    ]);
    expect(s.gods).toHaveLength(14);
    expect(s.gods.filter((g) => g.kind === 15)).toHaveLength(2);
    expect(s.companies.map((c) => [c.id, c.stock, c.reserved])).toEqual([
      ['C1', 0, 0],
      ['C2', 2, 0],
    ]);
    expect(s.clock).toMatchObject({ date: 20050505, turnNo: 1, cursor: { t: 'seat', seat: 0 }, elapsedDays: 0 });
    expect(s.players[0]!.placed).toBe(true);
    expect(s.players[1]!.placed).toBe(false);
    expect(s.secret.newsOrder).toHaveLength(36);
    expect(new Set(s.secret.newsOrder).size).toBe(36);
    expect(new Set(s.secret.fateOrder).size).toBe(37);
    const [d] = s.pending;
    expect(d).toMatchObject({ id: 'd1', seat: 0, kind: 'TURN_MENU', timing: 'menu', budgetKey: 'turn:1:0' });
    expect(d!.defaultIntent).toEqual({ type: 'ROLL' });
    expect(s.flow.map((f) => f.k)).toEqual(['ROOT', 'TURN']);
    expect(testEngine().explainState(s)).toEqual([]);
  });

  it('机车 / 汽车开局：从库存扣车，骰子数为上限；startDate 夹到 1998..2010', () => {
    const { state: s } = newGame({ config: { vehicle: 'car', startDate: 20260927 } });
    expect(s.pools.items[6]).toBe(8);
    expect(s.players[0]!.diceCount).toBe(3);
    expect(s.config.startDate).toBe(20100101);
    expect(s.clock.date).toBe(20100101);
    expect(s.pending[0]!.options).toMatchObject({ dice: { allowed: [1, 2, 3], current: 3, locked: null } });
  });

  it('配置非法抛 BAD_CONFIG', () => {
    const e = testEngine();
    const cfg = makeConfig();
    expect(ruleOf(() => e.createGame(cfg, makeSetups(['human']), 'ab'))).toBe('BAD_CONFIG');
    expect(
      ruleOf(() =>
        e.createGame(
          cfg,
          [
            { seat: 0, character: 1, controller: 'human' },
            { seat: 1, character: 1, controller: 'ai' },
          ],
          'ab',
        ),
      ),
    ).toBe('BAD_CONFIG');
    expect(ruleOf(() => e.createGame(cfg, makeSetups(['human', 'ai']), 'xyz'))).toBe('BAD_CONFIG');
    expect(ruleOf(() => e.createGame({ ...cfg, initialFund: 12345 as never }, makeSetups(['human', 'ai']), 'ab'))).toBe(
      'BAD_CONFIG',
    );
    expect(() => e.createGame({ ...cfg, mapId: 'nope' }, makeSetups(['human', 'ai']), 'ab')).toThrow(/MAP_UNAVAILABLE/);
  });
});

describe('applyAction 的校验与契约（architecture §5.2、§5.5）', () => {
  const { engine, state } = newGame({ players: ['human', 'ai'] });
  const d = state.pending[0]!;

  it('STALE_DECISION / NOT_YOUR_DECISION / INTENT_NOT_ALLOWED / BAD_ACTION', () => {
    expect(ruleOf(() => engine.applyAction(state, { type: 'ROLL', seat: 0, decisionId: 'd99' }))).toBe(
      'STALE_DECISION',
    );
    expect(ruleOf(() => engine.applyAction(state, { type: 'ROLL', seat: 1, decisionId: d.id }))).toBe(
      'NOT_YOUR_DECISION',
    );
    expect(ruleOf(() => engine.applyAction(state, { type: 'CONFIRM', seat: 0, decisionId: d.id }))).toBe(
      'INTENT_NOT_ALLOWED',
    );
    expect(
      ruleOf(() =>
        engine.applyAction(state, { type: 'ROLL', dice: 4, seat: 0, decisionId: d.id } as unknown as GameAction),
      ),
    ).toBe('BAD_ACTION');
    expect(
      ruleOf(() =>
        engine.applyAction(state, { type: 'ROLL', extra: 1, seat: 0, decisionId: d.id } as unknown as GameAction),
      ),
    ).toBe('BAD_ACTION');
  });

  it('ROLL{dice} 不得超过交通工具上限；M1 未开放的菜单操作抛 NOT_USABLE，投降抛 NOT_ALLOWED', () => {
    expect(ruleOf(() => engine.applyAction(state, { type: 'ROLL', dice: 2, seat: 0, decisionId: d.id }))).toBe(
      'OUT_OF_RANGE',
    );
    expect(
      ruleOf(() => engine.applyAction(state, { type: 'STOCK_BUY', stock: 0, shares: 10, seat: 0, decisionId: d.id })),
    ).toBe('NOT_USABLE');
    expect(ruleOf(() => engine.applyAction(state, { type: 'SURRENDER', seat: 0, decisionId: d.id }))).toBe(
      'NOT_ALLOWED',
    );
  });

  it('非终结菜单操作每回合 ≤ 40 次（MENU_LIMIT）', () => {
    const full = editState(state, (s) => {
      s.players[0]!.turn.menuActions = 40;
    });
    expect(
      ruleOf(() => engine.applyAction(full, { type: 'STOCK_SELL', stock: 0, shares: 1, seat: 0, decisionId: d.id })),
    ).toBe('MENU_LIMIT');
  });

  it('入参不被修改（devChecks 下被 deepFreeze）；决策 id 单调递增', () => {
    const json = JSON.stringify(state);
    const r = engine.applyAction(state, { type: 'ROLL', seat: 0, decisionId: d.id });
    expect(JSON.stringify(state)).toBe(json);
    expect(Object.isFrozen(state.players[0])).toBe(true);
    expect(r.state).not.toBe(state);
    const next = r.state.pending[0]!;
    expect(Number(next.id.slice(1))).toBeGreaterThan(Number(d.id.slice(1)));
    expect(r.state.counters.action).toBe(state.counters.action + 1);
  });

  it('applyInPlace 与 applyAction 结果相同', () => {
    const a = engine.applyAction(state, { type: 'ROLL', seat: 0, decisionId: d.id });
    const copy = structuredClone(state);
    const ev = engine.applyInPlace(copy, { type: 'ROLL', seat: 0, decisionId: d.id });
    expect(copy).toEqual(a.state);
    expect(ev).toEqual(a.events);
  });

  it('生产路径 createEngine：不冻结入参，行为一致', () => {
    const prod = createEngine(fixtureRegistry);
    const s = prod.createGame(makeConfig(), makeSetups(['human', 'ai']), 'c0ffee');
    expect(s).toEqual(state);
    const r = prod.applyAction(s, { type: 'ROLL', seat: 0, decisionId: s.pending[0]!.id });
    expect(Object.isFrozen(s)).toBe(false);
    expect(prod.validateState(r.state)).toBe(true);
  });
});

describe('系统 action', () => {
  it('SYS_DEBUG 需要 config.debug；否则 NOT_DEBUG', () => {
    const { engine, state } = newGame({ debug: false });
    expect(ruleOf(() => engine.applyAction(state, dbg.setCash(0, 1)))).toBe('NOT_DEBUG');
  });

  it('setCash / setPoints / teleport / give / setDate 都经 DEBUG_APPLIED 公布，台账保持守恒', () => {
    const sc = scenario({ players: ['human', 'human'] });
    sc.setCash(0, 5, 7);
    expect(sc.player(0)).toMatchObject({ cash: 5, deposit: 7 });
    expect(sc.event('DEBUG_APPLIED').post?.players?.[0]?.set).toMatchObject({ cash: 5, deposit: 7 });
    sc.apply(dbg.setPoints(1, 65535));
    expect(sc.player(1).points).toBe(65535);
    expect(() => sc.apply(dbg.setPoints(1, 70000))).toThrow(/BAD_ACTION/);
    sc.teleport(1, 9, 8);
    expect(sc.player(1)).toMatchObject({ node: 9, prevNode: 8, placed: true });
    expect(() => sc.teleport(1, 9, 2)).toThrow(/INVALID_TARGET/);
    sc.give(0, { cards: [1, 10], items: [{ item: 13, qty: 2 }] });
    expect(sc.player(0).cards.slice(-2)).toEqual([1, 10]);
    expect(sc.player(0).items[13]).toBe(2);
    expect(() => sc.give(0, { cards: [1] })).toThrow(/OUT_OF_RANGE/);
    sc.apply(dbg.setDate(19980104));
    expect(sc.state.clock).toMatchObject({ date: 19980104, weekday: 0, marketOpen: false });
    expect(() => sc.apply(dbg.setDate(19980231))).toThrow(/OUT_OF_RANGE/);
    // 待决策不受系统 action 影响
    sc.expectAsk(0, 'TURN_MENU');
  });

  it('SYS_SET_CONTROLLER / SYS_SET_AI_TRAITS', () => {
    const sc = scenario({ players: ['human', 'human'] });
    sc.apply({ type: 'SYS_SET_CONTROLLER', seat: 1, controller: 'ai' });
    expect(sc.event('CONTROLLER_CHANGED')).toMatchObject({ seat: 1, controller: 'ai' });
    expect(sc.player(1).controller).toBe('ai');
    const traits = {
      personality: 2,
      useCards: false,
      useItems: true,
      loanRatio: 0,
      cashRatio: 30,
      stockRatio: 10,
    } as const;
    sc.apply({ type: 'SYS_SET_AI_TRAITS', seat: 0, traits });
    expect(sc.player(0).aiTraits).toEqual(traits);
    expect(() => sc.apply({ type: 'SYS_SET_AI_TRAITS', seat: 0, traits: { ...traits, cashRatio: 101 } })).toThrow(
      /BAD_ACTION/,
    );
    expect(() => sc.apply({ type: 'SYS_SET_CONTROLLER', seat: 3, controller: 'ai' })).toThrow(/BAD_SEAT/);
    expect(() =>
      sc.apply({ type: 'MINIGAME_RESULT', seat: 0, decisionId: sc.pending(0).id, score: 1, logHash: 0 }),
    ).toThrow(/INTENT_NOT_ALLOWED/);
  });
});

describe('validateState / migrateState', () => {
  const e = testEngine();
  const { state } = newGame({ players: ['human', 'ai', 'ai'] });

  it('合法 state 通过；结构或不变量被破坏时不通过', () => {
    expect(e.validateState(state)).toBe(true);
    expect(e.validateState(JSON.parse(JSON.stringify(state)))).toBe(true);
    expect(e.validateState({ ...state, extra: 1 })).toBe(false);
    expect(e.validateState(null)).toBe(false);
    const bad = editState(state, (s) => {
      s.players[0]!.cash += 1;
    });
    expect(e.validateState(bad)).toBe(false);
    expect(e.explainState(bad)[0]).toMatch(/ledger/);
    const deck = editState(state, (s) => {
      s.pools.cards[3] = s.pools.cards[3]! + 1;
    });
    expect(e.explainState(deck).join()).toMatch(/card 3/);
    const orphan = editState(state, (s) => {
      s.pending[0]!.frameId = 999;
    });
    expect(e.explainState(orphan).join()).toMatch(/missing frame/);
    // 不变量 1：只含 JSON 值、金额为安全整数（绕过 schema 直接检查）
    const em = engineMap(fixtureRegistry.getMap('test'));
    const floaty = editState(state, (s) => {
      s.players[0]!.cash = 0.5;
      s.players[1]!.deposit -= 0.5;
      (s.players[2] as unknown as Record<string, unknown>).extra = undefined;
      s.stocks[0]!.momentum = 1.25;
    });
    const issues = checkInvariants(floaty, em).join('\n');
    expect(issues).toMatch(/s\.players\[0\]\.cash: not a safe integer/);
    expect(issues).toMatch(/s\.players\[2\]\.extra: undefined/);
    expect(issues).not.toMatch(/momentum/);
  });

  it('mapHash 与注册表不符：validateState 不通过，与 applyAction 的口径一致', () => {
    const wrongHash = editState(state, (s) => {
      s.dataRef.mapHash = 'deadbeef';
    });
    expect(e.validateState(wrongHash)).toBe(false);
    expect(e.explainState(wrongHash).join()).toMatch(/hash mismatch/);
    const d = pendingOf(wrongHash, wrongHash.pending[0]!.seat)!;
    expect(() => e.applyAction(wrongHash, { type: 'ROLL', seat: d.seat, decisionId: d.id })).toThrow(/hash mismatch/);
  });

  it('migrateState：v1 原样返回（深拷贝）；未来版本与非法 state 被拒绝', () => {
    const m = e.migrateState(JSON.parse(JSON.stringify(state)), 1);
    expect(m).toEqual(state);
    expect(ruleOf(() => e.migrateState(state, 2))).toBe('BAD_STATE_VERSION');
    expect(ruleOf(() => e.migrateState({ v: 1 }, 1))).toBe('BAD_STATE');
  });

  it('internal.createEngine 与 createEngine 共享同一套实现', () => {
    const i = internal.createEngine(fixtureRegistry);
    const s = i.createGame(defaultGameConfig('test', 20050505), makeSetups(['human', 'ai']), 'c0ffee');
    expect(pendingOf(s, 0)?.kind).toBe('TURN_MENU');
    expect(act(i, s, 0, { type: 'ROLL' }).state.counters.action).toBe(1);
  });
});
