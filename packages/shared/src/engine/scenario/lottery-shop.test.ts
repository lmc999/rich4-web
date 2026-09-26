import { describe, expect, it } from 'vitest';
import { cardDef } from '../../data/tables/cards';
import { scenario } from '../testing/scenario';
import type { ShopOptions } from '../types/decision';

/**
 * 乐透与百货公司（design/engine.md §8、§11.4；docs/research/r_squares_events.md §4、r_cards.md §4）。
 * fixture 'test'：7 → 8（乐透）→ 9 → 10（百货公司，企业 C2 = 百货，股票 2）。
 */
function setPool(s: { econ: { pool: number; ledger: { minted: number; burned: number } } }, v: number) {
  s.econ.ledger.minted += v - s.econ.pool;
  s.econ.pool = v;
}

describe('lottery', () => {
  it('lottery.buy：现金 ≥ 1000 时问，每注 1000 只用现金、进公库；号码不能重复买', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 7, 6).force('dice', 1).roll(0).expectAsk(0, 'LOTTERY');
    expect(sc.pending(0).options).toMatchObject({ cash: 100000, price: 1000, pool: 0 });
    sc.act(0, { type: 'LOTTERY_BUY', number: 4 });
    expect(sc.event('LOTTERY_TICKET')).toMatchObject({ seat: 0, number: 4 });
    expect(sc.player(0).cash).toBe(99000);
    expect(sc.state.econ.pool).toBe(1000);
    expect(sc.state.lottery.owners[4]).toBe(0);
    sc.untilMenu(1).teleport(1, 7, 6).force('dice', 1).roll(1).expectAsk(1, 'LOTTERY');
    expect(() => sc.act(1, { type: 'LOTTERY_BUY', number: 4 })).toThrow(/NOT_ALLOWED/);
    sc.act(1, { type: 'SKIP' });
    // 现金不足 1000 不问
    sc.untilMenu(0).setCash(0, 999, 100000).teleport(0, 7, 6).force('dice', 1).roll(0).expectNoAsk(0, 'LOTTERY');
  });

  it('lottery.no-winner-carryover：开出没人买的号码 → 公库与号码原样保留到下一期', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(1);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050514 } }).edit((s) => {
      s.lottery.owners[0] = 0;
      s.lottery.owners[1] = 1;
      setPool(s, 5000);
    });
    sc.force('lottery', 20);
    sc.until((s) => s.clock.date === 20050515);
    expect(sc.log.find((e) => e.type === 'LOTTERY_DRAW')).toMatchObject({ number: 20, winner: null, prize: 0 });
    expect(sc.state.econ.pool).toBe(5000);
    expect(sc.state.lottery.owners.slice(0, 2)).toEqual([0, 1]);
  });

  it('lottery.winner：中奖者独得公库（进现金），号码清空', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(1);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050514 } }).edit((s) => {
      s.lottery.owners[0] = 0;
      s.lottery.owners[1] = 1;
      setPool(s, 5000);
    });
    const cash = sc.player(1).cash;
    sc.force('lottery', 1).until((s) => s.clock.date === 20050515);
    expect(sc.log.find((e) => e.type === 'LOTTERY_DRAW')).toMatchObject({ number: 1, winner: 1, prize: 5000 });
    expect(sc.player(1).cash).toBe(cash + 5000);
    expect(sc.state.econ.pool).toBe(0);
    expect(sc.state.lottery.owners.every((o) => o === null)).toBe(true);
  });

  it('lottery.sold-only：有人持号 > 10 个时只在已售号码里开（必有人中）；无人购票不开奖', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(1);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050514 } }).edit((s) => {
      for (let i = 0; i < 11; i++) s.lottery.owners[i] = 0;
      s.lottery.owners[30] = 1;
      setPool(s, 3000);
    });
    // 已售号码 [0..10, 30]，下标 11 → 号码 30
    sc.force('lottery', 11).until((s) => s.clock.date === 20050515);
    expect(sc.log.find((e) => e.type === 'LOTTERY_DRAW')).toMatchObject({ number: 30, winner: 1, prize: 3000 });

    const none = scenario({ players: ['human', 'human'] }).untilMenu(1);
    none.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050514 } });
    none.until((s) => s.clock.date === 20050515);
    expect(none.log.some((e) => e.type === 'LOTTERY_DRAW')).toBe(false);
  });
});

describe('shop', () => {
  it('shop.human-shelf：真人面对 6..15 张的货架；买卡、卖卡、买卖道具；每笔交易后重发 SHOP', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: 500 } });
    sc.force('shelf', 3).teleport(0, 9, 8).force('dice', 1).roll(0).expectAsk(0, 'SHOP');
    const o = sc.pending(0).options as ShopOptions;
    expect(o).toMatchObject({ points: 500, handCount: 0, handMax: 15, fullDeck: false });
    expect(o.shelf).toHaveLength(9);
    expect(sc.event('SHOP_OPENED')).toMatchObject({ seat: 0, fullDeck: false });
    expect(o.items.map((r) => r.item)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(o.items.find((r) => r.item === 8)).toMatchObject({ price: 30, own: 1, maxQty: 8 });
    expect(o.visit).toEqual({ entryPoints: 500, trades: [], remaining: 60 });

    const first = o.shelf[0]!;
    const deckBefore = sc.state.pools.cards[first.card]!;
    sc.act(0, { type: 'SHOP_BUY_CARD', shelfIdx: 0 });
    expect(sc.event('SHOP_TRADE')).toMatchObject({ seat: 0, op: 'buyCard', card: first.card, points: first.price });
    expect(sc.player(0)).toMatchObject({ points: 500 - first.price, cards: [first.card] });
    expect(sc.state.pools.cards[first.card]).toBe(deckBefore - 1);
    const o2 = sc.pending(0).options as ShopOptions;
    expect(o2.shelf).toHaveLength(8);
    expect(o2.visit.trades).toHaveLength(1);

    sc.act(0, { type: 'SHOP_SELL_CARD', slot: 0 });
    const back = Math.trunc((cardDef(first.card).price * 9) / 10);
    expect(sc.player(0).points).toBe(500 - first.price + back);
    expect(sc.state.pools.cards[first.card]).toBe(deckBefore);

    const pts = sc.player(0).points;
    sc.act(0, { type: 'SHOP_BUY_ITEM', item: 8, qty: 2 });
    expect(sc.player(0).items[8]).toBe(3);
    sc.act(0, { type: 'SHOP_SELL_ITEM', item: 8, qty: 3 });
    expect(sc.player(0).points).toBe(pts - 60 + 81);
    expect(sc.player(0).items[8]).toBe(0);
    expect(() => sc.act(0, { type: 'SHOP_BUY_ITEM', item: 9, qty: 1 })).toThrow(/INVALID_TARGET/);
    sc.act(0, { type: 'LEAVE' }).expectNoAsk(0, 'SHOP');
  });

  it('shop：满 15 张不能买卡；点券不足不能买', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.give(0, { cards: [3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 7, 7, 7] });
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: 10 } });
    sc.teleport(0, 9, 8).force('dice', 1).roll(0).expectAsk(0, 'SHOP');
    const o = sc.pending(0).options as ShopOptions;
    expect(o.shelf.every((r) => !r.buyable)).toBe(true);
    expect(() => sc.act(0, { type: 'SHOP_BUY_CARD', shelfIdx: 0 })).toThrow(/NOT_ALLOWED|CANNOT_AFFORD/);
    expect(() => sc.act(0, { type: 'SHOP_BUY_ITEM', item: 2, qty: 1 })).toThrow(/CANNOT_AFFORD/);
  });

  it('shop.ai-fulldeck：电脑座位面对整副牌堆（每种剩余的卡一行）', () => {
    const sc = scenario({ players: ['human', 'ai'] }).untilMenu(1);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 1, points: 300 } });
    sc.teleport(1, 9, 8).force('dice', 1).roll(1).expectAsk(1, 'SHOP');
    const o = sc.pending(1).options as ShopOptions;
    expect(o.fullDeck).toBe(true);
    const kinds = Array.from({ length: 30 }, (_, i) => i + 1).filter((c) => (sc.state.pools.cards[c] ?? 0) > 0);
    expect(o.shelf.map((r) => r.card)).toEqual(kinds);
    const first = o.shelf[0]!.card;
    const left = sc.state.pools.cards[first]!;
    sc.act(1, { type: 'SHOP_BUY_CARD', shelfIdx: 0 });
    // 买走最后一张后这一种从整副牌堆的货架上消失
    const shelf = (sc.pending(1).options as ShopOptions).shelf.map((r) => r.card);
    expect(shelf.includes(first)).toBe(left > 1);
  });

  it('shop.controller-switch：进店后改 controller 不改变货架模式，已发出的 shelfIdx 仍按原货架解释', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: 1000 } });
    sc.force('shelf', 3).teleport(0, 9, 8).force('dice', 1).roll(0).expectAsk(0, 'SHOP');
    const before = sc.pending(0);
    const o = before.options as ShopOptions;
    expect(o.fullDeck).toBe(false);
    // 服务器踢人：真人座位转电脑，pending 不变
    sc.apply({ type: 'SYS_SET_CONTROLLER', seat: 0, controller: 'ai' });
    expect(sc.pending(0).id).toBe(before.id);
    const pick = o.shelf[2]!;
    sc.act(0, { type: 'SHOP_BUY_CARD', shelfIdx: 2 });
    expect(sc.event('SHOP_TRADE')).toMatchObject({ seat: 0, op: 'buyCard', card: pick.card });
    const o2 = sc.pending(0).options as ShopOptions;
    expect(o2.fullDeck).toBe(false);
    expect(o2.shelf.map((r) => r.card)).toEqual(o.shelf.filter((_, i) => i !== 2).map((r) => r.card));
    sc.act(0, { type: 'LEAVE' });

    // 反方向：电脑座位进店后由真人认领，仍面对整副牌堆（不会出现空货架）
    const ai = scenario({ players: ['human', 'ai'] }).untilMenu(1);
    ai.apply({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 1, points: 300 } });
    ai.teleport(1, 9, 8).force('dice', 1).roll(1).expectAsk(1, 'SHOP');
    ai.apply({ type: 'SYS_SET_CONTROLLER', seat: 1, controller: 'human' });
    const full = ai.pending(1).options as ShopOptions;
    expect(full.fullDeck).toBe(true);
    ai.act(1, { type: 'SHOP_BUY_CARD', shelfIdx: 0 });
    expect(ai.event('SHOP_TRADE')).toMatchObject({ seat: 1, card: full.shelf[0]!.card });
    expect((ai.pending(1).options as ShopOptions).fullDeck).toBe(true);
  });

  it('shop.chairman-gift：百货公司董事长进店先得一张卡或一个道具', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.edit((s) => {
      s.players[0]!.holdings[2] = { shares: 10, costCents: 30000 };
      s.stocks[2]!.float -= 10;
      s.stocks[2]!.chairman = 0;
    });
    sc.force('chairmanGift', 0).force('deck', 9).teleport(0, 9, 8).force('dice', 1).roll(0);
    expect(sc.event('CHAIRMAN_GIFT')).toMatchObject({ seat: 0, card: 9, item: null });
    expect(sc.player(0).cards).toEqual([9]);
    sc.act(0, { type: 'LEAVE' });
    sc.untilMenu(0).force('chairmanGift', 1).force('gift', 1).teleport(0, 9, 8).force('dice', 1).roll(0);
    expect(sc.event('CHAIRMAN_GIFT')).toMatchObject({ seat: 0, card: null });
  });
});
