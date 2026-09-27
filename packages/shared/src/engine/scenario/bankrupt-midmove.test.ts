import { describe, expect, it } from 'vitest';
import { ITEM } from '../../data/tables/ids';
import { scenario } from '../testing/scenario';

/**
 * 破产打断：MOVE → LAND → TOLL 付款时付不起 → 压 BANKRUPT；BANKRUPT 完成后展开破产者的帧
 * （TOLL、LAND 被丢弃，TURN 转入 end），轮到下一位（design/engine.md §6.2）。
 */
function setup(players: ('human' | 'ai')[]) {
  const sc = scenario({ players }).untilMenu(0);
  // 0 号买下 L1（租金 rent[0] = 400）
  sc.teleport(0, 4, 3).force('dice', 1).roll(0).confirm(0);
  // 1 号买下 L4，然后只剩 100 元
  sc.untilMenu(1).teleport(1, 10, 9).force('dice', 1).roll(1).confirm(1);
  expect(sc.state.lands[3]!.owner).toBe(1);
  sc.edit((st) => {
    st.lands[3]!.level = 2;
  });
  sc.untilMenu(1);
  // 免罪卡不参与过路费（免费卡会在付不起时先问 USE_FREE_CARD，见 effects/passive.test.ts）
  sc.give(1, { cards: [17, 21] }).setCash(1, 100, 0);
  return sc;
}

describe('场景：移动途中破产（BANKRUPT 帧与展开）', () => {
  it('三人局：付出剩下的 100 元后出局，清算、变乞丐，轮到下一位', () => {
    const sc = setup(['human', 'human', 'human']);
    const deckBefore = sc.state.pools.cards[17]!;
    const cash0 = sc.player(0).cash;
    sc.teleport(1, 3, 2).force('dice', 2).roll(1);

    sc.expectEvents(
      [
        'DICE_ROLLED',
        'MOVE_SEGMENT',
        'LANDED',
        'TOLL_PAID',
        'BANKRUPT',
        'LIQUIDATION',
        'BECAME_BEGGAR',
        'TURN_ENDED',
        'TURN_STARTED',
      ],
      'contains',
    );
    expect(sc.event('MOVE_SEGMENT').path).toEqual([4, 5]);
    expect(sc.event('TOLL_PAID')).toMatchObject({ payer: 1, owner: 0, amount: 100 });
    expect(sc.event('BANKRUPT')).toMatchObject({
      seat: 1,
      cause: { k: 'toll', ref: 'L1' },
      creditor: { t: 'seat', seat: 0 },
    });
    expect(sc.event('LIQUIDATION')).toMatchObject({ seat: 1, lots: ['L4'], auctionLots: [] });

    const p1 = sc.player(1);
    expect(p1).toMatchObject({ alive: false, out: 'bankrupt', cash: 0, deposit: 0, points: 0, cards: [] });
    expect(p1.items.every((n) => n === 0)).toBe(true);
    expect(sc.player(0).cash).toBe(cash0 + 100);
    // 地产变无主、等级保留；卡片回牌堆；道具回库存
    expect(sc.state.lands[3]).toMatchObject({ owner: null, level: 2, tenure: 0 });
    expect(sc.state.pools.cards[17]).toBe(deckBefore + 1);
    expect(sc.state.pools.items[ITEM.ROADBLOCK]).toBe(10 - 2);
    expect(sc.state.beggars).toEqual([{ seat: 1, node: 5 }]);

    // 展开：栈里没有 1 号的帧，下一位是 2 号
    expect(sc.state.flow.map((f) => f.k)).toEqual(['ROOT', 'TURN']);
    expect(sc.state.flow[1]).toMatchObject({ k: 'TURN', seat: 2, stage: 'menu' });
    sc.expectAsk(2, 'TURN_MENU');
    expect(sc.state.status).toBe('playing');

    // 之后的轮转跳过出局者
    sc.roll(2).untilMenu(0).roll(0);
    sc.until((s) => s.pending[0]?.kind === 'TURN_MENU');
    expect(sc.state.pending[0]!.seat).not.toBe(1);
  });

  it('两人局：只剩 1 人 → lastStanding，跳过清算（地产原样保留）', () => {
    const sc = setup(['human', 'human']);
    sc.teleport(1, 3, 2).force('dice', 2).roll(1);
    sc.expectEvents(['TOLL_PAID', 'BANKRUPT', 'GAME_OVER'], 'contains');
    expect(sc.events.map((e) => e.type)).not.toContain('LIQUIDATION');
    expect(sc.state.status).toBe('over');
    expect(sc.state.result).toMatchObject({ reason: 'lastStanding', winner: 0, code: 3 });
    expect(sc.state.pending).toEqual([]);
    expect(sc.state.lands[3]!.owner).toBe(1);
    expect(sc.engine.getPendingDecisions(sc.state)).toEqual([]);
    expect(sc.engine.getResult(sc.state)?.winner).toBe(0);
    expect(() => sc.apply({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: 1 } })).toThrow(/GAME_OVER/);
  });

  it('真人 vs 电脑：唯一的真人破产 → noHumansLeft（code 1，无赢家）', () => {
    const sc = scenario({ players: ['ai', 'human'] }).untilMenu(0);
    sc.teleport(0, 4, 3).force('dice', 1).roll(0).confirm(0);
    sc.untilMenu(1).setCash(1, 10, 0).teleport(1, 4, 3).force('dice', 1).roll(1);
    expect(sc.state.result).toMatchObject({ reason: 'noHumansLeft', code: 1, winner: null });
  });
});
