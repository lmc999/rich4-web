import { describe, expect, it } from 'vitest';
import { fateParam } from '../../data/tables/fate';
import { type Scenario, scenario } from '../testing/scenario';
import type { FateId, SeatIndex } from '../types/ids';
import type { GameState } from '../types/state';

/**
 * fate：37 张命运逐条（design/engine.md §10.7，按 docs/research/events-from-exe.md §2、§4 修正；数值取 data/tables/fate.ts，
 * 与 exe 抽取结果的对照在 data/tables/events.test.ts）。fixture 'test-allkinds'（1..20 号格与 'test' 相同；C3 为保险公司）：
 * 0 号从 2 号格掷 1 点停到 3 号命运格；牌堆用 stackDeck 指定下一张（抽到后仍按座驾替换、判可行）。
 * 加持：值 > 100 必定 high、< 0 为 low；奖金、罚金读财运（luck.wealth），劫难读福运（luck.fortune）。
 */
function arena(o: { players?: ('human' | 'ai')[]; rules?: Record<string, unknown> } = {}): Scenario {
  const sc = scenario({
    map: 'test-allkinds',
    players: o.players ?? ['human', 'human', 'human'],
    rules: o.rules ?? {},
  }).untilMenu(0);
  return sc.teleport(1, 6, 5).teleport(2, 12, 11);
}

/** 0 号停到命运格，抽到 id */
function fate(sc: Scenario, id: FateId, ...forced: number[]): Scenario {
  sc.stackDeck('fate', [id]).teleport(0, 2, 1);
  if (forced.length > 0) sc.force('fate', ...forced);
  return sc.force('dice', 1).roll(0, 1);
}

function luck(seat: SeatIndex, wealth: number, fortune: number) {
  return (s: GameState) => {
    const p = s.players.find((x) => x.seat === seat)!;
    p.luck.wealth = wealth;
    p.luck.fortune = fortune;
  };
}

function vehicle(seat: SeatIndex, v: 'moto' | 'car') {
  return (s: GameState) => {
    const p = s.players.find((x) => x.seat === seat)!;
    p.vehicle = v;
    p.diceCount = v === 'car' ? 3 : 2;
    s.pools.items[v === 'moto' ? 5 : 6]! -= 1;
  };
}

describe('fate（37 张命运）', () => {
  it('fate 0：自家一栋有建筑的住宅被强拆（夷平、保留地主），补偿 等级 × 房价（不乘 PI）', () => {
    const sc = arena().edit((s) => {
      Object.assign(s.lands[1]!, { owner: 0, level: 3 });
      s.econ.priceIndex = 2;
    });
    const cash = sc.player(0).cash;
    fate(sc, 0, 0);
    expect(sc.event('FATE')).toMatchObject({ seat: 0, id: 0, amount: 1500, blessing: null });
    expect(sc.state.lands[1]).toMatchObject({ owner: 0, level: 0 });
    expect(sc.player(0).cash).toBe(cash + 1500);
  });

  it('fate 1：自家一块空地被征收（变无主），补偿地价；没有空地时不可行', () => {
    const sc = arena().edit((s) => {
      Object.assign(s.lands[3]!, { owner: 0, level: 0 });
    });
    const cash = sc.player(0).cash;
    fate(sc, 1, 0);
    expect(sc.event('FATE')).toMatchObject({ id: 1, amount: 1200 });
    expect(sc.state.lands[3]!.owner).toBeNull();
    expect(sc.player(0).cash).toBe(cash + 1200);
    const none = arena();
    fate(none, 1);
    expect(none.event('FATE').id).not.toBe(1);
  });

  it('fate 2：被冒用贷款 10000 × PI（没有到期日时设 90 天后）；罚金类加持 high 免、low ×2；投保中保险公司赔同额', () => {
    const sc = arena();
    fate(sc, 2);
    expect(sc.player(0).loan).toBe(fateParam(2, 'loan'));
    expect(sc.player(0).loanDue).toBe(20050803);
    const hi = arena().edit(luck(0, 150, 0));
    fate(hi, 2);
    expect(hi.event('FATE')).toMatchObject({ blessing: 'high' });
    expect(hi.player(0).loan).toBe(0);
    const lo = arena().edit(luck(0, -60, 0));
    fate(lo, 2);
    expect(lo.player(0).loan).toBe(20000);
    const ins = arena().edit((s) => {
      s.players[0]!.insuranceDays = 5;
    });
    const cash = ins.player(0).cash;
    fate(ins, 2);
    expect(ins.event('INSURANCE_PAYOUT')).toMatchObject({ seat: 0, amount: 10000 });
    expect(ins.player(0).cash).toBe(cash + 10000);
    expect(ins.state.companies[2]!.surplusMonth).toBe(-10000);
  });

  it('fate 3：银行拒绝往来 30 天（累加）；只处理 high 免，low 不加倍', () => {
    const sc = arena();
    fate(sc, 3);
    expect(sc.player(0).bankReject).toBe(30);
    expect(sc.event('STATUS_SET')).toMatchObject({ status: 'bankReject', value: 30 });
    const lo = arena().edit(luck(0, -100, 0));
    fate(lo, 3);
    expect(lo.event('FATE').blessing).toBeNull();
    expect(lo.player(0).bankReject).toBe(30);
    const hi = arena().edit(luck(0, 150, 0));
    fate(hi, 3);
    expect(hi.player(0).bankReject).toBe(0);
  });

  it('fate 4：每位其他在场玩家存款的 10% 转入自己的存款', () => {
    const sc = arena().setCash(1, 0, 12345).setCash(2, 0, 0);
    const dep = sc.player(0).deposit;
    fate(sc, 4);
    expect(sc.player(1).deposit).toBe(12345 - 1234);
    expect(sc.player(0).deposit).toBe(dep + 1234);
  });

  it('fate 5：生日——真人逐人挑卡（BIRTHDAY_PICK）；电脑随机拿；没有对手持卡时不可行', () => {
    const sc = arena()
      .give(1, { cards: [13, 14] })
      .give(2, { cards: [15] });
    fate(sc, 5);
    sc.expectAsk(0, 'BIRTHDAY_PICK');
    expect(sc.pending(0).options).toEqual({
      victims: [
        {
          seat: 1,
          cards: [
            { slot: 0, card: 13 },
            { slot: 1, card: 14 },
          ],
        },
        { seat: 2, cards: [{ slot: 0, card: 15 }] },
      ],
    });
    expect(() => sc.act(0, { type: 'PICK_CARDS', picks: [{ from: 1, slot: 1 }] })).toThrow(/INVALID_TARGET/);
    sc.act(0, {
      type: 'PICK_CARDS',
      picks: [
        { from: 1, slot: 1 },
        { from: 2, slot: 0 },
      ],
    });
    expect(sc.player(0).cards).toEqual([14, 15]);
    expect(sc.player(1).cards).toEqual([13]);
    const ai = arena({ players: ['ai', 'human', 'human'] }).give(1, { cards: [13, 14] });
    fate(ai, 5);
    expect(ai.player(0).cards).toHaveLength(1);
    expect(ai.player(1).cards).toHaveLength(1);
    const none = arena();
    fate(none, 5);
    expect(none.event('FATE').id).not.toBe(5);
  });

  it('fate 6 / 7：出国观光、外星人绑架 3 天（劫难：high 逃过、low ×2）→ 免罪 → 嫁祸 → 消失', () => {
    const sc = arena();
    fate(sc, 6);
    expect(sc.event('CONFINED')).toMatchObject({ actor: { t: 'seat', seat: 0 }, where: 'away', days: 3 });
    const hi = arena().edit(luck(0, 0, 150));
    fate(hi, 7);
    expect(hi.event('FATE')).toMatchObject({ id: 7, blessing: 'high' });
    expect(hi.events.some((e) => e.type === 'CONFINED')).toBe(false);
    const lo = arena().edit(luck(0, 0, -100));
    fate(lo, 7);
    expect(lo.event('CONFINED')).toMatchObject({ where: 'away', days: 6 });
    const pardon = arena().give(0, { cards: [21] });
    fate(pardon, 6);
    expect(pardon.event('PASSIVE')).toMatchObject({ seat: 0, card: 21 });
    expect(pardon.player(0).st.away).toBe(0);
  });

  it('fate 8：每支持股收回 10%（退回市场，按市价进公库）；9：按市价卖光全部持股进存款（都只处理 high 免）', () => {
    const hold = (s: GameState) => {
      s.players[0]!.holdings[0] = { shares: 1005, costCents: 1005 * 8000 };
      s.stocks[0]!.float -= 1005;
      s.stocks[0]!.chairman = 0;
    };
    const a = arena().edit(hold);
    const pool = a.state.econ.pool;
    fate(a, 8);
    expect(a.player(0).holdings[0]!.shares).toBe(905);
    expect(a.state.econ.pool).toBe(pool + 100 * 80);
    const b = arena().edit(hold);
    const dep = b.player(0).deposit;
    fate(b, 9);
    expect(b.player(0).holdings[0]!.shares).toBe(0);
    expect(b.player(0).deposit).toBe(dep + 1005 * 80);
    expect(b.event('CHAIRMAN_CHANGED')).toMatchObject({ stock: 0, from: 0, to: null });
    const lo = arena()
      .edit(hold)
      .edit(luck(0, -100, 0));
    fate(lo, 8);
    expect(lo.player(0).holdings[0]!.shares).toBe(905);
  });

  it('fate 10 / 11：机车被偷 / 汽车撞毁（按座驾互换，步行时不可行；只处理 high 逃过）', () => {
    const a = arena().edit(vehicle(0, 'car'));
    fate(a, 10);
    expect(a.event('FATE').id).toBe(11);
    expect(a.event('VEHICLE_DESTROYED')).toMatchObject({ seat: 0, vehicle: 'car' });
    expect(a.player(0).vehicle).toBe('walk');
    const b = arena().edit(vehicle(0, 'moto'));
    fate(b, 11);
    expect(b.event('FATE').id).toBe(10);
    const walk = arena();
    fate(walk, 10);
    expect([10, 11]).not.toContain(walk.event('FATE').id);
  });

  it('fate 12 / 13：掉进水沟（步行）/ 骑车摔伤（机车，先毁座驾）住院 3 天；开汽车时不可行', () => {
    const a = arena();
    fate(a, 13);
    expect(a.event('FATE').id).toBe(12);
    expect(a.event('CONFINED')).toMatchObject({ where: 'hospital', days: 3 });
    const b = arena().edit(vehicle(0, 'moto'));
    fate(b, 12);
    expect(b.event('FATE').id).toBe(13);
    b.expectEvents(['FATE', 'VEHICLE_DESTROYED', 'CONFINED']);
    const car = arena().edit(vehicle(0, 'car'));
    fate(car, 12);
    expect([12, 13]).not.toContain(car.event('FATE').id);
  });

  it('fate 14 / 15 / 16：交通罚款 3000 × PI 进公库（按座驾三选一；罚金类 high 免付、low ×2）', () => {
    const a = arena();
    const pool = a.state.econ.pool;
    fate(a, 16);
    expect(a.event('FATE')).toMatchObject({ id: 14, amount: 3000 });
    expect(a.state.econ.pool).toBe(pool + 3000);
    const b = arena().edit(vehicle(0, 'moto'));
    fate(b, 14);
    expect(b.event('FATE').id).toBe(15);
    const c = arena()
      .edit(vehicle(0, 'car'))
      .edit(luck(0, -100, 0));
    fate(c, 15);
    expect(c.event('FATE')).toMatchObject({ id: 16, amount: 6000, blessing: 'low' });
    const d = arena().edit(luck(0, 150, 0));
    const cash = d.player(0).cash;
    fate(d, 14);
    expect(d.event('FATE')).toMatchObject({ blessing: 'high' });
    expect(d.player(0).cash).toBe(cash);
  });

  it('fate 17 / 18 / 19 / 23 / 24 / 26 / 30：罚金 × PI 进公库；投保中且由本人付了：保险公司赔同额', () => {
    for (const [id, amount] of [
      [17, 6000],
      [18, 600],
      [19, 1500],
      [23, 1000],
      [24, 2000],
      [26, 8000],
      [30, 5000],
    ] as const) {
      const sc = arena();
      const cash = sc.player(0).cash;
      fate(sc, id);
      expect(sc.event('FATE'), `fate ${id}`).toMatchObject({ id, amount });
      expect(sc.player(0).cash, `fate ${id}`).toBe(cash - amount);
    }
    const ins = arena().edit((s) => {
      s.players[0]!.insuranceDays = 3;
    });
    const cash = ins.player(0).cash;
    fate(ins, 26);
    expect(ins.event('INSURANCE_PAYOUT')).toMatchObject({ seat: 0, amount: 8000, days: 0 });
    expect(ins.player(0).cash).toBe(cash);
  });

  it('fate 罚金：rules.freeCardOnFines 时先问免费卡（用了就免付、不赔）、再问嫁祸卡', () => {
    const sc = arena({ rules: { freeCardOnFines: true } })
      .give(0, { cards: [20] })
      .edit((s) => {
        s.econ.priceIndex = 2;
      });
    const cash = sc.player(0).cash;
    fate(sc, 26);
    sc.expectAsk(0, 'USE_FREE_CARD').confirm(0);
    expect(sc.player(0).cash).toBe(cash);
    const sg = arena({ rules: { freeCardOnFines: true } })
      .give(0, { cards: [19] })
      .edit((s) => {
        s.econ.priceIndex = 2;
      });
    const c1 = sg.player(1).cash;
    fate(sg, 26);
    sg.expectAsk(0, 'SCAPEGOAT').act(0, { type: 'SCAPEGOAT', target: 1 });
    expect(sg.player(1).cash).toBe(c1 - 16000);
  });

  it('fate 20–22 / 25 / 27–29 / 31：奖金 × PI 进现金（奖金类 high ×2、low 作废）', () => {
    for (const [id, amount] of [
      [20, 1000],
      [21, 2000],
      [22, 3000],
      [25, 10000],
      [27, 4000],
      [28, 6000],
      [29, 8000],
      [31, 5000],
    ] as const) {
      const sc = arena();
      const cash = sc.player(0).cash;
      fate(sc, id);
      expect(sc.player(0).cash, `fate ${id}`).toBe(cash + amount);
    }
    const hi = arena().edit(luck(0, 101, 0));
    const c = hi.player(0).cash;
    fate(hi, 25);
    expect(hi.event('FATE')).toMatchObject({ amount: 20000, blessing: 'high' });
    expect(hi.player(0).cash).toBe(c + 20000);
    const lo = arena().edit(luck(0, -1, 0));
    const c2 = lo.player(0).cash;
    fate(lo, 25);
    expect(lo.player(0).cash).toBe(c2);
    // 50 < 财运 ≤ 100：rand & 1
    const coin = arena().edit(luck(0, 60, 0));
    coin.force('bless', 1);
    const c3 = coin.player(0).cash;
    fate(coin, 20);
    expect(coin.player(0).cash).toBe(c3 + 2000);
  });

  it('fate 32：卡片、道具（座驾先折回道具）全部按商店价全价折点券（不乘 0.9；只处理 high 逃过）', () => {
    const sc = arena()
      .edit(vehicle(0, 'car'))
      .give(0, { cards: [1, 22] });
    const items = sc.player(0).items;
    // 开局道具 1,2,3,4,8,9：15 + 30 + 25 + 25 + 30 + 30 = 155；汽车 150；卡：均富 200 + 送神符 10
    expect(items.slice(1, 10)).toEqual([1, 1, 1, 1, 0, 0, 0, 1, 1]);
    fate(sc, 32);
    expect(sc.event('FATE')).toMatchObject({ id: 32, amount: 155 + 150 + 210 });
    expect(sc.player(0)).toMatchObject({ points: 515, cards: [], vehicle: 'walk' });
    expect(sc.player(0).items.every((n) => n === 0)).toBe(true);
    const hi = arena().edit(luck(0, 0, 200));
    fate(hi, 32);
    expect(hi.player(0).points).toBe(0);
  });

  it('fate 33–36：坐牢 3 / 5 / 7 / 9 天（劫难：high 逃过、low ×2）→ 免罪 → 嫁祸；v2.06 在任何地图都可行', () => {
    for (const [id, days] of [
      [33, 3],
      [34, 5],
      [35, 7],
      [36, 9],
    ] as const) {
      const sc = arena();
      fate(sc, id);
      expect(sc.event('CONFINED'), `fate ${id}`).toMatchObject({ where: 'jail', days, cause: { k: 'fate', ref: id } });
    }
    const lo = arena().edit(luck(0, 0, -10));
    fate(lo, 36);
    expect(lo.event('CONFINED')).toMatchObject({ days: 18 });
    const sg = arena().give(0, { cards: [19] });
    fate(sg, 34);
    sg.expectAsk(0, 'SCAPEGOAT').act(0, { type: 'SCAPEGOAT', target: 2 });
    expect(sg.event('CONFINED')).toMatchObject({ actor: { t: 'seat', seat: 2 }, days: 5 });
  });

  it('fate：死神附身（财运、福运 −200）时奖金作废、罚金加倍、劫难加倍', () => {
    const sc = arena().attachGod(0, 15);
    const cash = sc.player(0).cash;
    fate(sc, 23);
    expect(sc.player(0).cash).toBe(cash - 2000);
    const j = arena().attachGod(0, 15);
    fate(j, 33);
    expect(j.event('CONFINED')).toMatchObject({ days: 6 });
  });
});
