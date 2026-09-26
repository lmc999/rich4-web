import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../../data/maps/registry';
import { engineMap } from '../core/mapCache';
import { editState, makeConfig, makeSetups, testEngine } from '../testing/builders';
import { checkAfterBankruptcy, checkDayEnd, ranking } from './victory';
import { netWorth, nextPriceIndex } from './wealth';

const em = engineMap(fixtureRegistry.getMap('test'));
const base = testEngine().createGame(makeConfig(), makeSetups(['human', 'human', 'ai']), 'c0ffee');

describe('总资产（design/engine.md §11.1）', () => {
  it('现金 + 存款 − 贷款 + 股票 + 住宅(地价 + 等级×房价 / 连锁店 地价+房价) + 设施(地价 + 等级×rate0)', () => {
    const s = editState(base, (d) => {
      const p = d.players[0]!;
      p.cash = 1000;
      p.deposit = 2000;
      p.loan = 500;
      p.holdings[0] = { shares: 150, costCents: 0 };
      d.stocks[0]!.priceCents = 8033;
      d.lands[0]!.owner = 0;
      d.lands[0]!.level = 3;
      d.lands[3]!.owner = 0;
      d.lands[3]!.chain = true;
      d.lands[3]!.level = 1;
      d.facilities[0]!.owner = 0;
      d.facilities[0]!.level = 2;
      d.facilities[0]!.type = 'hotel';
    });
    const stock = Math.trunc((150 * 8033) / 100);
    const land = 2000 + 3 * 500;
    const chain = 1200 + 300;
    const facility = 4000 + 2 * 800;
    expect(netWorth(s, em, 0)).toBe(1000 + 2000 - 500 + stock + land + chain + facility);
  });

  it('开局：真人现金 = 总资金 / 2；电脑按角色现金比例（阿土伯 40%）；资产都等于总资金', () => {
    const [p0, p1, p2] = base.players;
    expect(p0!.cash).toBe(100000);
    expect(p0!.deposit).toBe(100000);
    expect(p1!.cash).toBe(100000); // 1 号是真人：角色比例不起作用
    expect(p2!.character).toBe(0);
    expect(p2!.cash).toBe(100000); // 约翰乔 50%
    const atubo = testEngine().createGame(
      makeConfig({ config: { initialFund: 300000 } }),
      [
        { seat: 0, character: 9, controller: 'human' },
        { seat: 1, character: 4, controller: 'ai' },
      ],
      'c0ffee',
    );
    expect(atubo.players[0]).toMatchObject({ cash: 150000, deposit: 150000 });
    expect(atubo.players[1]).toMatchObject({ cash: 120000, deposit: 180000 });
    for (const p of base.players) expect(netWorth(base, em, p.seat)).toBe(200000);
  });
});

describe('物价指数（只升不降）', () => {
  it('PI = max(PI, trunc(trunc(Σ在场资产 / 在场人数) / 开局资金))', () => {
    const rich = editState(base, (d) => {
      d.players[0]!.cash = 700000; // 资产 800000
      d.players[1]!.cash = 400000; // 500000
    });
    // (800000 + 500000 + 200000) / 3 = 500000 → / 200000 = 2
    expect(nextPriceIndex(rich, em)).toBe(2);
    const dropped = editState(rich, (d) => {
      d.econ.priceIndex = 3;
    });
    expect(nextPriceIndex(dropped, em)).toBe(3);
    const withOut = editState(rich, (d) => {
      d.players[2]!.alive = false;
    });
    // 只算在场者：(800000 + 500000) / 2 = 650000 → 3
    expect(nextPriceIndex(withOut, em)).toBe(3);
  });
});

describe('胜负判定（阈值 ≥；并列取座位靠前）', () => {
  it('资产达标：≥ 倍数 × 开局资金', () => {
    const s = editState(base, (d) => {
      d.config.winMultiple = 3;
      d.players[1]!.cash = 100000 + 400000; // 资产 600000 = 3 × 200000
    });
    expect(checkDayEnd(s, em)).toEqual({ reason: 'wealthTarget', winner: 1 });
    const below = editState(s, (d) => {
      d.players[1]!.cash -= 1;
    });
    expect(checkDayEnd(below, em)).toBeNull();
  });

  it('时间到：elapsed ≥ 游戏时间且首富资产 > 0；并列取座位靠前', () => {
    const s = editState(base, (d) => {
      d.config.timeLimitDays = 30;
      d.clock.elapsedDays = 30;
    });
    expect(checkDayEnd(s, em)).toEqual({ reason: 'timeLimit', winner: 0 });
    const poor = editState(s, (d) => {
      for (const p of d.players) {
        p.cash = 0;
        p.deposit = 0;
      }
    });
    expect(checkDayEnd(poor, em)).toBeNull();
    expect(ranking(s, em).map((r) => r.seat)).toEqual([0, 1, 2]);
  });

  it('破产之后：有真人座位而在场真人为 0 → noHumansLeft；只剩 1 人 → lastStanding；全电脑局不触发 noHumansLeft', () => {
    const humansOut = editState(base, (d) => {
      d.players[0]!.alive = false;
      d.players[1]!.alive = false;
    });
    expect(checkAfterBankruptcy(humansOut)).toEqual({ reason: 'noHumansLeft', winner: null });
    const last = editState(base, (d) => {
      d.players[1]!.alive = false;
      d.players[2]!.alive = false;
    });
    expect(checkAfterBankruptcy(last)).toEqual({ reason: 'lastStanding', winner: 0 });
    const allAi = editState(base, (d) => {
      for (const p of d.players) p.controller = 'ai';
      d.players[0]!.alive = false;
    });
    expect(checkAfterBankruptcy(allAi)).toBeNull();
  });
});
