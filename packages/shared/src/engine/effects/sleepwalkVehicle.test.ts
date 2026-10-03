import { describe, expect, it } from 'vitest';
import { CMB } from '../../data/tables/combat';
import { CARD, ITEM } from '../../data/tables/ids';
import { COUNTER_PENDING } from '../rules/counters';
import { type Scenario, scenario } from '../testing/scenario';
import type { TurnMenuOptions } from '../types/decision';
import type { GameEvent } from '../types/events';
import type { GameState } from '../types/state';

/**
 * 梦游卡停放座驾、梦游结束装回；工程车模式下用机车 / 汽车道具（ENGINE_VERSION 0.6.0，architecture §34）。原版取证（v2.06）：
 * - 梦游卡 0x442fa8：模式字节 +0x11 与骰子数 +0x12 存进 +0x66 / +0x67，模式 1 / 2 背包 +1，模式写 0、骰子写 1；
 * - 回合开始 0x41c1aa：梦游计数 0x80 时清 0，+0x66 & 3 为 1 / 2 且背包里有那台才装回（背包 −1），为 3（工程车，天数在模式字节里）
 *   直接装回；随后 0x41c4a6 才倒数工程车，所以梦游期间工程车不倒数、醒来那一回合照常算一天；
 * - 冬眠卡 0x442dcc 只把梦游清 0，不装回；
 * - 机车 0x4459e9 / 汽车 0x445aa4 只比较模式 ==1 / ==2，开着工程车时直接顶掉。
 * fixture 'test'（路线见 cards.test.ts）：13 号格是「得 30 点」，不发决策；0 号每回合从 12 掷 1 点落到 13，只让 1 号走动。
 */
function setup(vehicle: 'walk' | 'moto' | 'car' = 'walk'): Scenario {
  return scenario({ players: ['human', 'human'], config: { vehicle } })
    .untilMenu(0)
    .teleport(0, 5, 4)
    .teleport(1, 6, 5);
}

const sleepwalkOn1 = { t: 'actor', actor: { t: 'seat', seat: 1 } } as const;

/** 0 号用梦游卡打 1 号 */
function sleepwalk1(sc: Scenario): Scenario {
  return sc.give(0, { cards: [CARD.SLEEPWALK] }).useCard(0, CARD.SLEEPWALK, sleepwalkOn1);
}

/** 0 号空走一回合（12 → 13 得 30 点，只掷 1 颗）：引擎随即跑完 1 号的回合，停在下一个 TURN_MENU */
function idle0(sc: Scenario): Scenario {
  return sc.teleport(0, 12, 11).force('dice', 1).roll(0, 1);
}

/** 1 号的回合菜单出现之前，0 号一直空走；每轮之后调 each（检查梦游期间的状态）。返回轮数 */
function roundsUntilMenu1(sc: Scenario, each?: (s: GameState) => void, max = 12): number {
  for (let i = 1; i <= max; i++) {
    idle0(sc);
    if (sc.state.pending.some((d) => d.seat === 1 && d.kind === 'TURN_MENU')) return i;
    each?.(sc.state);
  }
  throw new Error('1 号没有醒来');
}

function menu(sc: Scenario, seat: 0 | 1): TurnMenuOptions {
  return sc.expectAsk(seat, 'TURN_MENU').pending(seat).options as TurnMenuOptions;
}

const vehicleEvents = (events: readonly GameEvent[], seat: number) =>
  events.filter((e): e is Extract<GameEvent, { type: 'VEHICLE' }> => e.type === 'VEHICLE' && e.seat === seat);

describe('梦游卡：停放座驾、梦游结束装回', () => {
  it('机车：中卡时机车回背包、记下骰子数；梦游 5 个回合后醒来那一回合装回（背包 −1、骰子数照旧）', () => {
    const sc = setup('moto').edit((s) => {
      s.players[1]!.diceCount = 1; // 1 号骑机车时只掷 1 颗：装回时照旧
    });
    sleepwalk1(sc);
    expect(vehicleEvents(sc.events, 1)).toEqual([
      expect.objectContaining({ vehicle: 'walk', dice: 1, via: 'sleepwalk', from: 'moto' }),
    ]);
    expect(sc.player(1)).toMatchObject({
      vehicle: 'walk',
      diceCount: 1,
      parked: { vehicle: 'moto', dice: 1, engineer: null },
      st: expect.objectContaining({ sleepwalk: CMB.SLEEPWALK_DAYS }),
    });
    expect(sc.player(1).items[ITEM.MOTORCYCLE]).toBe(1);

    const rounds = roundsUntilMenu1(sc, (s) => {
      const p = s.players[1]!;
      expect(p).toMatchObject({ vehicle: 'walk', parked: { vehicle: 'moto' } });
      expect(p.items[ITEM.MOTORCYCLE]).toBe(1);
    });
    // 5 个梦游回合（5 → 4 → 3 → 2 → 1 → 0x80）之后，0x80 → 0 的那一回合醒来、有回合菜单
    expect(rounds).toBe(6);
    const wake = vehicleEvents(sc.events, 1);
    expect(wake).toEqual([expect.objectContaining({ vehicle: 'moto', dice: 1, via: 'wake', from: 'walk' })]);
    // 装回发生在 1 号的 TURN_STARTED 之后、回合菜单之前
    const types = sc.events.map((e) => e.type);
    const started = types.lastIndexOf('TURN_STARTED');
    expect(sc.events.indexOf(wake[0]!)).toBeGreaterThan(started);
    expect(sc.player(1)).toMatchObject({ vehicle: 'moto', diceCount: 1, parked: null });
    expect(sc.player(1).st.sleepwalk).toBe(0);
    expect(sc.player(1).items[ITEM.MOTORCYCLE]).toBe(0);
    expect(menu(sc, 1).dice).toMatchObject({ allowed: [1, 2], current: 1 });
  });

  it('汽车：梦游期间被抢夺卡抢走（或卖掉）了，醒来时背包里没有就仍步行，不发 VEHICLE', () => {
    const sc = setup('car');
    sleepwalk1(sc);
    expect(sc.player(1)).toMatchObject({ parked: { vehicle: 'car', dice: 3, engineer: null } });
    expect(sc.player(1).items[ITEM.CAR]).toBe(1);
    sc.give(0, { cards: [CARD.ROB] }).useCard(0, CARD.ROB, { t: 'rob', seat: 1, take: { k: 'item', item: ITEM.CAR } });
    expect(sc.player(1).items[ITEM.CAR]).toBe(0);
    // 停放的记录还在（原版 +0x66 不动），醒来时才看背包
    expect(sc.player(1).parked).toMatchObject({ vehicle: 'car' });
    sc.edit((s) => {
      s.players[1]!.st.sleepwalk = COUNTER_PENDING;
    });
    roundsUntilMenu1(sc);
    expect(vehicleEvents(sc.events, 1)).toEqual([]);
    expect(sc.player(1)).toMatchObject({ vehicle: 'walk', diceCount: 1, parked: null });
    expect(menu(sc, 1).dice.allowed).toEqual([1]);
  });

  it('工程车：连同剩余天数一起停放、梦游期间不倒数，醒来那一回合装回并算一天', () => {
    const sc = setup('car');
    sc.give(0, { items: [{ item: ITEM.ENGINEERING_VEHICLE, qty: 1 }] }).useItem(0, ITEM.ENGINEERING_VEHICLE);
    sc.teleport(0, 5, 4);
    // 0 号开工程车，1 号用梦游卡打 0 号：先空走到 1 号的回合菜单
    idle0(sc).expectAsk(1, 'TURN_MENU');
    expect(sc.player(0).engineer).toEqual({ days: 7, restore: 'car', dice: 3 });
    sc.teleport(1, 6, 5).teleport(0, 5, 4);
    sc.give(1, { cards: [CARD.SLEEPWALK] });
    sc.useCard(1, CARD.SLEEPWALK, { t: 'actor', actor: { t: 'seat', seat: 0 } });
    expect(vehicleEvents(sc.events, 0)).toEqual([
      expect.objectContaining({ vehicle: 'walk', dice: 1, via: 'sleepwalk', from: 'engineer' }),
    ]);
    expect(sc.player(0)).toMatchObject({
      vehicle: 'walk',
      engineer: null,
      parked: { vehicle: 'engineer', dice: 1, engineer: { days: 7, restore: 'car', dice: 3 } },
    });
    // 开工程车时收进背包的汽车还在背包里
    expect(sc.player(0).items[ITEM.CAR]).toBe(1);
    // 1 号每回合 12 → 13 空走，直到 0 号醒来
    let rounds = 0;
    for (; rounds < 12; rounds++) {
      sc.teleport(1, 12, 11).force('dice', 1).roll(1, 1);
      if (sc.state.pending.some((d) => d.seat === 0 && d.kind === 'TURN_MENU')) break;
      expect(sc.player(0).parked).toMatchObject({ vehicle: 'engineer', engineer: { days: 7 } });
      sc.expectAsk(1, 'TURN_MENU');
    }
    expect(rounds + 1).toBe(6);
    expect(vehicleEvents(sc.events, 0)).toEqual([
      expect.objectContaining({ vehicle: 'engineer', dice: 1, via: 'wake', from: 'walk' }),
    ]);
    expect(sc.player(0)).toMatchObject({ vehicle: 'engineer', engineer: { days: 6, restore: 'car' }, parked: null });
    expect(menu(sc, 0).vehicle).toEqual({ current: 'engineer', canStow: false });
  });

  it('工程车醒来那一回合正好到期：先装回、再换回原车（背包 −1、骰子数恢复成开工程车之前的 1 颗），两条 VEHICLE 依次是 wake、expire', () => {
    const sc = setup('walk').edit((s) => {
      const p = s.players[1]!;
      // 开工程车之前骑机车只掷 1 颗（原版 +0x65）
      p.parked = { vehicle: 'engineer', dice: 1, engineer: { days: 1, restore: 'moto', dice: 1 } };
      p.st.sleepwalk = COUNTER_PENDING;
      p.items[ITEM.MOTORCYCLE] = 1;
      s.pools.items[ITEM.MOTORCYCLE] = s.pools.items[ITEM.MOTORCYCLE]! - 1;
    });
    roundsUntilMenu1(sc);
    expect(vehicleEvents(sc.events, 1).map((e) => [e.vehicle, e.dice, e.via, e.from])).toEqual([
      ['engineer', 1, 'wake', 'walk'],
      ['moto', 1, 'expire', 'engineer'],
    ]);
    expect(sc.player(1)).toMatchObject({ vehicle: 'moto', diceCount: 1, engineer: null, parked: null });
    expect(sc.player(1).items[ITEM.MOTORCYCLE]).toBe(0);
  });

  it('步行的人中卡：不停放、不发 VEHICLE；梦游期间再中梦游卡会覆盖第一次停放的座驾（车留在背包里）', () => {
    const walk = setup('walk');
    sleepwalk1(walk);
    expect(vehicleEvents(walk.events, 1)).toEqual([]);
    expect(walk.player(1).parked).toBeNull();

    const sc = setup('moto');
    sleepwalk1(sc);
    expect(sc.player(1).parked).toMatchObject({ vehicle: 'moto' });
    sleepwalk1(sc);
    expect(sc.player(1)).toMatchObject({ vehicle: 'walk', parked: null });
    expect(sc.player(1).st.sleepwalk).toBe(CMB.SLEEPWALK_DAYS);
    expect(sc.player(1).items[ITEM.MOTORCYCLE]).toBe(1);
    sc.edit((s) => {
      s.players[1]!.st.sleepwalk = COUNTER_PENDING;
    });
    roundsUntilMenu1(sc);
    expect(vehicleEvents(sc.events, 1)).toEqual([]);
    expect(sc.player(1).vehicle).toBe('walk');
  });

  it('冬眠卡取消梦游：停放的座驾不再装回（机车留在背包里）', () => {
    const sc = setup('moto');
    sleepwalk1(sc);
    sc.give(0, { cards: [CARD.HIBERNATE] }).useCard(0, CARD.HIBERNATE);
    expect(sc.player(1)).toMatchObject({ vehicle: 'walk', parked: null });
    expect(sc.player(1).st).toMatchObject({ sleepwalk: 0, hibernate: 5 });
    expect(sc.player(1).items[ITEM.MOTORCYCLE]).toBe(1);
    roundsUntilMenu1(sc);
    expect(sc.log.some((e) => e.type === 'VEHICLE' && e.seat === 1 && e.via === 'wake')).toBe(false);
    expect(sc.player(1).vehicle).toBe('walk');
  });

  it('复仇卡反弹：出卡者自己的座驾同样停放，各自在自己梦游结束时装回', () => {
    const sc = setup('car');
    sc.give(1, { cards: [CARD.REVENGE] });
    // 两人都梦游、都没有回合菜单：引擎一直跑到 1 号醒来（1 号先中卡，先醒）
    sleepwalk1(sc);
    const v = sc.events.filter((e) => e.type === 'VEHICLE').map((e) => [e.seat, e.vehicle, e.via, e.from]);
    expect(v).toEqual([
      [1, 'walk', 'sleepwalk', 'car'],
      [0, 'walk', 'sleepwalk', 'car'],
      [1, 'car', 'wake', 'walk'],
    ]);
    sc.expectAsk(1, 'TURN_MENU');
    expect(sc.player(1)).toMatchObject({ vehicle: 'car', diceCount: 3, parked: null });
    expect(sc.player(0)).toMatchObject({ vehicle: 'walk', parked: { vehicle: 'car', dice: 3, engineer: null } });
    expect(sc.player(0).items[ITEM.CAR]).toBe(1);
    expect(sc.player(1).items[ITEM.CAR]).toBe(0);
  });

  it('飞弹炸到梦游中的人：身上步行，不毁车；停放的机车不受影响，醒来照样装回', () => {
    const sc = setup('moto');
    sleepwalk1(sc);
    // 0 号站到 16（离 6 号格超过飞弹半宽），只炸到 1 号
    sc.teleport(0, 16, 15);
    sc.give(0, { items: [{ item: ITEM.MISSILE, qty: 1 }] }).useItem(0, ITEM.MISSILE, { t: 'node', node: 6 });
    expect(sc.events.some((e) => e.type === 'VEHICLE_DESTROYED' && e.seat === 1)).toBe(false);
    expect(sc.player(1)).toMatchObject({ parked: { vehicle: 'moto' }, st: expect.objectContaining({ hospital: 3 }) });
    // 住院期间梦游暂停倒数（原版 0x41c161：主阻碍计数非 0 时整段跳过）
    sc.edit((s) => {
      s.players[1]!.st.hospital = 0;
      s.players[1]!.st.sleepwalk = COUNTER_PENDING;
    });
    roundsUntilMenu1(sc);
    expect(sc.player(1)).toMatchObject({ vehicle: 'moto', parked: null });
  });

  it('关押期间梦游暂停：计数 0x80 也不醒，出狱之后的回合才装回', () => {
    const sc = setup('car');
    sleepwalk1(sc);
    sc.edit((s) => {
      const p = s.players[1]!;
      p.st.sleepwalk = COUNTER_PENDING;
      p.st.jail = 2;
      p.node = 14;
      p.prevNode = 14;
    });
    idle0(sc);
    expect(sc.player(1)).toMatchObject({ vehicle: 'walk', parked: { vehicle: 'car' } });
    expect(sc.player(1).st.sleepwalk).toBe(COUNTER_PENDING);
    roundsUntilMenu1(sc);
    expect(sc.player(1)).toMatchObject({ vehicle: 'car', parked: null });
  });

  it('不变量：停放座驾时必须在梦游、步行', () => {
    const sc = setup('moto');
    expect(() =>
      sc.edit((s) => {
        s.players[1]!.parked = { vehicle: 'moto', dice: 2, engineer: null };
      }),
    ).toThrow(/parked vehicle but is not sleepwalking/);
  });
});

describe('工程车模式下用机车 / 汽车道具：直接顶掉工程车、不退还', () => {
  it('机车顶掉工程车：天数与到期要换回的座驾作废，开工程车时收进背包的汽车留在背包里', () => {
    const sc = setup('car');
    sc.give(0, {
      items: [
        { item: ITEM.ENGINEERING_VEHICLE, qty: 1 },
        { item: ITEM.MOTORCYCLE, qty: 1 },
      ],
    });
    sc.useItem(0, ITEM.ENGINEERING_VEHICLE);
    expect(sc.player(0)).toMatchObject({ vehicle: 'engineer', engineer: { days: 7, restore: 'car' } });
    expect(sc.player(0).items[ITEM.CAR]).toBe(1);
    const row = menu(sc, 0).items.find((r) => r.item === ITEM.MOTORCYCLE);
    expect(row).toMatchObject({ usable: true });
    sc.useItem(0, ITEM.MOTORCYCLE);
    expect(vehicleEvents(sc.events, 0)).toEqual([
      { type: 'VEHICLE', seat: 0, vehicle: 'moto', dice: 2, post: expect.anything() },
    ]);
    expect(sc.player(0)).toMatchObject({ vehicle: 'moto', diceCount: 2, engineer: null, parked: null });
    expect(sc.player(0).items[ITEM.CAR]).toBe(1);
    expect(sc.player(0).items[ITEM.MOTORCYCLE]).toBe(0);
    expect(sc.player(0).items[ITEM.ENGINEERING_VEHICLE]).toBe(0);
    // 之后的回合不再倒数、不会「到期换回汽车」
    idle0(sc);
    sc.untilMenu(0);
    expect(sc.player(0)).toMatchObject({ vehicle: 'moto', engineer: null });
    expect(sc.player(0).items[ITEM.CAR]).toBe(1);
  });

  it('汽车同样能顶掉工程车；已经骑着同一种时仍不可用', () => {
    const sc = setup('walk');
    sc.give(0, {
      items: [
        { item: ITEM.ENGINEERING_VEHICLE, qty: 1 },
        { item: ITEM.CAR, qty: 2 },
      ],
    });
    sc.useItem(0, ITEM.ENGINEERING_VEHICLE).useItem(0, ITEM.CAR);
    expect(sc.player(0)).toMatchObject({ vehicle: 'car', diceCount: 3, engineer: null });
    expect(sc.player(0).items[ITEM.CAR]).toBe(1);
    expect(menu(sc, 0).items.find((r) => r.item === ITEM.CAR)).toMatchObject({ usable: false });
    expect(() => sc.useItem(0, ITEM.CAR)).toThrow(/NOT_USABLE/);
  });

  it('工程车到期换回原车：骰子数恢复成开工程车之前的颗数（原版 +0x65，0x41c529），不是上限', () => {
    const sc = setup('moto');
    // 0 号骑机车时选 1 颗，再开工程车：记下 restore moto、dice 1
    sc.roll(0, 1);
    sc.untilMenu(0);
    expect(sc.player(0)).toMatchObject({ vehicle: 'moto', diceCount: 1 });
    sc.give(0, { items: [{ item: ITEM.ENGINEERING_VEHICLE, qty: 1 }] }).useItem(0, ITEM.ENGINEERING_VEHICLE);
    expect(sc.player(0).engineer).toEqual({ days: 7, restore: 'moto', dice: 1 });
    sc.edit((s) => {
      s.players[0]!.engineer = { days: 1, restore: 'moto', dice: 1 };
    });
    idle0(sc);
    sc.untilMenu(0);
    expect(sc.log.filter((e) => e.type === 'VEHICLE' && e.seat === 0 && e.via === 'expire')).toEqual([
      expect.objectContaining({ vehicle: 'moto', dice: 1, from: 'engineer' }),
    ]);
    expect(sc.player(0)).toMatchObject({ vehicle: 'moto', diceCount: 1, engineer: null });
    expect(menu(sc, 0).dice).toMatchObject({ allowed: [1, 2], current: 1 });
  });

  it('工程车到期：VEHICLE 带 via expire、from engineer（背包里没有原车时改为步行）', () => {
    const sc = setup('walk').edit((s) => {
      const p = s.players[1]!;
      p.vehicle = 'engineer';
      p.diceCount = 1;
      p.engineer = { days: 1, restore: 'car', dice: 3 };
    });
    roundsUntilMenu1(sc);
    expect(vehicleEvents(sc.events, 1)).toEqual([
      expect.objectContaining({ vehicle: 'walk', dice: 1, via: 'expire', from: 'engineer' }),
    ]);
    expect(sc.player(1)).toMatchObject({ vehicle: 'walk', engineer: null });
  });
});
