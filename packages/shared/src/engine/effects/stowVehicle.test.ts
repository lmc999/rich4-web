import { describe, expect, it } from 'vitest';
import { buildFixtureMaps } from '../../data/maps/fixtures/testMap';
import { createRegistry, type DataRegistry } from '../../data/maps/registry';
import type { IndustryKey } from '../../data/maps/types';
import { CMB } from '../../data/tables/combat';
import { CARD, ITEM } from '../../data/tables/ids';
import { TABLES } from '../../data/tables/index';
import { candidateIntents } from '../testing/randomIntent';
import { type Scenario, scenario } from '../testing/scenario';
import type { TurnMenuOptions } from '../types/decision';
import type { SeatIndex } from '../types/ids';
import { PlayerIntentSchema } from '../types/intent';

/**
 * 收起交通工具、改回步行（STOW_VEHICLE；effects/items/vehicle.ts stowByHand）。原版取证：v2.06 道具函数表第 14 项
 * 0x4467b1——真人道具欄右下角那一格（模式为机车 / 汽车时才画、才登记），点下去车退回背包、步行、1 颗骰子，
 * 不扣道具、不结束回合、不限次数；工程车不出现这一格。开局就骑车的人背包里没有车，照样能收起。
 */
function setup(vehicle: 'walk' | 'moto' | 'car', players: ('human' | 'ai')[] = ['human', 'human']): Scenario {
  return scenario({ players, config: { vehicle } }).untilMenu(0).teleport(0, 5, 4).teleport(1, 18, 17);
}

function menu(sc: Scenario, seat: SeatIndex = 0): TurnMenuOptions {
  const d = sc.expectAsk(seat, 'TURN_MENU').pending(seat);
  return d.options as TurnMenuOptions;
}

function stow(sc: Scenario, seat: SeatIndex = 0): Scenario {
  return sc.act(seat, { type: 'STOW_VEHICLE' });
}

describe('收起交通工具（STOW_VEHICLE）', () => {
  it('机车开局：菜单给出可收起；收起后机车进背包、步行、骰子上限 1，回合菜单重发（非终结、不扣道具）', () => {
    const sc = setup('moto');
    const pool = sc.state.pools.items[ITEM.MOTORCYCLE]!;
    expect(sc.player(0)).toMatchObject({ vehicle: 'moto', diceCount: 2 });
    expect(sc.player(0).items[ITEM.MOTORCYCLE] ?? 0).toBe(0);
    const before = menu(sc);
    expect(before.vehicle).toEqual({ current: 'moto', canStow: true });
    expect(before.dice.allowed).toEqual([1, 2]);
    expect(before.items.map((r) => r.item)).not.toContain(ITEM.MOTORCYCLE);

    stow(sc);
    sc.expectEvents(['VEHICLE'], 'exact');
    // stowed = 收回背包的那台：客户端据此记「收起机车」，不弹换乘提示、不放音效（原版 0x4467b1 不说台词）
    expect(sc.event('VEHICLE')).toMatchObject({ seat: 0, vehicle: 'walk', dice: 1, stowed: 'moto' });
    expect(sc.player(0)).toMatchObject({ vehicle: 'walk', diceCount: 1, engineer: null });
    expect(sc.player(0).items[ITEM.MOTORCYCLE]).toBe(1);
    expect(sc.state.pools.items[ITEM.MOTORCYCLE]).toBe(pool);
    const after = menu(sc);
    expect(after.vehicle).toEqual({ current: 'walk', canStow: false });
    expect(after.dice).toMatchObject({ allowed: [1], current: 1 });
    expect(after.menuActions.used).toBe(1);
    expect(after.turnLog).toEqual([]);
    expect(after.items.find((r) => r.item === ITEM.MOTORCYCLE)).toMatchObject({ count: 1, usable: true });
  });

  it('汽车开局：收起后掷骰只有 1 颗（ROLL{dice:2} 越界）；下一回合仍是步行', () => {
    const sc = setup('car');
    expect(menu(sc).vehicle).toEqual({ current: 'car', canStow: true });
    stow(sc);
    expect(sc.event('VEHICLE')).toMatchObject({ seat: 0, vehicle: 'walk', dice: 1, stowed: 'car' });
    expect(sc.player(0)).toMatchObject({ vehicle: 'walk', diceCount: 1 });
    expect(sc.player(0).items[ITEM.CAR]).toBe(1);
    expect(() => sc.roll(0, 2)).toThrow(/OUT_OF_RANGE/);
    sc.force('dice', 3).roll(0);
    expect(sc.event('DICE_ROLLED')).toMatchObject({ dice: [3], steps: 3, diceCount: 1 });
    sc.untilMenu(0);
    expect(sc.player(0)).toMatchObject({ vehicle: 'walk', diceCount: 1 });
    expect(menu(sc).vehicle).toEqual({ current: 'walk', canStow: false });
  });

  it('再次换乘：收起的车可以用 5 / 6 号道具装回，同一回合可以反复切换；机车、汽车之间互换后也能收起', () => {
    const sc = setup('car');
    stow(sc);
    sc.useItem(0, ITEM.CAR);
    expect(sc.player(0)).toMatchObject({ vehicle: 'car', diceCount: 3 });
    expect(sc.player(0).items[ITEM.CAR]).toBe(0);
    expect(menu(sc).vehicle).toEqual({ current: 'car', canStow: true });
    stow(sc);
    expect(sc.player(0)).toMatchObject({ vehicle: 'walk', diceCount: 1 });
    expect(sc.player(0).items[ITEM.CAR]).toBe(1);

    // 换成机车（汽车留在背包），再收起：两种车都在背包里
    sc.give(0, { items: [{ item: ITEM.MOTORCYCLE, qty: 1 }] });
    sc.useItem(0, ITEM.MOTORCYCLE);
    expect(sc.player(0)).toMatchObject({ vehicle: 'moto', diceCount: 2 });
    sc.useItem(0, ITEM.CAR);
    expect(sc.player(0)).toMatchObject({ vehicle: 'car', diceCount: 3 });
    expect(sc.player(0).items[ITEM.MOTORCYCLE]).toBe(1);
    stow(sc);
    expect(sc.player(0).items[ITEM.MOTORCYCLE]).toBe(1);
    expect(sc.player(0).items[ITEM.CAR]).toBe(1);
    expect(menu(sc).menuActions.used).toBe(6);
    // 掷骰按步行 1 颗
    sc.force('dice', 2).roll(0);
    expect(sc.event('DICE_ROLLED')).toMatchObject({ diceCount: 1, dice: [2] });
  });

  it('步行、工程车不能收起（NOT_USABLE，状态不变）', () => {
    const walk = setup('walk');
    expect(menu(walk).vehicle).toEqual({ current: 'walk', canStow: false });
    const s0 = walk.state;
    expect(() => stow(walk)).toThrow(/NOT_USABLE/);
    expect(walk.state).toBe(s0);

    const eng = setup('moto');
    eng.give(0, { items: [{ item: ITEM.ENGINEERING_VEHICLE, qty: 1 }] });
    eng.useItem(0, ITEM.ENGINEERING_VEHICLE);
    expect(eng.player(0)).toMatchObject({ vehicle: 'engineer', diceCount: 1 });
    expect(menu(eng).vehicle).toEqual({ current: 'engineer', canStow: false });
    expect(() => stow(eng)).toThrow(/NOT_USABLE/);
    expect(eng.player(0)).toMatchObject({ vehicle: 'engineer', engineer: { days: 7, restore: 'moto' } });
  });

  it('时机：只在自己的回合菜单里（掷骰前）；别人的决策、落点决策里都不行', () => {
    const sc = setup('moto');
    const d = sc.pending(0);
    expect(() => sc.apply({ type: 'STOW_VEHICLE', seat: 1, decisionId: d.id })).toThrow(/NOT_YOUR_DECISION/);
    // 掷骰后停在无主空地：BUY_LAND 里不能收起
    sc.force('dice', 1, 1).roll(0);
    sc.expectAsk(0, 'BUY_LAND');
    expect(() => stow(sc)).toThrow(/INTENT_NOT_ALLOWED/);
    expect(sc.player(0).vehicle).toBe('moto');
  });

  it('停留、乌龟照样能收起（原版 14 号不查状态）；骰子仍按停留 / 乌龟锁定', () => {
    for (const [key, value] of [
      ['tortoise', CMB.TORTOISE_SELF],
      ['stay', CMB.STAY_OTHER],
    ] as const) {
      const sc = setup('car');
      sc.force('dice', 1, 1, 1).roll(0);
      sc.edit((s) => {
        s.players[0]!.st[key] = value;
      });
      sc.untilMenu(0);
      expect(menu(sc).dice.locked, key).toBe(key);
      stow(sc);
      expect(sc.player(0), key).toMatchObject({ vehicle: 'walk', diceCount: 1 });
      expect(menu(sc).dice.locked, key).toBe(key);
    }
  });

  it('计入每回合 40 次菜单操作上限（与其他非终结操作相同）', () => {
    const sc = setup('moto');
    sc.edit((s) => {
      s.players[0]!.turn.menuActions = 40;
    });
    expect(() => stow(sc)).toThrow(/MENU_LIMIT/);
    expect(sc.player(0).vehicle).toBe('moto');
  });

  it('收起后按步行结算：别人的加油站、汽车 / 石油公司都不收费（没收起的对照组照收）', () => {
    // fixture 'test'：15 → 16 → 17（设施 F1）；加油站按 500 × k × 步数 × PI，汽车 k = 2
    const gas = (doStow: boolean): Scenario => {
      const sc = scenario({ players: ['human', 'human'], config: { vehicle: 'car' } })
        .untilMenu(0)
        .edit((s) => {
          Object.assign(s.facilities[0]!, { owner: 1, level: 1, type: 'gas' });
        });
      if (doStow) stow(sc);
      return sc.teleport(0, 16, 15).force('dice', 1).roll(0, 1);
    };
    expect(gas(false).event('FEE_PAID')).toMatchObject({ feeKind: 'gas', amount: 500 * 2 * 1 });
    const walked = gas(true);
    expect(walked.player(0).vehicle).toBe('walk');
    expect(walked.events.some((e) => e.type === 'FEE_PAID')).toBe(false);

    // fixture 'test-allkinds'：22 → 23（企业 C3）改成汽车公司 / 石油公司，1 号是董事长；收费基数 600 × k × 步数 × PI
    const registryWithC3 = (industry: number, key: IndustryKey): DataRegistry => {
      const maps = buildFixtureMaps();
      const c3 = maps.find((m) => m.id === 'test-allkinds')!.companies.find((c) => c.id === 'C3')!;
      c3.industry = industry;
      c3.industryKey = key;
      return createRegistry(maps, { tables: TABLES, verifyHash: false });
    };
    for (const [ind, key] of [
      [5, 'auto'],
      [6, 'oil'],
    ] as const) {
      const company = (doStow: boolean): Scenario => {
        const sc = scenario({
          map: 'test-allkinds',
          registry: registryWithC3(ind, key),
          players: ['human', 'human'],
          config: { vehicle: 'car' },
        })
          .untilMenu(0)
          .edit((s) => {
            s.players[1]!.holdings[1] = { shares: 100, costCents: 500000 };
            s.stocks[1]!.float -= 100;
            s.stocks[1]!.chairman = 1;
          });
        if (doStow) stow(sc);
        return sc.teleport(0, 23, 22).force('dice', 1).roll(0, 1);
      };
      expect(company(false).event('COMPANY_FEE'), key).toMatchObject({ industry: ind, amount: 600 * 2 * 1 });
      expect(
        company(true).events.some((e) => e.type === 'COMPANY_FEE'),
        key,
      ).toBe(false);
    }
  });

  it('只有真人收起的 VEHICLE 带 stowed：梦游卡把车退回背包时发 VEHICLE{walk,1,via:sleepwalk}（并停放，见 sleepwalkVehicle.test）', () => {
    const sc = setup('car');
    sc.give(0, { cards: [CARD.SLEEPWALK] });
    sc.useCard(0, CARD.SLEEPWALK, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    expect(sc.player(1)).toMatchObject({ vehicle: 'walk', diceCount: 1, parked: { vehicle: 'car', dice: 3 } });
    expect(sc.player(1).items[ITEM.CAR]).toBe(1);
    const e = sc.event('VEHICLE');
    expect(e).toMatchObject({ seat: 1, vehicle: 'walk', dice: 1, via: 'sleepwalk', from: 'car' });
    expect(e).not.toHaveProperty('stowed');
    // 真人收起不停放、不带 via
    const hand = stow(setup('car'));
    expect(hand.event('VEHICLE')).not.toHaveProperty('via');
    expect(hand.player(0).parked).toBeNull();
  });

  it('随机对局的候选（candidateIntents）：能收起且没到菜单上限时含 STOW_VEHICLE，否则不含', () => {
    const has = (sc: Scenario): boolean => candidateIntents(sc.pending(0)).some((i) => i.type === 'STOW_VEHICLE');
    expect(has(setup('moto'))).toBe(true);
    expect(has(setup('car'))).toBe(true);
    expect(has(setup('walk'))).toBe(false);
    const eng = setup('moto');
    eng.give(0, { items: [{ item: ITEM.ENGINEERING_VEHICLE, qty: 1 }] });
    eng.useItem(0, ITEM.ENGINEERING_VEHICLE);
    expect(has(eng)).toBe(false);
    // 到了每回合 40 次菜单操作上限：与用卡、用道具一样不再列出
    const d = structuredClone(setup('car').pending(0));
    const o = d.options as TurnMenuOptions;
    o.menuActions.used = o.menuActions.limit;
    expect(candidateIntents(d).some((i) => i.type === 'STOW_VEHICLE')).toBe(false);
  });

  it('intent 结构：不带参数，多余字段拒绝', () => {
    expect(PlayerIntentSchema.safeParse({ type: 'STOW_VEHICLE' }).success).toBe(true);
    expect(PlayerIntentSchema.safeParse({ type: 'STOW_VEHICLE', vehicle: 'walk' }).success).toBe(false);
  });
});
