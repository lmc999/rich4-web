import { describe, expect, it } from 'vitest';
import { scenario } from '../testing/scenario';

/**
 * fixture 'test'：4(卡片) → 5(L1) → 6(L2) → 7(L3)，S01 街 地价 2000 / 房价 500 / 租金 [400,1000,2500,6000,12000,24000]。
 * 4→19 静态封路，所以从 4（来路 3）只能向东走。
 */
describe('场景：买地 → 加盖 → 过路费（同街累加）', () => {
  it('全流程与事件', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);

    // 0 号买 L1
    sc.teleport(0, 4, 3).force('dice', 1).roll(0);
    sc.expectEvents(['DICE_ROLLED', 'MOVE_SEGMENT', 'LANDED']).expectAsk(0, 'BUY_LAND');
    expect(sc.pending(0).options).toMatchObject({ lot: 'L1', price: 2000, cash: 100000, tollAfter: 400 });
    expect(sc.pending(0).publicInfo).toMatchObject({ kind: 'BUY_LAND', seat: 0, lot: 'L1', amount: 2000 });
    expect(sc.event('MOVE_SEGMENT').path).toEqual([5]);
    sc.confirm(0).expectEvents(['LAND_BOUGHT', 'TURN_ENDED', 'TURN_STARTED']);
    expect(sc.state.lands[0]).toMatchObject({ owner: 0, level: 0, tenure: 0 });
    expect(sc.player(0).cash).toBe(98000);

    // 1 号停在 L1：付 rent[0]
    sc.untilMenu(1).teleport(1, 4, 3).force('dice', 1).roll(1);
    const paid = sc.event('TOLL_PAID');
    expect(paid).toMatchObject({ payer: 1, owner: 0, amount: 400, lots: ['L1'] });
    expect(paid.post?.players?.map((p) => p.seat).sort()).toEqual([0, 1]);
    expect(sc.player(1).cash).toBe(99600);
    expect(sc.player(0).cash).toBe(98400);
    expect(sc.player(1).monthly.loss).toBe(400);
    expect(sc.player(0).monthly.gain).toBe(400);
    expect(sc.state.lands[0]!.lastToll).toBe(400);

    // 0 号回到 L1 加盖一层，再买 L2
    sc.untilMenu(0).teleport(0, 4, 3).force('dice', 1).roll(0).expectAsk(0, 'UPGRADE_LAND');
    expect(sc.pending(0).options).toMatchObject({
      cost: 500,
      fromLevel: 0,
      toLevel: 1,
      tollBefore: 400,
      tollAfter: 1000,
    });
    sc.confirm(0).expectEvents(['LOT_LEVEL', 'TURN_ENDED']);
    expect(sc.event('LOT_LEVEL')).toMatchObject({ lot: 'L1', from: 0, to: 1 });
    sc.untilMenu(1).teleport(1, 18, 17).force('dice', 1).roll(1); // 1 号走到 1（银行格，M1 无事）
    sc.untilMenu(0).teleport(0, 5, 4).force('dice', 1).roll(0).expectAsk(0, 'BUY_LAND');
    expect(sc.pending(0).options).toMatchObject({
      lot: 'L2',
      street: { lots: ['L1', 'L2', 'L3'], owners: [0, null, null] },
    });
    sc.confirm(0);

    // 1 号停在 L2：同街累加 rent[1](L1) + rent[0](L2)
    sc.untilMenu(1).teleport(1, 5, 4).force('dice', 1).roll(1);
    expect(sc.event('TOLL_PAID')).toMatchObject({
      amount: 1000 + 400,
      lots: ['L1', 'L2'],
      mods: ['street', 'priceIndex'],
    });
  });

  it('买不起不问（CANNOT_AFFORD）；不买（DECLINE）不改任何东西', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.setCash(0, 1999).teleport(0, 4, 3).force('dice', 1).roll(0);
    expect(sc.event('CANNOT_AFFORD')).toMatchObject({ seat: 0, lot: 'L1', price: 2000 });
    sc.expectNoAsk(0, 'BUY_LAND');
    sc.untilMenu(1).teleport(1, 4, 3).force('dice', 1).roll(1).expectAsk(1, 'BUY_LAND');
    const before = sc.state.lands[0];
    sc.decline(1);
    expect(sc.state.lands[0]).toEqual(before);
    expect(sc.events.map((e) => e.type)).not.toContain('LAND_BOUGHT');
  });

  it('CONFIRM 时若已买不起（调试改了现金）→ EngineRuleError，状态不变', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 4, 3).force('dice', 1).roll(0).expectAsk(0, 'BUY_LAND');
    sc.setCash(0, 10);
    const before = sc.state;
    expect(() => sc.confirm(0)).toThrow(/CANNOT_AFFORD/);
    expect(sc.state).toBe(before);
    sc.decline(0);
  });

  it('地契期限：1/15 买、一个月期限 → 2/15 到期变无主（等级保留）；1/31 买 → 2/31 永不到期', () => {
    const sc = scenario({ players: ['human', 'human'], config: { tenure: '1m' } }).untilMenu(0);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050115 } });
    sc.teleport(0, 4, 3).force('dice', 1).roll(0).confirm(0);
    expect(sc.state.lands[0]!.tenure).toBe(20050215);
    sc.edit((s) => {
      s.lands[0]!.level = 2;
    });
    // 直接跳到到期前一天再自然推进一天：整月自然推进时新闻 / 命运 / 魔法屋可能先把 L1 清掉（随机轨迹随规则变化）
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050214 } });
    sc.until((s) => s.clock.date === 20050215 && s.pending[0]?.kind === 'TURN_MENU');
    const expired = sc.log.find((e) => e.type === 'TENURE_EXPIRED');
    expect(expired).toMatchObject({ lots: ['L1'] });
    expect(sc.state.lands[0]).toMatchObject({ owner: null, level: 2, tenure: 0 });

    const sc2 = scenario({ players: ['human', 'human'], config: { tenure: '1m' } }).untilMenu(0);
    sc2.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050131 } });
    sc2.teleport(0, 4, 3).force('dice', 1).roll(0).confirm(0);
    expect(sc2.state.lands[0]!.tenure).toBe(20050231);
    sc2.until((s) => s.clock.date >= 20050401);
    expect(sc2.state.lands[0]!.owner).toBe(0);
  });
});
