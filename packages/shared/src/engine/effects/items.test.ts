import { describe, expect, it } from 'vitest';
import { CMB } from '../../data/tables/combat';
import { ECON } from '../../data/tables/economy';
import { ITEM } from '../../data/tables/ids';
import { type Scenario, scenario } from '../testing/scenario';
import type { ItemId, SeatIndex } from '../types/ids';

/**
 * 13 种道具逐个（design/engine.md §10.4；docs/research/r_items.md）。fixture 'test'（见 cards.test.ts 的路线说明）。
 * 开局每人有机器娃娃、路障、地雷、定时炸弹、遥控骰子、机器工人各 1 件。
 */
function setup(o: { vehicle?: 'walk' | 'moto' | 'car' } = {}): Scenario {
  const sc = scenario({ players: ['human', 'human', 'human'], config: { vehicle: o.vehicle ?? 'walk' } }).untilMenu(0);
  return sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 18, 17);
}

function give(sc: Scenario, seat: SeatIndex, item: ItemId, qty = 1): Scenario {
  return sc.give(seat, { items: [{ item, qty }] });
}

function setLand(sc: Scenario, lot: string, owner: SeatIndex | null, level: number): void {
  sc.edit((s) => {
    const l = s.lands.find((x) => x.id === lot)!;
    l.owner = owner;
    l.level = level as 0;
  });
}

describe('items（13 种道具的效果）', () => {
  it('1 机器娃娃：沿前进方向走 9 步，清掉沿途物件与未附身的神明（搭档刷出）；娃娃回库存', () => {
    const sc = setup();
    sc.placeObject('roadblock', 8).placeObject('gift', 11).placeGod(5, 10);
    const pool = sc.state.pools.items;
    const [dolls, blocks] = [pool[1]!, pool[2]!];
    // 5→6…→13 每步只有 1 个候选（照样消耗一次随机数），13 号岔路取下标 1（14）
    sc.force('fork', 0, 0, 0, 0, 0, 0, 0, 0, 1).useItem(0, ITEM.ROBOT_DOLL);
    const walk = sc.event('DOLL_WALK');
    expect(walk.path).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(walk.clearedObjects).toHaveLength(2);
    expect(walk.clearedGods).toEqual([5]);
    expect(sc.state.objects).toEqual([]);
    expect(sc.state.pools.items[1]).toBe(dolls + 1);
    expect(sc.state.pools.items[2]).toBe(blocks + 1);
    expect(sc.state.gods.find((g) => g.kind === 6)!.where.t).toBe('road');
    sc.expectEvents(['ITEM_USED', 'DOLL_WALK', 'GOD_LEFT', 'GOD_SPAWNED']);
  });

  it('2 路障：放到范围内的空道路格；路过时拦停并回库存，照常结算该格', () => {
    const sc = setup();
    expect(() => sc.useItem(0, ITEM.ROADBLOCK, { t: 'node', node: 6 })).toThrow(/INVALID_TARGET/);
    sc.useItem(0, ITEM.ROADBLOCK, { t: 'node', node: 7 });
    expect(sc.state.objects).toMatchObject([{ kind: 'roadblock', node: 7, placedBy: 0 }]);
    const pool = sc.state.pools.items[2]!;
    sc.teleport(1, 18, 17).force('dice', 6).roll(0);
    sc.expectEvents(['DICE_ROLLED', 'MOVE_SEGMENT', 'ROADBLOCK_HIT', 'LANDED']);
    expect(sc.player(0).node).toBe(7);
    expect(sc.state.pools.items[2]).toBe(pool + 1);
    sc.expectAsk(0, 'BUY_LAND');
  });

  it('3 地雷：停在上面才触发：移除回库存、毁车、住院 3 天，本次落点结束', () => {
    const sc = setup({ vehicle: 'car' });
    sc.useItem(0, ITEM.MINE, { t: 'node', node: 7 });
    const pool = sc.state.pools.items;
    const [mines, cars] = [pool[3]!, pool[6]!];
    sc.force('dice', 2).roll(0, 1);
    expect(sc.player(0)).toMatchObject({ node: 15, vehicle: 'walk', diceCount: 1 });
    expect(sc.player(0).st.hospital).toBe(CMB.MINE_HOSPITAL_DAYS);
    expect(sc.state.pools.items[3]).toBe(mines + 1);
    expect(sc.state.pools.items[6]).toBe(cars + 1);
    expect(sc.state.lands[2]!.owner).toBeNull();
    sc.expectEvents(['LANDED', 'OBJECT_REMOVED', 'VEHICLE_DESTROYED', 'CONFINED', 'TURN_ENDED']);
  });

  it('3 地雷：路过不触发', () => {
    const sc = setup();
    sc.useItem(0, ITEM.MINE, { t: 'node', node: 6 + 1 });
    sc.teleport(1, 18, 17).force('dice', 3).roll(0);
    expect(sc.player(0)).toMatchObject({ node: 8, st: expect.objectContaining({ hospital: 0 }) });
    expect(sc.state.objects).toHaveLength(1);
  });

  it('4 定时炸弹：放到地上无主；停在上面拾取（引信 38）', () => {
    const sc = setup();
    sc.useItem(0, ITEM.TIME_BOMB, { t: 'node', node: 7 });
    expect(sc.state.objects[0]).toMatchObject({ kind: 'bomb', node: 7 });
    sc.force('dice', 2).roll(0);
    expect(sc.player(0).bomb).toEqual({ fuse: ECON.BOMB_FUSE });
    expect(sc.state.objects).toEqual([]);
    sc.expectEvents(['LANDED', 'BOMB_ATTACHED']);
  });

  it('5 / 6 机车、汽车：装备，原交通工具退回背包，骰子数设为上限；同一种不可用', () => {
    const sc = setup();
    give(sc, 0, ITEM.MOTORCYCLE);
    give(sc, 0, ITEM.CAR);
    sc.useItem(0, ITEM.MOTORCYCLE);
    expect(sc.player(0)).toMatchObject({ vehicle: 'moto', diceCount: 2 });
    expect(sc.player(0).items[5]).toBe(0);
    sc.useItem(0, ITEM.CAR);
    expect(sc.player(0)).toMatchObject({ vehicle: 'car', diceCount: 3 });
    expect(sc.player(0).items[5]).toBe(1);
    expect(sc.player(0).items[6]).toBe(0);
    give(sc, 0, ITEM.CAR);
    expect(() => sc.useItem(0, ITEM.CAR)).toThrow(/NOT_USABLE/);
  });

  it('7 飞弹：半宽 100 的方窗内地产拆一级、人住院 3 天毁车、物件清除；窗外不受影响', () => {
    const sc = setup();
    sc.teleport(0, 16, 15);
    give(sc, 0, ITEM.MISSILE);
    setLand(sc, 'L1', 2, 3);
    setLand(sc, 'L4', 2, 3);
    sc.placeObject('mine', 8);
    sc.useItem(0, ITEM.MISSILE, { t: 'node', node: 6 });
    const strike = sc.event('STRIKE');
    expect(strike).toMatchObject({ kind: 'missile', center: 6, half: ECON.MISSILE_HALF, lots: ['L1'] });
    expect(strike.actors).toEqual([{ t: 'seat', seat: 1 }]);
    expect(sc.state.lands[0]!.level).toBe(2);
    expect(sc.state.lands[3]!.level).toBe(3);
    expect(sc.player(1)).toMatchObject({ node: 15, st: expect.objectContaining({ hospital: 3 }) });
    expect(sc.player(0).st.hospital).toBe(0);
    expect(sc.state.objects).toEqual([]);
    expect(sc.player(2).hostility[0]).toBe(CMB.HATE_DEMOLISH_PI);
    expect(sc.player(1).hostility[0]).toBe(CMB.HATE_STRIKE_VICTIM_PI);
  });

  it('8 遥控骰子：选点即掷（1 颗、强制步数），道具回库存', () => {
    const sc = setup();
    const pool = sc.state.pools.items[8]!;
    sc.useItem(0, ITEM.REMOTE_DICE, { t: 'dice', value: 3 });
    expect(sc.event('DICE_ROLLED')).toMatchObject({ dice: [3], steps: 3, forced: true });
    expect(sc.player(0).node).toBe(8);
    expect(sc.state.pools.items[8]).toBe(pool + 1);
  });

  it('9 机器工人：范围内任一地产 +1 级（不看归属）；0 级设施需附带类型', () => {
    const sc = setup();
    setLand(sc, 'L4', 1, 2);
    sc.useItem(0, ITEM.ROBOT_WORKER, { t: 'lot', lot: 'L4', facility: null });
    expect(sc.state.lands[3]!.level).toBe(3);
    give(sc, 0, ITEM.ROBOT_WORKER);
    expect(() => sc.useItem(0, ITEM.ROBOT_WORKER, { t: 'lot', lot: 'F1', facility: null })).toThrow(/INVALID_TARGET/);
    sc.useItem(0, ITEM.ROBOT_WORKER, { t: 'lot', lot: 'F1', facility: 'lab' });
    expect(sc.state.facilities[0]).toMatchObject({ level: 1, type: 'lab' });
  });

  it('10 时光机：本期（M7 之前）不可用', () => {
    const sc = setup();
    give(sc, 0, ITEM.TIME_MACHINE);
    expect(() => sc.useItem(0, ITEM.TIME_MACHINE)).toThrow(/NOT_USABLE/);
    expect(sc.player(0).items[10]).toBe(1);
  });

  it('11 传送机：传送别人、神明、房屋；传送自己视为已掷骰（不结算落点）', () => {
    const sc = setup();
    give(sc, 0, ITEM.TELEPORTER, 4);
    sc.useItem(0, ITEM.TELEPORTER, {
      t: 'teleport',
      source: { k: 'actor', actor: { t: 'seat', seat: 1 } },
      dest: { k: 'road', node: 9 },
    });
    expect(sc.player(1).node).toBe(9);
    sc.placeGod(1, 3);
    const slot = sc.state.gods.find((g) => g.kind === 1)!.slot;
    sc.useItem(0, ITEM.TELEPORTER, { t: 'teleport', source: { k: 'god', slot }, dest: { k: 'road', node: 20 } });
    expect(sc.state.gods.find((g) => g.kind === 1)!.where).toEqual({ t: 'road', node: 20 });
    setLand(sc, 'L1', 1, 3);
    sc.useItem(0, ITEM.TELEPORTER, {
      t: 'teleport',
      source: { k: 'house', lot: 'L1' },
      dest: { k: 'lot', lot: 'L4' },
    });
    expect(sc.state.lands[0]).toMatchObject({ owner: null, level: 0 });
    expect(sc.state.lands[3]).toMatchObject({ owner: 1, level: 3 });
    sc.useItem(0, ITEM.TELEPORTER, {
      t: 'teleport',
      source: { k: 'actor', actor: { t: 'seat', seat: 0 } },
      dest: { k: 'road', node: 16 },
    });
    expect(sc.player(0).node).toBe(16);
    sc.expectEvents(['ITEM_USED', 'TELEPORTED', 'TURN_ENDED']);
    expect(sc.events.map((e) => e.type)).not.toContain('LANDED');
  });

  it('12 工程车：原车退回背包、骰子 1 颗、持续 7 个自己的回合；落点别人的建筑清到 0 级（PROGRAM）', () => {
    const sc = setup({ vehicle: 'car' });
    give(sc, 0, ITEM.ENGINEERING_VEHICLE);
    sc.useItem(0, ITEM.ENGINEERING_VEHICLE);
    expect(sc.player(0)).toMatchObject({ vehicle: 'engineer', diceCount: 1, engineer: { days: 7, restore: 'car' } });
    expect(sc.player(0).items[6]).toBe(1);
    setLand(sc, 'L2', 1, 4);
    sc.force('dice', 1).roll(0);
    sc.expectEvents(['LANDED', 'TOLL_PAID', 'LOT_MUTATED']);
    expect(sc.state.lands[1]).toMatchObject({ owner: 1, level: 0 });
    expect(sc.player(1).hostility[0]).toBe(CMB.HATE_DEMOLISH_PI);
    // 第 8 个自己的回合开头恢复原车
    for (let i = 0; i < 6; i++) sc.untilMenu(0).roll(0);
    sc.until((s) => s.players[0]!.engineer === null);
    expect(sc.player(0)).toMatchObject({ vehicle: 'car', diceCount: 3 });
    expect(sc.log.some((e) => e.type === 'VEHICLE' && e.seat === 0 && e.vehicle === 'car')).toBe(true);
  });

  it('13 核子飞弹：半宽 220：地产清为无主、窗内所有人（含施放者）住院 3 天', () => {
    const sc = setup();
    give(sc, 0, ITEM.NUKE);
    setLand(sc, 'L1', 1, 3);
    setLand(sc, 'L5', 2, 1);
    sc.useItem(0, ITEM.NUKE, { t: 'node', node: 7 });
    expect(sc.event('STRIKE')).toMatchObject({ kind: 'nuke', half: ECON.NUKE_HALF });
    expect(sc.state.lands[0]).toMatchObject({ owner: null, level: 0 });
    expect(sc.state.lands[4]).toMatchObject({ owner: null, level: 0 });
    const confined = sc.events.filter((e) => e.type === 'CONFINED');
    expect(confined.map((e) => [e.actor, e.where, e.days])).toEqual(
      ([0, 1, 2] as const).map((seat) => [{ t: 'seat', seat }, 'hospital', CMB.STRIKE_HOSPITAL_DAYS]),
    );
    // 施放者自己被关，回合结束；三人都住院，之后的回合全部受阻，直到有人走回棋盘
    sc.expectEvents(['STRIKE', 'CONFINED', 'CONFINED', 'CONFINED', 'TURN_ENDED', 'TURN_BLOCKED', 'RELEASED']);
  });
});
