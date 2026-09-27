import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../../data/maps/registry';
import { findUnsourced } from '../../data/source';
import { GODS, INITIAL_GODS } from '../../data/tables/gods';
import { GOD_KINDS, type GodKind } from '../../data/tables/ids';
import { Ctx, snapshotBaseline } from '../core/ctx';
import { engineMap } from '../core/mapCache';
import { evalBlessing } from '../rules/blessing';
import { newGame } from '../testing/builders';
import { type Scenario, scenario } from '../testing/scenario';
import { GOD_EFFECTS } from './gods/index';

/**
 * 13 种神明（design/engine.md §10.5；docs/research/r_deities.md §7）：停下附身 → 发威；任期；显灵；过路费修正；投资禁令。
 * 0 号站在 5 号格（来路 4），神放在 7 号格（L3），掷 2 点停上去。
 */
function onGod(kind: GodKind, o: { vehicle?: 'walk' | 'car' } = {}): Scenario {
  const sc = scenario({ players: ['human', 'human', 'human'], config: { vehicle: o.vehicle ?? 'walk' } }).untilMenu(0);
  sc.teleport(0, 5, 4).teleport(1, 12, 11).teleport(2, 18, 17);
  return sc.placeGod(kind, 7);
}

function roll2(sc: Scenario): Scenario {
  return sc.force('dice', 2).roll(0);
}

describe('gods（13 种神明）', () => {
  it('神明表：13 种、搭档成对、任期 7（死神 13）、三项运势与 g_arbitration §2.b 一致、带出处', () => {
    expect(GOD_KINDS).toHaveLength(13);
    for (const k of GOD_KINDS) {
      const p = GODS[k].partner;
      if (p !== null) expect(GODS[p].partner).toBe(k);
    }
    expect(GODS[15]).toMatchObject({ days: 13, partner: null, luck: { bad: 1000, wealth: -200, fortune: -200 } });
    expect(GODS[1].luck).toEqual({ bad: -100, wealth: 100, fortune: 0 });
    expect(GODS[9].luck).toEqual({ bad: -100, wealth: 60, fortune: 60 });
    expect(INITIAL_GODS).toEqual([1, 3, 5, 7, 9, 11]);
    expect(findUnsourced(Object.values(GODS))).toEqual([]);
    expect(
      Object.keys(GOD_EFFECTS)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([...GOD_KINDS]);
  });

  it('加持判定：> 100 必定 high；50 < 值 ≤ 100 抛硬币；0..50 无效果；< 0 为 low', () => {
    expect(evalBlessing(150, () => 0)).toBe('high');
    expect(evalBlessing(100, () => 1)).toBe('high');
    expect(evalBlessing(100, () => 0)).toBe('none');
    expect(evalBlessing(50, () => 1)).toBe('none');
    expect(evalBlessing(0, () => 1)).toBe('none');
    expect(evalBlessing(-60, () => 1)).toBe('low');
  });

  it('开局随机摆放 6 位路面神与礼物、宝箱（互不重叠）', () => {
    const g = newGame({ players: ['ai', 'ai'] });
    const road = g.state.gods.filter((x) => x.where.t === 'road');
    expect(road.map((x) => x.kind).sort((a, b) => a - b)).toEqual([1, 3, 5, 7, 9, 11]);
    expect(g.state.objects.map((o) => o.kind).sort()).toEqual(['chest', 'gift']);
    const nodes = [...road.map((x) => (x.where as { node: number }).node), ...g.state.objects.map((o) => o.node)];
    expect(new Set(nodes).size).toBe(8);
  });

  it('1 小财神：3 位老虎机 X，每位对手付 X（进现金）；过路费 ÷2', () => {
    const sc = onGod(1);
    const cash = sc.state.players.map((p) => p.cash);
    sc.force('slot', 1, 2, 3);
    roll2(sc);
    expect(sc.event('GOD_POWER')).toMatchObject({ kind: 1, slot: { digits: 3, value: 123 } });
    expect(sc.state.players.map((p) => p.cash)).toEqual([cash[0]! + 246, cash[1]! - 123, cash[2]! - 123]);
    expect(sc.player(0)).toMatchObject({ god: { kind: 1, days: 7 }, luck: { bad: -100, wealth: 100, fortune: 0 } });
    sc.decline(0);
    // 过路费 ÷2：1 号的 L4
    sc.edit((s) => {
      Object.assign(s.lands[3]!, { owner: 1, level: 2 });
    });
    sc.untilMenu(0).teleport(0, 10, 9).force('dice', 1).roll(0);
    expect(sc.event('TOLL_PAID')).toMatchObject({ amount: 1500 >> 1, mods: expect.arrayContaining(['smallWealth']) });
  });

  it('2 大财神：4 位老虎机，得 X（铸造进现金）', () => {
    const sc = onGod(2);
    const cash = sc.player(0).cash;
    sc.force('slot', 0, 5, 0, 7);
    roll2(sc);
    expect(sc.event('GOD_POWER')).toMatchObject({
      slot: { digits: 4, value: 507 },
      transfers: [{ seat: 0, amount: 507 }],
    });
    expect(sc.player(0).cash).toBe(cash + 507);
  });

  it('3 / 4 小福神、大福神：抽 1 / 2 张卡；买地后多送 1 级（PROGRAM 照付全价）', () => {
    const sc = onGod(3);
    sc.force('deck', 20);
    roll2(sc);
    expect(sc.player(0).cards).toEqual([20]);
    const cash = sc.player(0).cash;
    sc.confirm(0);
    expect(sc.state.lands[2]).toMatchObject({ owner: 0, level: 1 });
    expect(sc.player(0).cash).toBe(cash - 2000);
    const big = onGod(4);
    big.force('deck', 20, 21);
    roll2(big);
    expect(big.player(0).cards).toEqual([20, 21]);
  });

  it('5 小穷神：付给每位对手 X（进对方存款）；过路费 ×1.5', () => {
    const sc = onGod(5);
    const dep = sc.state.players.map((p) => p.deposit);
    const cash0 = sc.player(0).cash;
    sc.force('slot', 0, 1, 0);
    roll2(sc);
    expect(sc.player(0).cash).toBe(cash0 - 20);
    expect([sc.player(1).deposit, sc.player(2).deposit]).toEqual([dep[1]! + 10, dep[2]! + 10]);
    sc.decline(0).edit((s) => {
      Object.assign(s.lands[3]!, { owner: 1, level: 2 });
    });
    sc.untilMenu(0).teleport(0, 10, 9).force('dice', 1).roll(0);
    expect(sc.event('TOLL_PAID')).toMatchObject({ amount: 1500 + 750, mods: expect.arrayContaining(['smallPoor']) });
  });

  it('6 大穷神：付 X 给银行（销毁）', () => {
    const sc = onGod(6);
    const cash = sc.player(0).cash;
    const burned = sc.state.econ.ledger.burned;
    sc.force('slot', 1, 0, 0, 0);
    roll2(sc);
    expect(sc.player(0).cash).toBe(cash - 1000);
    expect(sc.state.econ.ledger.burned - burned).toBe(1000);
  });

  it('7 / 8 小衰神、大衰神：丢 1 张 / 丢 floor(n/2) 张；禁止一切投资（INVEST_BLOCKED）', () => {
    const sc = onGod(7).give(0, { cards: [1, 2, 3] });
    sc.force('steal', 1);
    roll2(sc);
    expect(sc.player(0).cards).toEqual([1, 3]);
    sc.expectEvents(['GOD_ATTACHED', 'GOD_POWER', 'CARD_LOST', 'INVEST_BLOCKED']);
    const big = onGod(8).give(0, { cards: [1, 2, 3, 4, 5] });
    big.force('steal', 0, 0);
    roll2(big);
    expect(big.player(0).cards).toEqual([3, 4, 5]);
  });

  it('9 天使：落点 +1 级（在买地之后）', () => {
    const sc = onGod(9);
    roll2(sc).confirm(0);
    expect(sc.state.lands[2]).toMatchObject({ owner: 0, level: 1 });
    sc.expectEvents(['LAND_BOUGHT', 'GOD_MANIFEST', 'LOT_LEVEL']);
  });

  it('10 恶魔：落点有建筑就 −1 级（自己的也拆）', () => {
    const sc = onGod(10);
    sc.edit((s) => {
      Object.assign(s.lands[2]!, { owner: 0, level: 3 });
    });
    roll2(sc).decline(0);
    expect(sc.state.lands[2]!.level).toBe(2);
    sc.expectEvents(['GOD_MANIFEST', 'LOT_MUTATED']);
  });

  it('11 恶犬：步行被咬住院 3 天，恶犬离场、土地公刷出；开车撞飞后照常结算', () => {
    const sc = onGod(11);
    roll2(sc);
    expect(sc.player(0).st.hospital).toBe(3);
    expect(sc.state.gods.find((g) => g.kind === 11)!.where.t).toBe('absent');
    expect(sc.state.gods.find((g) => g.kind === 12)!.where.t).toBe('road');
    sc.expectEvents(['LANDED', 'DOG_BITE', 'GOD_LEFT', 'GOD_SPAWNED', 'CONFINED']);
    const car = onGod(11, { vehicle: 'car' });
    car.force('dice', 1, 1).roll(0, 2);
    car.expectEvents(['LANDED', 'DOG_KNOCKED', 'GOD_LEFT', 'GOD_SPAWNED']).expectAsk(0, 'BUY_LAND');
    expect(car.player(0).st.hospital).toBe(0);
  });

  it('12 土地公：不能买无主地，但落点直接强占；别人的地先付过路费再强占（等级保留）', () => {
    const sc = onGod(12);
    roll2(sc);
    sc.expectEvents(['GOD_ATTACHED', 'GOD_MANIFEST']).expectNoAsk(0, 'BUY_LAND');
    // 买地选项被屏蔽但不提示（r_deities §7.11）：不发 INVEST_BLOCKED
    expect(sc.events.map((e) => e.type)).not.toContain('INVEST_BLOCKED');
    expect(sc.state.lands[2]!.owner).toBe(0);
    sc.edit((s) => {
      Object.assign(s.lands[3]!, { owner: 1, level: 2 });
    });
    sc.untilMenu(0).teleport(0, 10, 9).force('dice', 1).roll(0);
    sc.expectEvents(['TOLL_PAID', 'GOD_MANIFEST']);
    expect(sc.state.lands[3]).toMatchObject({ owner: 0, level: 2 });
  });

  it('12 土地公：无主地（住宅、设施）不问也不提示「无法投资」，显灵直接强占', () => {
    for (const [from, prev, lot] of [
      [4, 3, 'L1'],
      [16, 15, 'F1'],
    ] as const) {
      const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
      sc.teleport(0, from, prev).attachGod(0, 12).force('dice', 1).roll(0);
      expect(sc.events.map((e) => e.type)).not.toContain('INVEST_BLOCKED');
      sc.expectEvents(['LANDED', 'GOD_MANIFEST']).expectNoAsk(0, 'BUY_LAND').expectNoAsk(0, 'BUY_FACILITY');
      const owner = lot === 'L1' ? sc.state.lands[0]!.owner : sc.state.facilities[0]!.owner;
      expect(owner).toBe(0);
    }
  });

  it('15 死神：没收卡片与道具（回牌堆、库存）；当地主免收；别人的过路费由他代付；禁止投资', () => {
    const g = newGame({ players: ['human', 'human', 'human'], board: 'clear' });
    const em = engineMap(fixtureRegistry.getMap('test'));
    const s = structuredClone(g.state);
    const ctx = new Ctx(s, em, snapshotBaseline(s), { strictSync: true });
    s.players[0]!.cards = [];
    const items = s.players[0]!.items.slice();
    GOD_EFFECTS[15].power!(ctx, 0);
    expect(s.players[0]!.items.every((n) => n === 0)).toBe(true);
    expect(s.pools.items[1]).toBe(g.state.pools.items[1]! + items[1]!);
    expect(ctx.events.map((e) => e.type)).toEqual(['GOD_POWER']);

    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 10, 9).attachGod(2, 15);
    sc.edit((x) => {
      Object.assign(x.lands[3]!, { owner: 1, level: 2 });
    });
    const cash2 = sc.player(2).cash;
    sc.force('dice', 1).roll(0);
    expect(sc.event('TOLL_PAID')).toMatchObject({ payer: 2, owner: 1, amount: 1500 });
    expect(sc.event('TOLL_PAID').mods).toContain('deathPays');
    expect(sc.player(2).cash).toBe(cash2 - 1500);
    // 当地主免收
    sc.untilMenu(0).edit((x) => {
      Object.assign(x.lands[4]!, { owner: 2, level: 1 });
    });
    sc.teleport(0, 11, 10).force('dice', 1).roll(0);
    expect(sc.event('TOLL_EXEMPT')).toMatchObject({ reason: 'ownerDeathGod' });
  });

  it('任期：7 个自己的回合后在回合开头离场，搭档刷出', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.attachGod(0, 3, 1).roll(0).untilMenu(0);
    expect(sc.player(0).god).toBeNull();
    expect(sc.log.find((e) => e.type === 'GOD_LEFT')).toMatchObject({ seat: 0, kind: 3, reason: 'expired' });
    expect(sc.state.gods.find((g) => g.kind === 4)!.where.t).toBe('road');
    expect(sc.player(0).luck).toEqual({ bad: 0, wealth: 0, fortune: 0 });
  });
});
