import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../data/maps/registry';
import { ITEM } from '../data/tables/ids';
import { engineMap } from '../engine/core/mapCache';
import { buildTurnMenu } from '../engine/decisions/build';
import { type Scenario, scenario } from '../engine/testing/scenario';
import { simpleView } from '../engine/testing/view';
import type { AiTraits, DecisionKind, DecisionOptionsMap, PlayerIntent, SeatIndex } from '../engine/types/index';
import type { DecisionForYou, GameView } from '../view/types';
import { dicePolicy } from './decisions/turnMenu';
import { OriginalAiPolicy } from './policy';
import { cardOrItem, planCard, planItem, ring, visibleTargets } from './preRoll';
import { aiRngFromSeed, makeAiContext } from './rng';
import { AiView } from './view';

/**
 * 掷骰前的硬币二选一与骰子颗数（design/minigames-ai.md §8.1–§8.2、§9.4），以及被动卡、保释的 AI 回答（§9.7）。
 */
const map = fixtureRegistry.getMap('test');
const em = engineMap(map);

function setup(): Scenario {
  const sc = scenario({ players: ['ai', 'human', 'human'] }).untilMenu(0);
  return sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11);
}

function ctxOf(sc: Scenario, traits: Partial<AiTraits> = {}, turnNo?: number, seat: SeatIndex = 0) {
  const s = sc.state;
  return makeAiContext({
    aiSeed: s.secret.aiSeed,
    seat,
    decisionId: 'd7',
    turnNo: turnNo ?? s.clock.turnNo,
    traits: { ...s.players[seat]!.aiTraits, ...traits },
    map,
    handVisibility: 'public',
  });
}

function viewOf(sc: Scenario, seat: SeatIndex = 0): AiView {
  return new AiView(simpleView(sc.state) as GameView, seat, map);
}

function decision<K extends DecisionKind>(kind: K, seat: SeatIndex, options: DecisionOptionsMap[K]): DecisionForYou<K> {
  return { decisionId: 'd9', seat, kind, timing: 'pick', options, defaultIntent: { type: 'SKIP' }, deadlineAt: null };
}

describe('preRoll（硬币：用卡或用道具）', () => {
  it('ring：总数 ≤ n 原样，否则从 rng%N 起环形取 n 个', () => {
    expect(ring([1, 2, 3], 8, () => 0)).toEqual([1, 2, 3]);
    expect(ring([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 8, () => 7)).toEqual([7, 8, 9, 0, 1, 2, 3, 4]);
  });

  it('硬币：同一回合里只走一边；两边在不同回合都会出现', () => {
    const sc = setup().give(0, { cards: [15] });
    let cards = 0;
    let items = 0;
    for (let t = 0; t < 80; t++) {
      const o = buildTurnMenu(sc.state, em, 0);
      const ctx = ctxOf(sc, { personality: 2 }, t);
      const r = cardOrItem(viewOf(sc), o, ctx);
      const coin = ctx.turnRng('coin').bit();
      if (r?.type === 'USE_CARD') {
        cards++;
        expect(coin).toBe(1);
      }
      if (r?.type === 'USE_ITEM') {
        items++;
        expect(coin).toBe(0);
      }
    }
    expect(cards).toBeGreaterThan(0);
    expect(items).toBeGreaterThan(0);
  });

  it('useCards / useItems 关掉时不用；个性闸门：乖宝宝从不出 f7=2 的卡（冬眠）', () => {
    const sc = setup().give(0, { cards: [15] });
    const o = buildTurnMenu(sc.state, em, 0);
    for (let t = 0; t < 40; t++) {
      expect(planCard(viewOf(sc), o, ctxOf(sc, { useCards: false, personality: 2 }, t))).toBeNull();
      expect(planItem(viewOf(sc), o, ctxOf(sc, { useItems: false, personality: 2 }, t))).toBeNull();
      expect(planCard(viewOf(sc), o, ctxOf(sc, { personality: 0 }, t))).toBeNull();
    }
    let used = 0;
    for (let t = 0; t < 40; t++) if (planCard(viewOf(sc), o, ctxOf(sc, { personality: 2 }, t)) !== null) used++;
    expect(used).toBeGreaterThan(0);
  });

  it('从不使用时光机与被动卡', () => {
    const sc = setup().give(0, { cards: [18, 19, 20, 21], items: [{ item: ITEM.TIME_MACHINE, qty: 1 }] });
    sc.edit((s) => {
      for (const it of [1, 2, 3, 4, 8, 9]) {
        s.pools.items[it] = s.pools.items[it]! + s.players[0]!.items[it]!;
        s.players[0]!.items[it] = 0;
      }
    });
    const o = buildTurnMenu(sc.state, em, 0);
    for (let t = 0; t < 30; t++) {
      expect(cardOrItem(viewOf(sc), o, ctxOf(sc, { personality: 2 }, t))).toBeNull();
    }
  });

  it('OriginalAiPolicy 的 TURN_MENU：用卡之后本回合不再用第二件（turnLog 已有 card）', () => {
    const sc = setup().give(0, { cards: [15, 15] });
    let intent: PlayerIntent | null = null;
    for (let t = 0; t < 40 && intent?.type !== 'USE_CARD'; t++) {
      sc.edit((s) => {
        s.clock.turnNo = t;
      });
      const d = { ...sc.pending(0), options: buildTurnMenu(sc.state, em, 0) };
      intent = OriginalAiPolicy.decide(
        simpleView(sc.state) as GameView,
        { ...d, decisionId: d.id, deadlineAt: null } as unknown as DecisionForYou,
        ctxOf(sc, { personality: 2, stockRatio: 0 }),
      );
    }
    expect(intent?.type).toBe('USE_CARD');
    sc.act(0, intent!);
    const d2 = sc.pending(0);
    const next = OriginalAiPolicy.decide(
      simpleView(sc.state) as GameView,
      { ...d2, decisionId: d2.id, deadlineAt: null } as unknown as DecisionForYou,
      ctxOf(sc, { personality: 2, stockRatio: 0 }),
    );
    expect(next.type).toBe('ROLL');
  });
});

describe('preRoll：AI 视野固定半宽 220（DEV-04）', () => {
  it('targetRange=global 时引擎候选超出视野：判据前先收窄，陷害 / 查税不会选视野外的最恨的人', () => {
    // test-allkinds：0 号在 1 号格 (64,64)，1 号在 5 号格 (192,64)，2 号在 26 号格 (512,96)，在 440 视野外
    const allkinds = fixtureRegistry.getMap('test-allkinds');
    const aem = engineMap(allkinds);
    const sc = scenario({ map: 'test-allkinds', players: ['ai', 'human', 'human'], rules: { targetRange: 'global' } })
      .untilMenu(0)
      .teleport(0, 1, 18)
      .teleport(1, 5, 4)
      .teleport(2, 26, 25)
      .give(0, { cards: [17, 26] })
      .setCash(1, 200000, 0)
      .setCash(2, 900000, 0)
      .edit((s) => (s.players[0]!.hostility[2] = 999));
    const v = new AiView(simpleView(sc.state) as GameView, 0, allkinds);
    const o = buildTurnMenu(sc.state, aem, 0);
    const harm = o.cards.find((r) => r.card === 17)!;
    const tax = o.cards.find((r) => r.card === 26)!;
    expect(harm.targets).toMatchObject({ t: 'actor', actors: expect.arrayContaining([{ t: 'seat', seat: 2 }]) });
    expect(visibleTargets(v, harm.targets)).toEqual({ t: 'actor', actors: [{ t: 'seat', seat: 1 }] });
    expect(visibleTargets(v, tax.targets)).toEqual({ t: 'seat', seats: [1] });
    let used = 0;
    for (let t = 0; t < 40; t++) {
      const ctx = makeAiContext({
        aiSeed: sc.state.secret.aiSeed,
        seat: 0,
        decisionId: 'd7',
        turnNo: t,
        traits: { ...sc.state.players[0]!.aiTraits, personality: 2 },
        map: allkinds,
        handVisibility: 'public',
      });
      const r = planCard(v, o, ctx);
      if (r === null) continue;
      used++;
      expect(r.type === 'USE_CARD' && r.target).not.toMatchObject({ seat: 2 });
      expect(r.type === 'USE_CARD' && r.target).not.toMatchObject({ actor: { seat: 2 } });
    }
    expect(used).toBeGreaterThan(0);
  });
});

describe('dice（骰子颗数策略）', () => {
  it('身背定时炸弹引信 < 15 只掷 1 颗；引信 ≥ 15 汽车默认 3 颗（前瞻 5 格没有特殊情况时）', () => {
    const sc = scenario({ players: ['ai', 'human'], config: { vehicle: 'car' } }).untilMenu(0);
    // 7 号格往前 5 格：8、9、10（企业）、11、12（1 号的 L4、L5）→ safe 0、hostile 2，保持默认
    sc.teleport(0, 7, 6).edit((s) => {
      s.players[0]!.bomb = { fuse: 14 };
      s.pools.items[4] = s.pools.items[4]! - 1;
      for (const l of s.lands.slice(3, 5)) Object.assign(l, { owner: 1, level: 1 });
    });
    const o = buildTurnMenu(sc.state, em, 0);
    expect(dicePolicy(viewOf(sc), o, ctxOf(sc))).toBe(1);
    sc.edit((s) => {
      s.players[0]!.bomb = { fuse: 20 };
    });
    expect(dicePolicy(viewOf(sc), o, ctxOf(sc))).toBe(3);
  });

  it('前瞻 5 格：safe ≥ 2 且 hostile ≤ 1 → 1 颗；safe == 0 且 hostile > 2 → 汽车 2 + rng.bit()', () => {
    const sc = scenario({ players: ['ai', 'human'], config: { vehicle: 'car' } }).untilMenu(0);
    sc.teleport(0, 4, 3);
    const o = buildTurnMenu(sc.state, em, 0);
    expect(dicePolicy(viewOf(sc), o, ctxOf(sc))).toBe(1);
    sc.edit((s) => {
      for (const l of s.lands.slice(0, 3)) Object.assign(l, { owner: 1, level: 1 });
    });
    expect([2, 3]).toContain(dicePolicy(viewOf(sc), o, ctxOf(sc)));
  });
});

describe('passive（免费卡、嫁祸卡、保释的 AI 回答）', () => {
  it('USE_FREE_CARD：金额 > 现金或 > (rng%3000+3000)·PI 才用', () => {
    const sc = setup();
    const v = viewOf(sc);
    const d = (amount: number) =>
      decision('USE_FREE_CARD', 0, { context: 'toll', amount, payer: 0, lot: 'L4', slot: 0 });
    expect(OriginalAiPolicy.decide(v.view, d(6000), ctxOf(sc))).toEqual({ type: 'CONFIRM' });
    expect(OriginalAiPolicy.decide(v.view, d(2999), ctxOf(sc))).toEqual({ type: 'DECLINE' });
  });

  it('SCAPEGOAT：陷害一律用（最恨的人优先）；过路费金额小于 4000·PI 不用；查税看自己现金', () => {
    const sc = setup().edit((s) => {
      s.players[0]!.hostility[2] = 7;
    });
    const v = viewOf(sc);
    const d = (context: 'frame' | 'toll' | 'taxAudit', amount: number | null) =>
      decision('SCAPEGOAT', 0, { context, amount, days: null, candidates: [1, 2], slot: 0 });
    expect(OriginalAiPolicy.decide(v.view, d('frame', null), ctxOf(sc))).toEqual({ type: 'SCAPEGOAT', target: 2 });
    expect(OriginalAiPolicy.decide(v.view, d('toll', 3999), ctxOf(sc))).toEqual({ type: 'DECLINE' });
    expect(OriginalAiPolicy.decide(v.view, d('toll', 9000), ctxOf(sc))).toEqual({ type: 'SCAPEGOAT', target: 2 });
    const cash = sc.player(0).cash;
    expect(OriginalAiPolicy.decide(v.view, d('taxAudit', 1000), ctxOf(sc)).type).toBe(
      cash >= 20000 ? 'SCAPEGOAT' : 'DECLINE',
    );
  });

  it('BAIL：先抛硬币；乖宝宝只保释玩家（点券 > 30），大老奸只雇恶人（本期不可雇 → 不理会）', () => {
    const sc = setup().setPoints(0, 100);
    const o = {
      where: 'jail' as const,
      points: 100,
      inmates: [{ seat: 1 as SeatIndex, remaining: 3 }],
      villains: [{ kind: 'thief' as const, available: false }],
      costs: { bail: 30, hire: 300 },
    };
    let bailed = 0;
    for (let i = 0; i < 40; i++) {
      const ctx = { ...ctxOf(sc, { personality: 0 }), rng: aiRngFromSeed(1000 + i) };
      const r = OriginalAiPolicy.decide(viewOf(sc).view, decision('BAIL', 0, o), ctx);
      if (r.type === 'BAIL') {
        bailed++;
        expect(r).toEqual({ type: 'BAIL', target: 1 });
      } else expect(r).toEqual({ type: 'SKIP' });
      const cunning = { ...ctxOf(sc, { personality: 2 }), rng: aiRngFromSeed(1000 + i) };
      expect(OriginalAiPolicy.decide(viewOf(sc).view, decision('BAIL', 0, o), cunning)).toEqual({ type: 'SKIP' });
    }
    expect(bailed).toBeGreaterThan(8);
    expect(bailed).toBeLessThan(32);
  });
});
