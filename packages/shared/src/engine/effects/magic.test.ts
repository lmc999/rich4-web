import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../../data/maps/registry';
import { ITEM } from '../../data/tables/ids';
import { engineMap } from '../core/mapCache';
import { type Scenario, scenario } from '../testing/scenario';
import type { MagicConditionId, MagicEffectId, SeatIndex } from '../types/ids';
import type { GameState } from '../types/state';
import { magicTargets } from './magic/index';

/**
 * magic：魔法屋 12 个条件、12 种效果（design/engine.md §10.8，按 docs/research/events-from-exe.md §3、§4 修正）。
 * fixture 'test-allkinds'：0 号从 8 号格掷 1 点停到 9 号魔法屋；条件用 force('magicCond', 条件号)。
 * 默认角色：0 号孙小美（女）、1 号阿土伯（男）、2 号约翰乔（男）。
 */
const em = engineMap(fixtureRegistry.getMap('test-allkinds'));

function arena(players: ('human' | 'ai')[] = ['human', 'human', 'human']): Scenario {
  const sc = scenario({ map: 'test-allkinds', players }).untilMenu(0);
  return sc.teleport(1, 6, 5).teleport(2, 12, 11);
}

/** 0 号停到魔法屋、抽到条件 cond，施放 effect */
function cast(sc: Scenario, cond: MagicConditionId, effect: MagicEffectId): Scenario {
  sc.teleport(0, 8, 7).force('magicCond', cond).force('dice', 1).roll(0, 1);
  sc.expectAsk(0, 'MAGIC_CAST');
  return sc.act(0, { type: 'MAGIC_CAST', effect });
}

function targets(s: GameState, cond: MagicConditionId): SeatIndex[] {
  return magicTargets(s, em, cond);
}

describe('magic（魔法屋）', () => {
  it('magic 条件 0–5：最多者（并列全选）；0 总资产连 0 也参选，1–5 数值为 0 的不参选', () => {
    const sc = arena().edit((s) => {
      Object.assign(s.lands[0]!, { owner: 1, level: 2 });
      Object.assign(s.lands[3]!, { owner: 2, level: 0 });
      s.players[0]!.points = 50;
      s.players[2]!.points = 50;
    });
    expect(targets(sc.state, 0)).toEqual([1]);
    expect(targets(sc.state, 1)).toEqual([1, 2]);
    expect(targets(sc.state, 2)).toEqual([1]);
    expect(targets(sc.state, 5)).toEqual([0, 2]);
    const zero = arena().setCash(0, 0, 0).setCash(1, 0, 0).setCash(2, 0, 0);
    expect(targets(zero.state, 1)).toEqual([]);
    expect(targets(zero.state, 3)).toEqual([]);
    expect(targets(zero.state, 4)).toEqual([]);
    expect(targets(zero.state, 5)).toEqual([]);
    expect(targets(zero.state, 0)).toEqual([0, 1, 2]);
  });

  it('magic 条件 6–11：步行 / 机车 / 汽车、神明附身、男生、女生', () => {
    const sc = arena()
      .edit((s) => {
        s.players[1]!.vehicle = 'moto';
        s.pools.items[5] = s.pools.items[5]! - 1;
        s.players[2]!.vehicle = 'car';
        s.pools.items[6] = s.pools.items[6]! - 1;
      })
      .attachGod(2, 3);
    expect(targets(sc.state, 6)).toEqual([0]);
    expect(targets(sc.state, 7)).toEqual([1]);
    expect(targets(sc.state, 8)).toEqual([2]);
    expect(targets(sc.state, 9)).toEqual([2]);
    expect(targets(sc.state, 10)).toEqual([1, 2]);
    expect(targets(sc.state, 11)).toEqual([0]);
  });

  it('magic：条件 rand % 12，名单为空就重抽；MAGIC_CONDITION → MAGIC_CAST（全部 12 种可选）', () => {
    const sc = arena();
    // 条件 1（地产最多）没人有地 → 重抽 → 条件 11（女生：0 号）
    sc.teleport(0, 8, 7).force('magicCond', 1, 11).force('dice', 1).roll(0, 1);
    expect(sc.event('MAGIC_CONDITION')).toMatchObject({ caster: 0, cond: 11, targets: [0] });
    sc.expectAsk(0, 'MAGIC_CAST');
    expect(sc.pending(0).options).toEqual({
      condition: 11,
      targets: [0],
      effects: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    });
    // 名单含自己时默认得一张卡（6）
    expect(sc.pending(0).defaultIntent).toEqual({ type: 'MAGIC_CAST', effect: 6 });
    const n = sc.player(0).cards.length;
    sc.pass();
    expect(sc.event('MAGIC_CAST')).toMatchObject({ caster: 0, effect: 6, targets: [0] });
    expect(sc.player(0).cards).toHaveLength(n + 1);
  });

  it('magic 效果 0 / 8：卡片、道具（座驾先折回道具）全部按商店价全价折点券', () => {
    const sc = arena()
      .give(1, { cards: [1, 30] })
      .give(2, { cards: [9] });
    cast(sc, 10, 0);
    expect(sc.player(1)).toMatchObject({ cards: [], points: 270 });
    expect(sc.player(2)).toMatchObject({ cards: [], points: 160 });
    const it = arena().edit((s) => {
      s.players[1]!.vehicle = 'moto';
      s.pools.items[5] = s.pools.items[5]! - 1;
    });
    cast(it, 7, 8);
    // 开局道具 155 + 机车 80
    expect(it.player(1)).toMatchObject({ points: 235, vehicle: 'walk' });
    expect(it.player(1).items.every((n) => n === 0)).toBe(true);
    // 原版 0x4446de 只刷新外观：via 'sold' 让客户端不弹「换乘」提示
    expect(it.events.filter((e) => e.type === 'VEHICLE')).toMatchObject([
      { seat: 1, vehicle: 'walk', dice: 1, via: 'sold', from: 'moto' },
    ]);
  });

  it('magic 效果 8：开着工程车时按原版折成 12 号道具一起卖（得 150 点券、不回库存），改回步行单独发 VEHICLE', () => {
    const sc = arena().edit((s) => {
      const p = s.players[1]!;
      p.items.forEach((n, it) => {
        if (it >= 1 && it <= 8) s.pools.items[it] = s.pools.items[it]! + n;
      });
      p.items = p.items.map(() => 0);
      p.points = 0;
      p.vehicle = 'engineer';
      p.diceCount = 1;
      p.engineer = { days: 7, restore: 'walk', dice: 1 };
    });
    const pool12 = sc.state.pools.items[ITEM.ENGINEERING_VEHICLE];
    cast(sc, 10, 8);
    // exe 0x4446de：模式 & 3 == 3 → 背包 12 号 +1（0x444728），再按价卖掉；12 号不回库存
    expect(sc.player(1)).toMatchObject({ vehicle: 'walk', diceCount: 1, engineer: null, points: 150 });
    expect(sc.player(1).items.every((n) => n === 0)).toBe(true);
    expect(sc.state.pools.items[ITEM.ENGINEERING_VEHICLE]).toBe(pool12);
    const v = sc.event('VEHICLE');
    expect(v).toMatchObject({ seat: 1, vehicle: 'walk', dice: 1, via: 'sold', from: 'engineer' });
    expect(v.post?.players?.find((x) => x.seat === 1)?.set).toMatchObject({ vehicle: 'walk', engineer: null });
    expect(sc.events.filter((e) => e.type === 'ITEM_LOST' && e.seat === 1)).toMatchObject([
      { item: ITEM.ENGINEERING_VEHICLE, qty: 1, cause: 'magic' },
    ]);
    // 这次 action 里其他事件的 post 都不再含 1 号的座驾变化
    for (const e of sc.events) {
      if (e === v) continue;
      const set = e.post?.players?.find((x) => x.seat === 1)?.set as Record<string, unknown> | undefined;
      expect(set?.vehicle).toBeUndefined();
    }
  });

  it('magic 效果 1：连抽三张命运（按目标自己的加持判定）', () => {
    const m = arena();
    m.stackDeck('fate', [20, 21, 22]);
    const c1 = m.player(1).cash;
    cast(m, 10, 1);
    const fates = m.events.filter((e) => e.type === 'FATE');
    expect(fates.map((e) => (e.type === 'FATE' ? [e.seat, e.id] : null))).toEqual([
      [1, 20],
      [1, 21],
      [1, 22],
      [2, expect.any(Number)],
      [2, expect.any(Number)],
      [2, expect.any(Number)],
    ]);
    expect(m.player(1).cash).toBe(c1 + 1000 + 2000 + 3000);
  });

  it('magic 效果 2 / 10：敌意 +90 × PI（即使被免罪卡挡下）→ 免罪 → 嫁祸 → 坐牢 / 住院 3 天', () => {
    const sc = arena().give(1, { cards: [21] });
    cast(sc, 10, 2);
    expect(sc.event('PASSIVE')).toMatchObject({ seat: 1, card: 21 });
    expect(sc.player(1).hostility[0]).toBe(90);
    expect(sc.player(1).st.jail).toBe(0);
    expect(sc.event('CONFINED')).toMatchObject({ actor: { t: 'seat', seat: 2 }, where: 'jail', days: 3 });
    expect(sc.player(2).hostility[0]).toBe(90);
    const h = arena();
    cast(h, 11, 10);
    // 名单只有施法者自己：对自己不记敌意
    expect(h.event('CONFINED')).toMatchObject({ actor: { t: 'seat', seat: 0 }, where: 'hospital', days: 3 });
    expect(h.player(0).hostility).toEqual([0, 0, 0, 0]);
  });

  it('magic 效果 3 停留 +1；4 现金全部存入；6 得一张卡；7 原地向后转（受困者跳过）', () => {
    const a = arena();
    cast(a, 11, 3);
    expect(a.event('STATUS_SET')).toMatchObject({ actor: { t: 'seat', seat: 0 }, status: 'stay', value: 1 });
    const b = arena();
    const { cash, deposit } = b.player(1);
    cast(b, 10, 4);
    expect(b.player(1)).toMatchObject({ cash: 0, deposit: cash + deposit });
    const c = arena();
    cast(c, 10, 6);
    expect(c.player(1).cards).toHaveLength(1);
    expect(c.player(2).cards).toHaveLength(1);
    const d = arena().edit((s) => {
      s.players[2]!.st.jail = 3;
      s.players[2]!.node = 14;
      s.players[2]!.prevNode = 14;
    });
    cast(d, 10, 7);
    expect(d.events.filter((e) => e.type === 'REVERSED')).toEqual([
      expect.objectContaining({ actor: { t: 'seat', seat: 1 } }),
    ]);
    expect(d.player(1).prevNode).toBe(7);
    // 在押的人来路不变（原版 v2.06 0x43152a 同样跳过计数非 0 的人），获释后仍从关押格随机出发
    expect(d.player(2)).toMatchObject({ node: 14, prevNode: 14 });
  });

  it('magic：首回合还没跳伞的人也可能被选中：关押直接落在监狱（之后不再跳伞），向后转跳过', () => {
    const unplaced = (s: GameState) => {
      const p = s.players[2]!;
      p.placed = false;
      p.node = 0;
      p.prevNode = 0;
    };
    const j = arena().edit(unplaced);
    cast(j, 10, 2);
    expect(j.player(2)).toMatchObject({ placed: true, node: em.index.jailHold, prevNode: em.index.jailHold });
    expect(j.events.some((e) => e.type === 'PARACHUTE' && e.seat === 2)).toBe(false);
    expect(j.events).toContainEqual(expect.objectContaining({ type: 'TURN_BLOCKED', seat: 2, reason: 'jail' }));
    expect(j.player(2).st.jail).not.toBe(0);
    const r = arena().edit(unplaced);
    cast(r, 10, 7);
    expect(r.events.filter((e) => e.type === 'REVERSED')).toEqual([
      expect.objectContaining({ actor: { t: 'seat', seat: 1 } }),
    ]);
    expect(r.player(2)).toMatchObject({ placed: false, node: 0, prevNode: 0 });
  });

  it('magic 效果 5 / 9：脚下的住宅或设施免费加盖一层 / 拆一层（受困者跳过；0 级设施由目标选类型）', () => {
    const sc = arena().edit((s) => {
      Object.assign(s.lands[1]!, { owner: 2, level: 1 });
    });
    cast(sc, 10, 5);
    // 1 号站在 6 号格（L2），2 号站在 12 号格（L5）
    expect(sc.state.lands[1]!.level).toBe(2);
    expect(sc.state.lands[4]!.level).toBe(1);
    const dm = arena().edit((s) => {
      Object.assign(s.lands[1]!, { owner: 2, level: 3 });
    });
    cast(dm, 10, 9);
    expect(dm.state.lands[1]!.level).toBe(2);
    const fac = arena().teleport(1, 17, 16);
    cast(fac, 10, 5);
    fac.expectAsk(1, 'FACILITY_TYPE').act(1, { type: 'CHOOSE_FACILITY_TYPE', facility: 'mall' });
    expect(fac.state.facilities[0]).toMatchObject({ level: 1, type: 'mall' });
  });

  it('magic 效果 11：以目标为卖方拍卖脚下地产（目标不能出价，成交款进目标存款；流拍变无主）', () => {
    const m = arena().edit((s) => {
      Object.assign(s.lands[1]!, { owner: 2, level: 2 });
      s.players[1]!.vehicle = 'moto';
      s.pools.items[5] = s.pools.items[5]! - 1;
    });
    const dep1 = m.player(1).deposit;
    cast(m, 7, 11);
    expect(m.event('AUCTION_STARTED')).toMatchObject({ lot: 'L2', seller: 1, source: 'magic', bidders: [0, 2] });
    m.act(2, { type: 'BID', inc: 500 }).act(0, { type: 'PASS' });
    expect(m.event('AUCTION_ENDED')).toMatchObject({ lot: 'L2', winner: 2, price: 4500 });
    expect(m.player(1).deposit).toBe(dep1 + 4500);
    expect(m.state.lands[1]!.owner).toBe(2);
    // 流拍：变为无主（建筑保留）
    const u = arena().edit((s) => {
      Object.assign(s.lands[1]!, { owner: 2, level: 2 });
      s.players[1]!.vehicle = 'moto';
      s.pools.items[5] = s.pools.items[5]! - 1;
    });
    cast(u, 7, 11);
    u.act(0, { type: 'PASS' }).act(2, { type: 'QUIT' });
    expect(u.state.lands[1]).toMatchObject({ owner: null, level: 2 });
  });
});
