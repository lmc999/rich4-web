import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../../data/maps/registry';
import { engineMap } from '../core/mapCache';
import { buildTurnMenu } from '../decisions/build';
import { dividendShare } from '../flow/day';
import { chairmanFor, isLimitDown, isLimitUp, limitDownPrice, limitUpPrice, movePrice, tickSize } from '../rules/stock';
import { scenario } from '../testing/scenario';
import type { StockRow } from '../types/decision';
import type { PlayerState } from '../types/state';

const em = engineMap(fixtureRegistry.getMap('test'));

/** 调整公司本月盈余并同步台账（公开资金 = Σ现金存款 + 公库 + Σ本月盈余） */
function setSurplus(
  s: { companies: { surplusMonth: number }[]; econ: { ledger: { minted: number; burned: number } } },
  i: number,
  v: number,
) {
  const d = v - s.companies[i]!.surplusMonth;
  s.companies[i]!.surplusMonth = v;
  if (d > 0) s.econ.ledger.minted += d;
  else s.econ.ledger.burned += -d;
}

function give(p: PlayerState, idx: number, shares: number, priceCents: number): void {
  p.holdings[idx] = { shares, costCents: shares * priceCents };
}

describe('stock：价格档位与涨跌停（rules/stock）', () => {
  it('档位按新价格判断，差额朝零截断，夹到 1..9999 元', () => {
    expect([499, 500, 1499, 1500, 4999, 5000, 14999, 15000].map(tickSize)).toEqual([1, 5, 5, 10, 10, 50, 50, 100]);
    expect(movePrice(1000, 10)).toBe(1100);
    expect(movePrice(10050, 10)).toBe(11050);
    expect(movePrice(10050, -10)).toBe(9050);
    expect(movePrice(120, -50)).toBe(100);
    expect(movePrice(999000, 10)).toBe(999900);
    expect(movePrice(8000, 3.7)).toBe(8250);
  });

  it('涨停价 / 跌停价与判定：价格不变不算', () => {
    expect(limitUpPrice(8000)).toBe(8800);
    expect(limitDownPrice(8000)).toBe(7200);
    expect(isLimitUp({ priceCents: 8800, prevCents: 8000 })).toBe(true);
    expect(isLimitUp({ priceCents: 8790, prevCents: 8000 })).toBe(false);
    expect(isLimitDown({ priceCents: 7200, prevCents: 8000 })).toBe(true);
    expect(isLimitUp({ priceCents: 100, prevCents: 100 })).toBe(false);
  });

  it('董事长：严格最多；平手保留现任；没有现任取座位靠前；没人持股为 null', () => {
    const P = (seat: 0 | 1 | 2 | 3, n: number) =>
      ({ seat, alive: true, holdings: [{ shares: n, costCents: 0 }] }) as unknown as PlayerState;
    expect(chairmanFor([P(0, 10), P(1, 20)], 0, null)).toBe(1);
    expect(chairmanFor([P(0, 20), P(1, 20)], 0, 1)).toBe(1);
    expect(chairmanFor([P(0, 20), P(1, 20)], 0, null)).toBe(0);
    expect(chairmanFor([P(0, 0), P(1, 0)], 0, 1)).toBeNull();
  });
});

describe('stock：交易（回合菜单）', () => {
  it('stock.buy-sell：买入扣存款、减流通与可买量、成为董事长；卖出进存款、平均成本不变', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    const row0 = (sc.pending(0).options as { stock: { rows: StockRow[]; open: boolean } }).stock;
    expect(row0.open).toBe(true);
    const r = row0.rows[0]!;
    expect(r).toMatchObject({ idx: 0, priceCents: 8000, limitUp: false, limitDown: false, maxSell: 0 });
    expect(r.maxBuy).toBe(Math.min(r.quota, 10000, Math.trunc((100000 * 100) / 8000)));
    const quota = sc.player(0).quota[0]!;
    sc.act(0, { type: 'STOCK_BUY', stock: 0, shares: 100 });
    expect(sc.event('STOCK_TRADED')).toMatchObject({ seat: 0, stock: 0, side: 'buy', shares: 100, amount: 8000 });
    expect(sc.event('CHAIRMAN_CHANGED')).toMatchObject({ stock: 0, from: null, to: 0 });
    expect(sc.player(0)).toMatchObject({
      deposit: 92000,
      holdings: expect.arrayContaining([{ shares: 100, costCents: 800000 }]),
    });
    expect(sc.player(0).quota[0]).toBe(quota - 100);
    expect(sc.state.stocks[0]).toMatchObject({ float: 9900, chairman: 0 });
    expect(sc.player(0).turn.log).toEqual(['stockBuy']);
    sc.expectAsk(0, 'TURN_MENU');
    expect((sc.pending(0).options as { turnLog: string[] }).turnLog).toEqual(['stockBuy']);

    sc.act(0, { type: 'STOCK_SELL', stock: 0, shares: 40 });
    expect(sc.event('STOCK_TRADED')).toMatchObject({ side: 'sell', shares: 40, amount: 3200 });
    expect(sc.player(0).holdings[0]).toEqual({ shares: 60, costCents: 480000 });
    expect(sc.player(0).deposit).toBe(95200);
    expect(() => sc.act(0, { type: 'STOCK_SELL', stock: 0, shares: 61 })).toThrow(/OUT_OF_RANGE/);
    expect(() => sc.act(0, { type: 'STOCK_BUY', stock: 0, shares: 1_000_000 })).toThrow(/OUT_OF_RANGE/);
  });

  it('stock.limit-up-cannot-buy：涨停不能买（跌停不能卖）；休市与停牌不能交易', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.edit((s) => {
      s.stocks[0]!.priceCents = limitUpPrice(s.stocks[0]!.prevCents);
      s.stocks[1]!.priceCents = limitDownPrice(s.stocks[1]!.prevCents);
      give(s.players[0]!, 1, 50, 5000);
      s.stocks[1]!.float -= 50;
      s.stocks[1]!.chairman = 0;
    });
    const rows = buildTurnMenu(sc.state, em, 0).stock.rows;
    expect(rows[0]).toMatchObject({ limitUp: true, maxBuy: 0 });
    expect(rows[1]).toMatchObject({ limitDown: true, maxSell: 0 });
    expect(() => sc.act(0, { type: 'STOCK_BUY', stock: 0, shares: 1 })).toThrow(/NOT_USABLE/);
    expect(() => sc.act(0, { type: 'STOCK_SELL', stock: 1, shares: 1 })).toThrow(/NOT_USABLE/);
    sc.act(0, { type: 'STOCK_BUY', stock: 1, shares: 1 });

    sc.edit((s) => {
      s.stocks[2]!.suspend = 3;
    });
    expect(() => sc.act(0, { type: 'STOCK_BUY', stock: 2, shares: 1 })).toThrow(/NOT_USABLE/);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050508 } });
    expect(buildTurnMenu(sc.state, em, 0).stock).toMatchObject({ open: false, reason: 'sunday' });
    expect(() => sc.act(0, { type: 'STOCK_BUY', stock: 3, shares: 1 })).toThrow(/NOT_USABLE/);
  });
});

describe('stock：行情与倒数（DAY market 阶段）', () => {
  it('开市日跑行情：G 与个股冲击取中点时价格不变；利多中的股票 +10%；停牌不动', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(1);
    sc.edit((s) => {
      s.stocks[3]!.up = 2;
      s.stocks[4]!.suspend = 3;
    });
    // 11 次 market：G 一次 + 12 支里需要个股冲击的 10 支（stock 3 利多、stock 4 停牌不取）
    sc.force('market', ...new Array<number>(11).fill(16384));
    const before = sc.state.stocks.map((s) => s.priceCents);
    sc.until((s) => s.clock.date === 20050506 && s.pending[0]?.seat === 0);
    expect(sc.log.some((e) => e.type === 'MARKET_TICK')).toBe(true);
    const after = sc.state.stocks;
    expect(after[0]!.priceCents).toBe(before[0]);
    expect(after[3]).toMatchObject({ up: 1, priceCents: limitUpPrice(before[3]!), prevCents: before[3], momentum: 10 });
    expect(after[4]).toMatchObject({ suspend: 2, priceCents: before[4], momentum: 0 });
    expect(after[3]!.history).toEqual([before[3], limitUpPrice(before[3]!)]);
  });

  it('星期日休市（MARKET_CLOSED），倒数照扣；全面停市从 1 到 0 的那天仍休市', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(1);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050507 } }).edit((s) => {
      s.stocks[0]!.down = 1;
      s.stocks[1]!.suspend = 1;
    });
    const price = sc.state.stocks[0]!.priceCents;
    sc.until((s) => s.clock.date === 20050508);
    expect(sc.log.filter((e) => e.type === 'MARKET_CLOSED').at(-1)).toMatchObject({ reason: 'sunday' });
    expect(sc.log.some((e) => e.type === 'RESUMED' && e.stock === 1)).toBe(true);
    expect(sc.state.stocks[0]).toMatchObject({ down: 0, priceCents: price });
    expect(sc.state.clock.marketOpen).toBe(false);

    const h = scenario({ players: ['human', 'human'] }).untilMenu(1);
    h.edit((s) => {
      s.econ.marketClosedDays = 1;
    });
    h.until((s) => s.clock.date === 20050506 && s.pending[0]?.seat === 0);
    expect(h.state.econ.marketClosedDays).toBe(0);
    expect(h.state.clock.marketOpen).toBe(false);
    expect(h.log.filter((e) => e.type === 'MARKET_CLOSED').at(-1)).toMatchObject({ reason: 'halted' });
    expect(buildTurnMenu(h.state, em, 0).stock).toMatchObject({ open: false, reason: 'halted' });
  });
});

describe('dividend（15 日分红）', () => {
  it('dividend.positive：按持股比例进存款，本月盈余清零；没人持股的公司保留盈余', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(1);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050514 } }).edit((s) => {
      give(s.players[0]!, 0, 300, 8000);
      give(s.players[1]!, 0, 100, 8000);
      s.stocks[0]!.float -= 400;
      s.stocks[0]!.chairman = 0;
      setSurplus(s, 0, 40001);
      setSurplus(s, 1, 5000);
    });
    const d0 = sc.player(0).deposit;
    const d1 = sc.player(1).deposit;
    sc.until((s) => s.clock.date === 20050515 && s.pending[0]?.seat === 0);
    const ev = sc.log.find((e) => e.type === 'DIVIDENDS');
    expect(ev).toMatchObject({
      rows: [
        { company: 'C1', seat: 0, amount: 30000 },
        { company: 'C1', seat: 1, amount: 10000 },
      ],
    });
    expect(sc.player(0).deposit).toBe(d0 + 30000);
    expect(sc.player(1).deposit).toBe(d1 + 10000);
    expect(sc.state.companies[0]!.surplusMonth).toBe(0);
    expect(sc.state.companies[1]!.surplusMonth).toBe(5000);
  });

  it('dividend.negative-bankrupt：负盈余按比例反扣（先存款后现金），扣不出来就破产', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(2);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050514 } }).edit((s) => {
      give(s.players[0]!, 0, 200, 8000);
      give(s.players[1]!, 0, 200, 8000);
      s.stocks[0]!.float -= 400;
      s.stocks[0]!.chairman = 0;
      setSurplus(s, 0, -100000);
      s.players[0]!.cash = 10000;
      s.players[0]!.deposit = 20000;
      s.econ.ledger.burned += 170000;
    });
    sc.until((s) => s.clock.date === 20050515 && s.pending[0]?.seat === 1);
    expect(sc.log.find((e) => e.type === 'DIVIDENDS')).toMatchObject({
      rows: [
        { seat: 0, amount: -50000 },
        { seat: 1, amount: -50000 },
      ],
    });
    expect(sc.log.find((e) => e.type === 'BANKRUPT')).toMatchObject({ seat: 0, cause: { k: 'dividend', ref: 'C1' } });
    expect(sc.player(0).alive).toBe(false);
    expect(sc.player(1)).toMatchObject({ alive: true, deposit: 50000, cash: 100000 });
    expect(sc.state.companies[0]!.surplusMonth).toBe(0);
    // 破产者的股票退回市场，董事长重排
    expect(sc.state.stocks[0]).toMatchObject({ chairman: 1, float: 9800 });
  });
});

describe('dividend：按座位净额结算（exe 0x42ba97）', () => {
  it('dividend.net：各公司应分先按座位合计再一次入账——C1 −20000、C2 +50000 净得 +30000，不破产', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(2);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050514 } }).edit((s) => {
      const p = s.players[0]!;
      for (const c of s.companies) {
        give(p, c.stock, 100, 8000);
        s.stocks[c.stock]!.float -= 100;
        s.stocks[c.stock]!.chairman = 0;
      }
      setSurplus(s, 0, -20000);
      setSurplus(s, 1, 50000);
      // 现金 + 存款不够付 C1 的 20000（逐公司结算会在 C1 这一步破产）
      s.econ.ledger.burned += p.cash + p.deposit - 1000;
      p.cash = 1000;
      p.deposit = 0;
    });
    sc.until((s) => s.clock.date === 20050515 && s.pending[0]?.seat === 0);
    const divs = sc.log.filter((e) => e.type === 'DIVIDENDS');
    expect(divs).toHaveLength(1);
    expect(divs[0]).toMatchObject({
      rows: [
        { company: 'C1', seat: 0, amount: -20000 },
        { company: 'C2', seat: 0, amount: 50000 },
      ],
    });
    expect(sc.log.some((e) => e.type === 'BANKRUPT')).toBe(false);
    expect(sc.player(0)).toMatchObject({ alive: true, cash: 1000, deposit: 30000 });
    expect(sc.state.companies.map((c) => c.surplusMonth)).toEqual([0, 0]);
  });

  it('dividend.net-bankrupt：合计为负且扣不出来才破产；原因记第一家亏损公司，破产按座位顺序展开', () => {
    const sc = scenario({ players: ['human', 'human', 'human', 'human'] }).untilMenu(3);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050514 } }).edit((s) => {
      for (const seat of [0, 1] as const) {
        const p = s.players[seat]!;
        give(p, 2, 100, 8000);
        s.econ.ledger.burned += p.cash + p.deposit;
        p.cash = 0;
        p.deposit = 0;
      }
      s.stocks[2]!.float -= 200;
      s.stocks[2]!.chairman = 0;
      setSurplus(s, 1, -30000);
    });
    sc.until((s) => !s.players[0]!.alive && !s.players[1]!.alive);
    expect(sc.log.find((e) => e.type === 'DIVIDENDS')).toMatchObject({
      rows: [
        { company: 'C2', seat: 0, amount: -15000 },
        { company: 'C2', seat: 1, amount: -15000 },
      ],
    });
    const bankrupt = sc.log.filter((e) => e.type === 'BANKRUPT');
    expect(bankrupt.map((e) => (e as { seat: number }).seat)).toEqual([0, 1]);
    expect(bankrupt[0]).toMatchObject({ cause: { k: 'dividend', ref: 'C2' } });
  });

  it('dividendShare：持股比例先存成 float32 再乘盈余并截断（原版常比精确值少 1）', () => {
    expect(dividendShare(10000, 700, 1000)).toBe(6999);
    expect(dividendShare(10000, 300, 1000)).toBe(3000);
    expect(dividendShare(-10000, 700, 1000)).toBe(-6999);
    expect(dividendShare(40001, 300, 400)).toBe(30000);
    expect(dividendShare(123456, 1000, 1000)).toBe(123456);
    expect(dividendShare(-2147483647, 1, 3)).toBe(Math.trunc(-2147483647 * Math.fround(1 / 3)));
  });
});

describe('subscribe（企业格现场认购）', () => {
  it('停在无董事长的 ★ 公司：用现金按 trunc(资产额/10000) 认购保留股，钱销毁、不计入盈余，成为董事长', () => {
    const sc = scenario({ map: 'test-allkinds', players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 23, 22).force('dice', 1).roll(0).expectAsk(0, 'SUBSCRIBE_SHARES');
    expect(sc.pending(0).options).toMatchObject({ company: 'C3', stock: 1, unitPrice: 50, max: 1000, reserved: 4000 });
    expect(() => sc.act(0, { type: 'SUBSCRIBE', shares: 1001 })).toThrow(/OUT_OF_RANGE/);
    const burned = sc.state.econ.ledger.burned;
    sc.act(0, { type: 'SUBSCRIBE', shares: 1000 });
    expect(sc.event('SUBSCRIBED')).toMatchObject({ seat: 0, stock: 1, shares: 1000, unit: 50 });
    expect(sc.player(0)).toMatchObject({ cash: 50000 });
    expect(sc.player(0).holdings[1]).toEqual({ shares: 1000, costCents: 5000000 });
    expect(sc.state.companies[2]).toMatchObject({ reserved: 3000, surplusMonth: 0 });
    expect(sc.state.stocks[1]!.chairman).toBe(0);
    expect(sc.state.econ.ledger.burned).toBe(burned + 50000);
  });
});
