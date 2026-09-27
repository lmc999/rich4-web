import { describe, expect, it } from 'vitest';
import { CMB } from '../../data/tables/combat';
import { ECON } from '../../data/tables/economy';
import { type Scenario, scenario } from '../testing/scenario';
import type { GameEvent } from '../types/events';
import type { SeatIndex, TileId, VillainKind } from '../types/ids';
import type { GameState } from '../types/state';

/**
 * villain：四大恶人（docs/research/g_villains.md 全文为规格）与乞丐。fixture 'test'：
 *   1 银行(C1) → 2 → 3 → 4 卡片 → 5 L1 → 6 L2 → 7 L3 → 8 → 9 → 10 百货(C2) → 11 L4 → 12 L5 → 13 岔路 → 14 监狱 → 15 医院
 *   → 16 → 17/18 F1 → 1。关押格与保释格相同（14 监狱、15 医院），所以放出来就算「离开过门口」。
 * villainRound：0 号走到 4 号卡片格结束回合 → setup（摆恶人、受害者、强制步数 / 岔路）→ 1 号走到 4 号 → 恶人段行动。
 */
function arena(): Scenario {
  return scenario({ players: ['human', 'human'] }).untilMenu(0);
}

/** 直接把恶人摆到棋盘上（雇主 employer） */
function placeVillain(
  sc: Scenario,
  kind: VillainKind,
  employer: SeatIndex,
  node: TileId,
  prev: TileId,
  o: { leftHome?: boolean } = {},
): Scenario {
  return sc.edit((s) => {
    const v = s.villains.find((x) => x.kind === kind)!;
    Object.assign(v, { onBoard: true, employer, node, prevNode: prev, leftHome: o.leftHome ?? true });
  });
}

/** 走完一轮让恶人行动：steps = 恶人步数（2..10）；forks = 恶人经过岔路时的候选下标 */
function villainRound(
  sc: Scenario,
  steps: number | null,
  setup: (sc: Scenario) => void,
  forks: number[] = [],
): Scenario {
  sc.teleport(0, 3, 2).force('dice', 1).roll(0);
  setup(sc);
  if (steps !== null) sc.force('villainSteps', steps - ECON.VILLAIN_STEPS_MIN);
  // 1 号那一步（单一候选）也消耗一次岔路随机数
  if (forks.length > 0) sc.force('fork', 0, ...forks);
  sc.teleport(1, 3, 2).force('dice', 1).roll(1);
  return sc;
}

function actions(sc: Scenario): Extract<GameEvent, { type: 'VILLAIN_ACTION' }>[] {
  return sc.events.filter((e): e is Extract<GameEvent, { type: 'VILLAIN_ACTION' }> => e.type === 'VILLAIN_ACTION');
}

function villain(s: GameState, kind: VillainKind) {
  return s.villains.find((v) => v.kind === kind)!;
}

describe('villain（四大恶人）', () => {
  it('villain 雇用：停在监狱格、点券 ≥ 300 时 BAIL 列出可雇的恶人；HIRE 扣 300 点券，恶人从关押格出发', () => {
    const sc = arena();
    sc.teleport(0, 4, 3).force('dice', 1).roll(0).decline(0);
    sc.setPoints(1, 299).teleport(1, 15, 16).force('dice', 1).roll(1);
    // 点券不足、也没有在押玩家：不问
    sc.expectNoAsk(1, 'BAIL');
    const h = arena();
    h.teleport(0, 4, 3).force('dice', 1).roll(0).decline(0);
    h.setPoints(1, 700).teleport(1, 15, 16).force('dice', 1).roll(1).expectAsk(1, 'BAIL');
    expect(h.pending(1).options).toMatchObject({
      where: 'jail',
      inmates: [],
      villains: [
        { kind: 'thief', available: true },
        { kind: 'robber', available: true },
      ],
      costs: { bail: 30, hire: ECON.HIRE_POINTS },
    });
    h.force('villainSteps', 0).force('fork', 1).act(1, { type: 'HIRE', villain: 'thief' });
    expect(h.event('VILLAIN_HIRED')).toMatchObject({ by: 1, kind: 'thief', cost: 300 });
    expect(h.player(1).points).toBe(400);
    // 放出来的同一轮、所有玩家行动完之后就轮到恶人：14 → 15 → 16
    h.expectEvents(['VILLAIN_HIRED', 'TURN_ENDED', 'TURN_STARTED', 'MOVE_SEGMENT', 'TURN_ENDED', 'DAY_ADVANCED']);
    expect(h.events.find((e) => e.type === 'MOVE_SEGMENT' && e.actor.t === 'villain')).toMatchObject({
      actor: { t: 'villain', kind: 'thief' },
      path: [15, 16],
    });
    expect(villain(h.state, 'thief')).toMatchObject({ onBoard: true, employer: 1, node: 16, home: 'jail' });
  });

  it('villain 小偷：每走进一格偷走本格第一位非雇主玩家一半点券（>>1）给雇主；也捡礼物、宝箱与路障、地雷、炸弹', () => {
    const sc = placeVillain(arena(), 'thief', 1, 5, 4);
    villainRound(sc, 4, (x) => {
      x.teleport(0, 6, 5).setPoints(0, 101).setPoints(1, 0);
      x.placeObject('chest', 7).placeObject('mine', 8).placeObject('roadblock', 9);
    });
    const acts = actions(sc);
    expect(acts[0]).toMatchObject({ kind: 'thief', employer: 1, victim: 0, what: 'stealPoints', amount: 50 });
    expect(acts.slice(1).map((a) => a.what)).toEqual(['stealObject', 'stealObject', 'stealObject']);
    expect(sc.player(0).points).toBe(51);
    expect(sc.player(1).points).toBe(50 + CMB.THIEF_CHEST_POINTS);
    // 路障拦不住小偷；地雷、路障回库存后各发一件给雇主
    expect(villain(sc.state, 'thief').node).toBe(9);
    expect(sc.state.objects).toEqual([]);
    expect(sc.player(1).items[2]).toBe(2);
    expect(sc.player(1).items[3]).toBe(2);
  });

  it('villain 强盗：每走进一格抢第一位非雇主玩家一张卡给雇主；路过银行时每位非雇主玩家付存款的 20%（先存款后现金，进雇主现金）', () => {
    const sc = placeVillain(arena(), 'robber', 1, 17, 16);
    villainRound(sc, 2, (x) => {
      x.teleport(0, 18, 17)
        .give(0, { cards: [13] })
        .setCash(0, 1000, 50001)
        .setCash(1, 0, 0);
      x.force('steal', x.player(0).cards.indexOf(13));
    });
    const acts = actions(sc);
    expect(acts[0]).toMatchObject({ kind: 'robber', victim: 0, what: 'stealCard' });
    expect(acts[1]).toMatchObject({ kind: 'robber', victim: null, what: 'robDeposit', amount: 10000 });
    // 0 号手里：卡片格抽到的一张 + 13；抢到的正好是 13（强制 steal 下标）
    expect(sc.player(1).cards).toContain(13);
    expect(sc.player(0).cards).not.toContain(13);
    expect(sc.player(0).deposit).toBe(40001);
    expect(sc.player(1).cash).toBe(10000);
  });

  it('villain 流氓：停下的那一格收 Σ(同地主同路段地价) × PI（设施按地价 × PI），进雇主存款；路过不收', () => {
    const sc = placeVillain(arena(), 'thug', 1, 4, 3).edit((s) => {
      for (const l of s.lands.slice(0, 3)) l.owner = 0;
      s.lands[1]!.level = 3;
      s.econ.priceIndex = 2;
    });
    const dep1 = sc.player(1).deposit;
    villainRound(sc, 3, () => {});
    // 4 → 5 → 6 → 7：停在 L3（地主 0 号），S01 三块同主：(2000 × 3) × 2
    expect(actions(sc)).toEqual([expect.objectContaining({ what: 'extort', victim: 0, amount: 12000 })]);
    expect(sc.player(1).deposit).toBe(dep1 + 12000);
    const f = placeVillain(arena(), 'thug', 1, 16, 15).edit((s) => {
      Object.assign(s.facilities[0]!, { owner: 0, level: 2, type: 'hotel' });
    });
    villainRound(f, 2, () => {});
    expect(actions(f)).toEqual([expect.objectContaining({ what: 'extort', amount: 4000 })]);
  });

  it('villain 间谍：停在别人的地上取走最近一次过路费；停在企业（董事长不是雇主）取走本月盈余', () => {
    const sc = placeVillain(arena(), 'spy', 1, 5, 4).edit((s) => {
      Object.assign(s.lands[2]!, { owner: 0, level: 1, lastToll: 777 });
    });
    villainRound(sc, 2, () => {});
    expect(actions(sc)).toEqual([expect.objectContaining({ what: 'spyToll', victim: 0, amount: 777 })]);
    const c = placeVillain(arena(), 'spy', 1, 17, 16).edit((s) => {
      s.players[0]!.holdings[0] = { shares: 100, costCents: 0 };
      s.stocks[0]!.float -= 100;
      s.stocks[0]!.chairman = 0;
      s.companies[0]!.surplusMonth = 3000;
      s.companies[0]!.surplusTotal = 3000;
      s.econ.ledger.minted += 3000;
    });
    const dep1 = c.player(1).deposit;
    // 17 → 18 → 1（银行格，企业 C1）
    villainRound(c, 2, () => {});
    expect(actions(c)).toEqual([expect.objectContaining({ what: 'spySurplus', victim: 0, amount: 3000 })]);
    expect(c.state.companies[0]!.surplusMonth).toBe(0);
    expect(c.player(1).deposit).toBe(dep1 + 3000);
  });

  it('villain 路障拦住强盗、流氓、间谍（按停下处理）；地雷只在停下时炸（送医院）；恶犬咬（送医院）', () => {
    const rb = placeVillain(arena(), 'thug', 1, 4, 3).edit((s) => {
      s.lands[1]!.owner = 0;
    });
    villainRound(rb, 5, (x) => x.placeObject('roadblock', 6));
    expect(rb.event('ROADBLOCK_HIT')).toMatchObject({ actor: { t: 'villain', kind: 'thug' }, node: 6 });
    expect(villain(rb.state, 'thug').node).toBe(6);
    expect(actions(rb)).toEqual([expect.objectContaining({ what: 'extort', amount: 2000 })]);
    const mine = placeVillain(arena(), 'robber', 1, 4, 3);
    villainRound(mine, 3, (x) => x.placeObject('mine', 6).placeObject('mine', 7));
    // 路过 6 不炸，停在 7 炸
    expect(mine.state.objects.map((o) => o.node)).toEqual([6]);
    expect(villain(mine.state, 'robber')).toMatchObject({ onBoard: false, home: 'hospital', employer: null, node: 15 });
    const dog = placeVillain(arena(), 'spy', 1, 4, 3);
    villainRound(dog, 2, (x) => x.placeGod(11, 6));
    expect(villain(dog.state, 'spy')).toMatchObject({ onBoard: false, home: 'hospital' });
    expect(dog.event('GOD_LEFT')).toMatchObject({ kind: 11, reason: 'bitten' });
  });

  it('villain 回老家：第二次踩到出身的关押格（离开过门口）就被送回关押，雇用结束', () => {
    const sc = placeVillain(arena(), 'thief', 1, 12, 11, { leftHome: true });
    // 12 → 13（岔路：候选 [20, 14]，取 14）→ 14 监狱：回老家
    villainRound(sc, 5, () => {}, [0, 1]);
    expect(sc.event('VILLAIN_HOME')).toMatchObject({ kind: 'thief' });
    expect(villain(sc.state, 'thief')).toMatchObject({ onBoard: false, employer: null, node: 14 });
    const first = placeVillain(arena(), 'thief', 1, 12, 11, { leftHome: false });
    villainRound(first, 2, () => {}, [0, 1]);
    expect(villain(first.state, 'thief')).toMatchObject({ onBoard: true, node: 14, leftHome: true });
  });

  it('villain 雇主破产：他雇的恶人被送回（小偷、强盗回监狱，流氓、间谍回医院）', () => {
    const sc = placeVillain(arena(), 'thug', 0, 5, 4);
    sc.setCash(0, 0, 0).edit((s) => {
      s.players[0]!.loan = 1000;
      s.players[0]!.loanDue = 20050506;
    });
    sc.teleport(0, 3, 2).force('dice', 1).roll(0);
    sc.teleport(1, 3, 2).force('dice', 1).force('villainSteps', 0).roll(1);
    expect(sc.player(0).alive).toBe(false);
    expect(villain(sc.state, 'thug')).toMatchObject({ onBoard: false, employer: null, home: 'hospital', node: 15 });
  });

  it('villain 冬眠 / 停留：本回合不动；乌龟：只走 1 步；梦游：照常走但不偷不抢', () => {
    const hib = placeVillain(arena(), 'thief', 1, 5, 4).edit((s) => {
      villain(s, 'thief').st.hibernate = 3;
    });
    villainRound(hib, null, () => {});
    expect(villain(hib.state, 'thief').node).toBe(5);
    const tor = placeVillain(arena(), 'thief', 1, 5, 4).edit((s) => {
      villain(s, 'thief').st.tortoise = 3;
    });
    villainRound(tor, null, () => {});
    expect(villain(tor.state, 'thief').node).toBe(6);
    const sw = placeVillain(arena(), 'thief', 1, 5, 4).edit((s) => {
      villain(s, 'thief').st.sleepwalk = 3;
    });
    villainRound(sw, 2, (x) => x.teleport(0, 6, 5).setPoints(0, 100));
    expect(actions(sw)).toEqual([]);
    expect(sw.player(0).points).toBe(100);
  });

  it('villain 不作用于雇主；同格多人只作用于座位最小的非雇主；乞丐（出局者）在最前面时作罢', () => {
    const sc = placeVillain(scenario({ players: ['human', 'human', 'human'] }).untilMenu(0), 'thief', 2, 5, 4);
    sc.teleport(0, 3, 2).force('dice', 1).roll(0);
    sc.teleport(1, 3, 2).force('dice', 1).roll(1);
    sc.teleport(0, 6, 5).teleport(1, 6, 5).setPoints(0, 10).setPoints(1, 80);
    sc.force('villainSteps', 0).teleport(2, 3, 2).force('dice', 1).roll(2);
    expect(actions(sc)).toEqual([expect.objectContaining({ victim: 0, amount: 5 })]);
    expect(sc.player(1).points).toBe(80);
  });
});

describe('beggar（乞丐）', () => {
  it('beggar：出局者的棋子留在原格；别人停在那一格施舍 1000 × PI 进公库，乞丐随后换位；恶人不理会乞丐', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.edit((s) => {
      const p = s.players[2]!;
      p.alive = false;
      p.out = 'bankrupt';
      s.econ.ledger.burned += p.cash + p.deposit;
      p.cash = 0;
      p.deposit = 0;
      for (const it of [1, 2, 3, 4, 8]) {
        s.pools.items[it] = s.pools.items[it]! + p.items[it]!;
        p.items[it] = 0;
      }
      p.items[9] = 0;
      s.beggars.push({ seat: 2, node: 5 });
      s.econ.priceIndex = 3;
    });
    const pool = sc.state.econ.pool;
    sc.teleport(0, 4, 3).force('dice', 1).roll(0);
    expect(sc.event('BEGGAR_ALMS')).toMatchObject({ payer: 0, beggar: 2, amount: ECON.BEGGAR_ALMS * 3 });
    expect(sc.state.econ.pool).toBe(pool + 3000);
    expect(sc.state.beggars[0]!.node).not.toBe(5);
  });
});
