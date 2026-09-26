import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../../data/maps/registry';
import { engineMap } from '../core/mapCache';
import { editState, makeConfig, makeSetups, testEngine } from '../testing/builders';
import type { CardId } from '../types/ids';
import { checkInvariants } from '../validate/invariants';
import { cheapestCardSlot, receiveCard, receiveItem, removeItem, sellValue, takeFromDeck } from './inventory';
import { mint, spendCash, transfer } from './payment';

const em = engineMap(fixtureRegistry.getMap('test'));
const base = testEngine().createGame(makeConfig(), makeSetups(['human', 'human', 'human']), 'c0ffee');

describe('付款（design/engine.md §11.2）', () => {
  it('先现金后存款；银行口径先存款后现金', () => {
    const s = editState(base, () => {});
    transfer(s, { t: 'seat', seat: 0 }, { t: 'seat', seat: 1 }, 100500);
    expect(s.players[0]).toMatchObject({ cash: 0, deposit: 99500 });
    expect(s.players[1]!.cash).toBe(200500);
    transfer(s, { t: 'seat', seat: 1 }, { t: 'bank' }, 100, { order: 'depositFirst' });
    expect(s.players[1]).toMatchObject({ cash: 200500, deposit: 99900 });
    expect(checkInvariants(s, em)).toEqual([]);
  });

  it('两个口袋都不够：付出剩下的全部并标记破产，收款方只收到这部分', () => {
    const s = editState(base, (d) => {
      d.players[0]!.cash = 300;
      d.players[0]!.deposit = 200;
      d.econ.ledger.burned = 200000 - 500;
    });
    expect(checkInvariants(s, em)).toEqual([]);
    const r = transfer(s, { t: 'seat', seat: 0 }, { t: 'seat', seat: 2 }, 1000, { accident: true });
    expect(r).toEqual({ paid: 500, bankrupt: true });
    expect(s.players[0]).toMatchObject({ cash: 0, deposit: 0 });
    expect(s.players[2]!.cash).toBe(100500);
    expect(s.players[0]!.monthly.loss).toBe(500);
    expect(s.players[2]!.monthly.gain).toBe(500);
    expect(checkInvariants(s, em)).toEqual([]);
  });

  it('只用现金的消费：价格 > 现金失败（不破产、不改动）；成功时钱 burn', () => {
    const s = editState(base, () => {});
    expect(spendCash(s, 0, 100001)).toBe(false);
    expect(s.players[0]!.cash).toBe(100000);
    expect(spendCash(s, 0, 100000)).toBe(true);
    expect(s.players[0]!.cash).toBe(0);
    expect(s.econ.ledger.burned).toBe(100000);
    mint(s, 1, 700, 'deposit');
    expect(s.players[1]!.deposit).toBe(100700);
    expect(s.econ.ledger.minted).toBe(700);
    expect(checkInvariants(s, em)).toEqual([]);
  });

  it('公司与公库：公司盈余可以为负，不破产', () => {
    const s = editState(base, () => {});
    transfer(s, { t: 'company', company: 'C1' }, { t: 'pool' }, 3000);
    expect(s.companies[0]!.surplusMonth).toBe(-3000);
    expect(s.econ.pool).toBe(3000);
    expect(checkInvariants(s, em)).toEqual([]);
  });
});

describe('手牌与道具（g_arbitration §1、§2.g）', () => {
  it('满 15 张时自动弃最便宜的一张（同价取靠前的槽），新卡一定入手，被弃的回牌堆', () => {
    const s = editState(base, () => {});
    const hand: CardId[] = [9, 10, 1, 2, 15, 30, 11, 26, 27, 28, 29, 24, 12, 22, 7];
    for (const c of hand) {
      expect(takeFromDeck(s, c)).toBe(true);
      receiveCard(s, 0, c);
    }
    expect(s.players[0]!.cards).toHaveLength(15);
    // 最便宜：送神符 22（10 点），其次拆除 12 与改建 7（都是 15 点，取靠前的 12）
    expect(cheapestCardSlot(s.players[0]!.cards)).toBe(13);
    expect(takeFromDeck(s, 3)).toBe(true);
    expect(receiveCard(s, 0, 3)).toEqual({ discarded: 22 });
    expect(takeFromDeck(s, 4)).toBe(true);
    expect(receiveCard(s, 0, 4)).toEqual({ discarded: 12 });
    expect(s.players[0]!.cards).toHaveLength(15);
    expect(s.players[0]!.cards.slice(-2)).toEqual([3, 4]);
    expect(checkInvariants(s, em)).toEqual([]);
  });

  it('道具：每种最多 9 个；1..8 受共享库存限制，9..13 不受限；卖回价 ×0.9 向零取整', () => {
    const s = editState(base, () => {});
    expect(s.players[0]!.items[2]).toBe(1);
    expect(s.pools.items[2]).toBe(7);
    expect(receiveItem(s, 0, 2, 20)).toBe(7);
    expect(s.pools.items[2]).toBe(0);
    expect(receiveItem(s, 1, 2, 1)).toBe(0);
    expect(receiveItem(s, 0, 13, 20)).toBe(9);
    expect(removeItem(s, 0, 2, 3)).toBe(3);
    expect(s.pools.items[2]).toBe(3);
    expect(sellValue(25, 3)).toBe(67);
    expect(sellValue(15, 1)).toBe(13);
    expect(checkInvariants(s, em)).toEqual([]);
  });
});
