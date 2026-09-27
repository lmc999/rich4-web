import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../../data/maps/registry';
import { ECON } from '../../data/tables/economy';
import { CARD, ITEM } from '../../data/tables/ids';
import { engineMap } from '../core/mapCache';
import { scenario } from '../testing/scenario';
import type { GameEvent } from '../types/events';
import type { SeatIndex } from '../types/ids';

/**
 * M6 验证 1 的场景（architecture milestones M6；design/engine.md §16.3）：
 * passive.frame-scapegoat-4days、passive.revenge、bomb.transfer-then-explode、missile.window、
 * god.displace-partner-respawn、jail.two-phase-release。
 */
function turnEvents(log: readonly GameEvent[], seat: SeatIndex): string[] {
  const out: string[] = [];
  let mine = false;
  for (const e of log) {
    if (e.type === 'TURN_STARTED') mine = e.actor.t === 'seat' && e.actor.seat === seat;
    if (!mine) continue;
    if (e.type === 'TURN_BLOCKED') out.push(`blocked:${e.remaining}`);
    else if (e.type === 'RELEASED' || e.type === 'RETURNED' || e.type === 'DICE_ROLLED') out.push(e.type);
  }
  return out;
}

describe('M6 场景', () => {
  it('passive.frame-scapegoat-4days：陷害被嫁祸回出卡者 → 出卡者坐牢 4 天（4 个受阻回合 + 1 个走回棋盘的回合）', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4)
      .teleport(1, 6, 5)
      .give(0, { cards: [CARD.FRAME] })
      .give(1, { cards: [CARD.SCAPEGOAT] });
    sc.useCard(0, CARD.FRAME, { t: 'actor', actor: { t: 'seat', seat: 1 } }).expectAsk(1, 'SCAPEGOAT');
    expect(sc.pending(1).options).toMatchObject({ context: 'frame', days: 5, candidates: [0] });
    sc.act(1, { type: 'SCAPEGOAT', target: 0 });
    sc.expectEvents(['PASSIVE', 'CONFINED', 'TURN_ENDED']);
    expect(sc.event('CONFINED')).toMatchObject({ actor: { t: 'seat', seat: 0 }, where: 'jail', days: 4, total: 4 });
    expect(sc.player(0)).toMatchObject({ node: 14, st: expect.objectContaining({ jail: 4 }) });
    expect(sc.player(1).st.jail).toBe(0);
    const from = sc.log.length;
    sc.until((s) => s.pending[0]?.seat === 0 && s.pending[0]?.kind === 'TURN_MENU');
    expect(turnEvents(sc.log.slice(from), 0)).toEqual([
      'blocked:4',
      'blocked:3',
      'blocked:2',
      'blocked:1',
      'RELEASED',
      'RETURNED',
    ]);
  });

  it('passive.revenge：陷害命中持复仇卡的原目标 → 原目标坐牢 5 天，出卡者也坐牢 5 天', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11);
    sc.give(0, { cards: [CARD.FRAME] }).give(1, { cards: [CARD.REVENGE] });
    const deck = sc.state.pools.cards[CARD.REVENGE]!;
    sc.useCard(0, CARD.FRAME, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    sc.expectEvents(['CARD_USED', 'CONFINED', 'PASSIVE', 'CONFINED', 'TURN_ENDED']);
    const confined = sc.events.filter((e) => e.type === 'CONFINED');
    expect(confined.map((e) => [e.actor, e.days])).toEqual([
      [{ t: 'seat', seat: 1 }, 5],
      [{ t: 'seat', seat: 0 }, 5],
    ]);
    expect(sc.event('PASSIVE')).toMatchObject({ seat: 1, card: CARD.REVENGE, context: 'frame' });
    expect(sc.state.pools.cards[CARD.REVENGE]).toBe(deck + 1);
    // 被嫁祸改了目标就不触发复仇
    const moved = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    moved.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11);
    moved
      .give(0, { cards: [CARD.FRAME] })
      .give(1, { cards: [CARD.SCAPEGOAT, CARD.REVENGE] })
      .give(2, {
        cards: [CARD.REVENGE],
      });
    moved
      .useCard(0, CARD.FRAME, { t: 'actor', actor: { t: 'seat', seat: 1 } })
      .act(1, { type: 'SCAPEGOAT', target: 2 });
    expect(moved.events.filter((e) => e.type === 'CONFINED')).toHaveLength(1);
    expect(moved.player(2).st.jail).toBe(5);
    expect(moved.player(0).st.jail).toBe(0);
    expect(moved.player(2).cards).toEqual([CARD.REVENGE]);
  });

  it('bomb.transfer-then-explode：同格相遇转手（引信不重置），归零爆炸：携带者住院 5 天毁车、所在格地产降 1 级', () => {
    const sc = scenario({ players: ['human', 'human'], config: { vehicle: 'car' } }).untilMenu(0);
    sc.teleport(0, 5, 4).teleport(1, 6, 5);
    sc.edit((s) => {
      s.players[0]!.bomb = { fuse: 2 };
      s.pools.items[ITEM.TIME_BOMB] = s.pools.items[ITEM.TIME_BOMB]! - 1;
      Object.assign(s.lands[2]!, { owner: 0, level: 3 });
    });
    sc.force('dice', 1).roll(0, 1);
    sc.expectEvents(['DICE_ROLLED', 'MOVE_SEGMENT', 'BOMB_TRANSFERRED', 'LANDED']);
    expect(sc.event('BOMB_TRANSFERRED')).toEqual(expect.objectContaining({ from: 0, to: 1, fuse: 1 }));
    expect(sc.player(0).bomb).toBeNull();
    expect(sc.player(1).bomb).toEqual({ fuse: 1 });
    sc.decline(0).untilMenu(1);
    const pool = sc.state.pools.items;
    const [bombs, cars] = [pool[ITEM.TIME_BOMB]!, pool[ITEM.CAR]!];
    sc.force('dice', 3).roll(1, 1);
    sc.expectEvents(['DICE_ROLLED', 'MOVE_SEGMENT', 'BOMB_EXPLODED', 'VEHICLE_DESTROYED', 'CONFINED', 'TURN_ENDED']);
    expect(sc.event('BOMB_EXPLODED')).toMatchObject({ seat: 1, node: 7, lot: 'L3' });
    expect(sc.event('MOVE_SEGMENT').path).toEqual([7]);
    expect(sc.player(1)).toMatchObject({ bomb: null, vehicle: 'walk', node: 15 });
    expect(sc.player(1).st.hospital).toBe(5);
    expect(sc.state.lands[2]).toMatchObject({ owner: 0, level: 2 });
    expect(sc.state.pools.items[ITEM.TIME_BOMB]).toBe(bombs + 1);
    expect(sc.state.pools.items[ITEM.CAR]).toBe(cars + 1);
    expect(sc.events.map((e) => e.type)).not.toContain('LANDED');
  });

  it('bomb.manual3x3：炸弹范围开关 manual3x3 → 半宽 100 方窗内的人住院 5 天、地产降级', () => {
    const sc = scenario({ players: ['human', 'human', 'human'], rules: { bombBlast: 'manual3x3' } }).untilMenu(0);
    sc.teleport(0, 5, 4).teleport(1, 7, 6).teleport(2, 17, 16);
    sc.edit((s) => {
      s.players[0]!.bomb = { fuse: 1 };
      s.pools.items[ITEM.TIME_BOMB] = s.pools.items[ITEM.TIME_BOMB]! - 1;
      Object.assign(s.lands[1]!, { owner: 1, level: 2 });
    });
    sc.force('dice', 1).roll(0);
    expect(sc.event('STRIKE')).toMatchObject({ kind: 'bomb3x3', center: 6, half: ECON.MISSILE_HALF, lots: ['L2'] });
    expect(sc.state.lands[1]!.level).toBe(1);
    const hit = sc.events.filter((e) => e.type === 'CONFINED').map((e) => e.actor);
    expect(hit).toEqual([
      { t: 'seat', seat: 0 },
      { t: 'seat', seat: 1 },
    ]);
  });

  it('missile.window：半开方窗 −100 ≤ d < 100（以目标格世界坐标为中心），窗外的人与地产不受影响', () => {
    const em = engineMap(fixtureRegistry.getMap('test'));
    const sc = scenario({ players: ['human', 'human', 'human', 'human'] }).untilMenu(0);
    // 中心 6 号格 (224,64)：x ∈ [124, 324)、y ∈ [−36, 164)
    sc.teleport(0, 16, 15)
      .teleport(1, 2, 1)
      .teleport(2, 3, 2)
      .teleport(3, 14 - 1, 12);
    expect([2, 3, 13].map((t) => em.index.tile(t).world)).toEqual([
      { x: 96, y: 64 },
      { x: 128, y: 64 },
      { x: 160, y: 160 },
    ]);
    sc.give(0, { items: [{ item: ITEM.MISSILE, qty: 1 }] }).edit((s) => {
      for (const l of s.lands) Object.assign(l, { owner: 1, level: 2 });
      Object.assign(s.facilities[0]!, { owner: 1, level: 2, type: 'hotel' });
    });
    sc.placeObject('roadblock', 4)
      .placeObject('mine', 17)
      .placeGod(1, 9)
      .placeGod(3, 16 + 2);
    sc.useItem(0, ITEM.MISSILE, { t: 'node', node: 6 });
    const strike = sc.event('STRIKE');
    expect(strike.lots).toEqual(['L1', 'L2', 'L3']);
    expect(strike.actors).toEqual([
      { t: 'seat', seat: 2 },
      { t: 'seat', seat: 3 },
    ]);
    expect(sc.state.lands.map((l) => l.level)).toEqual([1, 1, 1, 2, 2]);
    expect(sc.state.facilities[0]!.level).toBe(2);
    expect(sc.state.objects.map((o) => o.node)).toEqual([17]);
    expect(sc.state.gods.find((g) => g.kind === 1)!.where.t).toBe('absent');
    expect(sc.state.gods.find((g) => g.kind === 3)!.where).toEqual({ t: 'road', node: 18 });
    expect(sc.player(1).st.hospital).toBe(0);
    expect([sc.player(2).st.hospital, sc.player(3).st.hospital]).toEqual([3, 3]);
  });

  it('god.displace-partner-respawn：附身新神先挤走旧神，旧神的搭档在 |dx|或|dy| ≥ 300 的格刷出；新神立即发威', () => {
    const em = engineMap(fixtureRegistry.getMap('test-allkinds'));
    const sc = scenario({ map: 'test-allkinds', players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 1, 18).teleport(1, 12, 11).attachGod(0, 1).placeGod(3, 3);
    expect(sc.player(0).luck.wealth).toBe(100);
    sc.force('deck', CARD.FREE).force('dice', 2).roll(0);
    sc.expectEvents(['LANDED', 'GOD_LEFT', 'GOD_SPAWNED', 'GOD_ATTACHED', 'GOD_POWER', 'CARD_GAINED']);
    expect(sc.event('GOD_LEFT')).toMatchObject({ seat: 0, kind: 1, reason: 'displaced' });
    expect(sc.event('GOD_ATTACHED')).toMatchObject({ seat: 0, kind: 3, displaced: 1 });
    const spawned = sc.event('GOD_SPAWNED');
    expect(spawned.kind).toBe(2);
    const ref = em.index.tile(3).world;
    const w = em.index.tile(spawned.node).world;
    expect(Math.abs(w.x - ref.x) >= 300 || Math.abs(w.y - ref.y) >= 300).toBe(true);
    expect(sc.player(0)).toMatchObject({ god: { kind: 3, days: 7 }, luck: { bad: -100, wealth: 0, fortune: 100 } });
    expect(sc.player(0).cards).toEqual([CARD.FREE]);
    expect(sc.state.gods.filter((g) => g.kind === 1 || g.kind === 2).map((g) => g.where.t)).toEqual(['absent', 'road']);
  });

  it('god.respawn-fallback：64 次都找不到足够远的格时放宽距离（DEV-08）', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4)
      .attachGod(0, 7)
      .give(0, { cards: [CARD.DISPEL_GOD] });
    sc.useCard(0, CARD.DISPEL_GOD);
    const n = sc.log.filter((e) => e.type === 'GOD_SPAWNED').length;
    expect(n).toBe(1);
    expect(sc.state.gods.find((g) => g.kind === 8)!.where.t).toBe('road');
  });

  it('jail.two-phase-release：坐牢 5 天 = 5 个受阻回合 + 1 个走回棋盘（不掷骰）的回合，第 7 个回合照常行动；保释改为待释放', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4)
      .teleport(1, 6, 5)
      .give(0, { cards: [CARD.FRAME] });
    sc.useCard(0, CARD.FRAME, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    expect(sc.player(1).st.jail).toBe(5);
    const from = sc.log.length;
    let menus = 0;
    sc.until((s) => {
      if (s.pending[0]?.seat === 1 && s.pending[0].kind === 'TURN_MENU') menus++;
      return menus > 0;
    });
    expect(turnEvents(sc.log.slice(from), 1)).toEqual([
      'blocked:5',
      'blocked:4',
      'blocked:3',
      'blocked:2',
      'blocked:1',
      'RELEASED',
      'RETURNED',
    ]);
    expect(sc.player(1)).toMatchObject({ node: 14, returning: false, st: expect.objectContaining({ jail: 0 }) });

    // 保释：停在监狱格（保释格）花 30 点券，被保释者计数改为 0x80，下一个自己的回合开头释放、走回棋盘
    const bail = scenario({ players: ['human', 'human'] }).untilMenu(0);
    bail
      .teleport(0, 12, 11)
      .teleport(1, 6, 5)
      .give(0, { cards: [CARD.FRAME] })
      .setPoints(0, 40);
    bail.useCard(0, CARD.FRAME, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    bail.force('fork', 0, 1).force('dice', 2).roll(0).expectAsk(0, 'BAIL');
    expect(bail.pending(0).options).toMatchObject({
      where: 'jail',
      points: 40,
      inmates: [{ seat: 1, remaining: 6 }],
      costs: { bail: 30, hire: 300 },
    });
    expect(() => bail.act(0, { type: 'HIRE', villain: 'thief' })).toThrow(/NOT_ALLOWED/);
    bail.act(0, { type: 'BAIL', target: 1 });
    expect(bail.event('BAIL')).toMatchObject({ by: 0, seat: 1, cost: 30 });
    expect(bail.player(0).points).toBe(10);
    // 同一个 action 里轮到 1 号：计数已是 0x80，回合开头释放并走回棋盘（不掷骰）
    bail.expectEvents(['BAIL', 'TURN_ENDED', 'TURN_STARTED', 'RELEASED', 'RETURNED', 'TURN_ENDED']);
    expect(turnEvents(bail.events, 1)).toEqual(['RELEASED', 'RETURNED']);
    expect(bail.player(1).st.jail).toBe(0);
  });
});
