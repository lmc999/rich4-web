import { describe, expect, it } from 'vitest';
import { ECON } from '../../data/tables/economy';
import { ITEM } from '../../data/tables/ids';
import { scenario } from '../testing/scenario';

/**
 * 路面物件与乞丐（design/engine.md §7.6、§10.9、§10.11；docs/research/g_villains.md §5）：
 * 礼物、宝箱停下才拿；每月 1 日重摆；乞丐施舍与换位；破产时身上的神与炸弹。
 */
describe('objects（路面物件、乞丐）', () => {
  it('礼物：停下时按共享库存加权随机得 1 个道具（1..8），礼物消失；路过不拿', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4).placeObject('gift', 7).placeObject('gift', 6);
    sc.force('gift', 0).force('dice', 2).roll(0);
    expect(sc.event('ITEM_GAINED')).toMatchObject({ seat: 0, item: ITEM.ROBOT_DOLL, qty: 1, source: 'gift' });
    expect(sc.player(0).items[1]).toBe(2);
    expect(sc.state.objects.map((o) => o.node)).toEqual([6]);
  });

  it('宝箱：停下时点券 +500，宝箱消失', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4).placeObject('chest', 6);
    sc.force('dice', 1).roll(0);
    expect(sc.event('POINTS_GAINED')).toMatchObject({ seat: 0, amount: ECON.CHEST_POINTS, source: 'chest' });
    expect(sc.player(0).points).toBe(500);
    expect(sc.state.objects).toEqual([]);
  });

  it('每月 1 日：礼物、宝箱收回后各重新随机摆放 1 个（OBJECTS_RESPAWNED）', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.placeObject('gift', 7)
      .placeObject('gift', 8)
      .apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050531 } });
    sc.roll(0).until((s) => s.clock.date === 20050601);
    const e = sc.log.find((x) => x.type === 'OBJECTS_RESPAWNED');
    expect(e?.type === 'OBJECTS_RESPAWNED' && e.objects).toHaveLength(2);
    expect(sc.state.objects.map((o) => o.kind).sort()).toEqual(['chest', 'gift']);
  });

  it('乞丐：停在乞丐所在格（除自己外座位号最小的是出局者）施舍 1000×PI 进公库，乞丐换位', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4).edit((s) => {
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
      s.beggars.push({ seat: 2, node: 7 });
    });
    const pool = sc.state.econ.pool;
    const cash = sc.player(0).cash;
    sc.force('dice', 2).roll(0);
    const alms = sc.event('BEGGAR_ALMS');
    expect(alms).toMatchObject({ payer: 0, beggar: 2, amount: ECON.BEGGAR_ALMS });
    expect(alms.newNode).not.toBe(7);
    expect(sc.state.beggars).toEqual([{ seat: 2, node: alms.newNode }]);
    expect(sc.state.econ.pool).toBe(pool + 1000);
    expect(sc.player(0).cash).toBe(cash - 1000);
  });

  it('身上的炸弹爆炸（PROGRAM）把研究所拆到低于项目等级：研发作废并发 RESEARCH_CANCELLED', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 16, 15).edit((s) => {
      const f = s.facilities[0]!;
      f.owner = 1;
      f.level = 2;
      f.type = 'lab';
      f.research = { project: 2, days: 3 };
      s.players[0]!.bomb = { fuse: 1 };
      s.pools.items[ITEM.TIME_BOMB] = s.pools.items[ITEM.TIME_BOMB]! - 1;
    });
    sc.force('dice', 1).roll(0);
    sc.expectEvents(['BOMB_EXPLODED', 'RESEARCH_CANCELLED', 'CONFINED']);
    expect(sc.event('RESEARCH_CANCELLED')).toMatchObject({ seat: 1, lot: 'F1', project: 2 });
    expect(sc.state.facilities[0]).toMatchObject({ level: 1, research: null });
  });

  it('破产：身上的炸弹放回所在格，附身的神离场（搭档刷出），同盟解除', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 10, 9)
      .teleport(1, 4, 3)
      .attachGod(0, 5)
      .edit((s) => {
        Object.assign(s.lands[3]!, { owner: 1, level: 5 });
        s.players[0]!.bomb = { fuse: 20 };
        s.pools.items[ITEM.TIME_BOMB] = s.pools.items[ITEM.TIME_BOMB]! - 1;
        s.players[0]!.alliance = { seat: 2, days: 5 };
        s.players[2]!.alliance = { seat: 0, days: 5 };
      });
    sc.setCash(0, 10, 0).force('dice', 1).roll(0);
    sc.expectEvents(['TOLL_PAID', 'BANKRUPT', 'OBJECT_PLACED', 'GOD_LEFT', 'GOD_SPAWNED', 'ALLIANCE_BROKEN']);
    expect(sc.event('GOD_LEFT')).toMatchObject({ seat: 0, kind: 5, reason: 'bankrupt' });
    expect(sc.state.objects).toMatchObject([{ kind: 'bomb', node: 11, placedBy: null }]);
    expect(sc.player(2).alliance).toBeNull();
    expect(sc.state.beggars).toEqual([{ seat: 0, node: 11 }]);
  });
});
