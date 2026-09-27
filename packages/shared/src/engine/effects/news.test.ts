import { describe, expect, it } from 'vitest';
import { newsParam } from '../../data/tables/news';
import { type Scenario, scenario } from '../testing/scenario';
import type { NewsId, SeatIndex } from '../types/ids';
import type { GameState } from '../types/state';

/**
 * news：36 条新闻逐条（design/engine.md §10.6，按 docs/research/events-from-exe.md §1、§4 修正；数值取 data/tables/news.ts，
 * 该表与 exe 抽取结果的对照在 data/tables/events.test.ts）。fixture 'test'：1 银行 → 2 新闻 → 3 命运 … 整张图在视窗内。
 * 0 号从 1 号格掷 1 点停到 2 号新闻格；牌堆用 stackDeck 指定下一张；随机目标用 force('news', 下标)。
 * 地产顺序：L1 L2 L3（S01，地价 2000 房价 500）、L4 L5（S02，地价 1200）、F1（地价 4000）。
 */
function arena(o: { rules?: Record<string, unknown> } = {}): Scenario {
  const sc = scenario({ players: ['human', 'human', 'human'], rules: o.rules ?? {} }).untilMenu(0);
  return sc.teleport(1, 6, 5).teleport(2, 12, 11);
}

function land(s: GameState, id: string, owner: SeatIndex | null, level: number, chain = false): void {
  const l = s.lands.find((x) => x.id === id)!;
  l.owner = owner;
  l.level = level as 0;
  l.chain = chain;
}

/** 0 号停到新闻格，抽到 id */
function news(sc: Scenario, id: NewsId, ...forced: number[]): Scenario {
  sc.stackDeck('news', [id]).teleport(0, 1, 18);
  if (forced.length > 0) sc.force('news', ...forced);
  return sc.force('dice', 1).roll(0);
}

function jail(s: GameState, seat: SeatIndex, where: 'jail' | 'hospital', days: number): void {
  const p = s.players.find((x) => x.seat === seat)!;
  p.st[where] = days;
  p.node = where === 'jail' ? 14 : 15;
  p.prevNode = p.node;
}

/** 税款结算相关事件的顺序：MONEY:付款座位、BANKRUPT:座位、BECAME_BEGGAR:座位、GAME_OVER */
function settleOrder(sc: Scenario): string[] {
  const out: string[] = [];
  for (const e of sc.events) {
    if (e.type === 'MONEY' && e.from.t === 'seat') out.push(`MONEY:${e.from.seat}`);
    else if (e.type === 'BANKRUPT' || e.type === 'BECAME_BEGGAR') out.push(`${e.type}:${e.seat}`);
    else if (e.type === 'GAME_OVER') out.push('GAME_OVER');
  }
  return out;
}

describe('news（36 条新闻）', () => {
  it('news 0 / 2：在押 / 住院的玩家全部获释（计数改为待释放 0x80）', () => {
    // 关的是 2 号：0 号的回合结束后停在 1 号的回合菜单，2 号的计数还没倒数
    const sc = arena().edit((s) => jail(s, 2, 'jail', 3));
    news(sc, 0);
    expect(sc.event('NEWS')).toMatchObject({ id: 0, affected: [2] });
    expect(sc.player(2).st.jail).toBe(0x80);
    const h = arena().edit((s) => jail(s, 2, 'hospital', 5));
    news(h, 2);
    expect(h.player(2).st.hospital).toBe(0x80);
  });

  it('news 1 / 3：在押 / 住院者 (计数 + 3) & 0x7f；没人在押时不可行（跳到下一张）', () => {
    const sc = arena().edit((s) => jail(s, 2, 'jail', 4));
    news(sc, 1);
    expect(sc.event('NEWS')).toMatchObject({ id: 1, params: { days: newsParam(1, 'days') }, affected: [2] });
    expect(sc.player(2).st.jail).toBe(7);
    const h = arena().edit((s) => jail(s, 2, 'hospital', 0x80));
    news(h, 3);
    expect(h.player(2).st.hospital).toBe(3);
    // 没人住院：新闻 3 不可行，游标照样前进，抽到下一张
    const none = arena();
    news(none, 3);
    expect(none.event('NEWS').id).not.toBe(3);
  });

  it('news 1 / 3：PROGRAM 下投保者不理赔（exe 处理函数不调保险）；MANUAL（blessingOnNews）下按加的天数理赔', () => {
    // test-allkinds 才有保险公司 C3（行业 4）；格子编号与 test 相同
    const insured = (rules: Record<string, unknown>) =>
      scenario({ map: 'test-allkinds', players: ['human', 'human', 'human'], rules })
        .untilMenu(0)
        .teleport(1, 6, 5)
        .teleport(2, 12, 11)
        .edit((s) => {
          jail(s, 2, 'jail', 4);
          s.players[2]!.insuranceDays = 10;
        });
    const p = insured({});
    const cash = p.player(2).cash;
    news(p, 1);
    expect(p.player(2).st.jail).toBe(7);
    expect(p.events.some((e) => e.type === 'INSURANCE_PAYOUT')).toBe(false);
    expect(p.player(2).cash).toBe(cash);
    const m = insured({ blessingOnNews: true });
    const mc = m.player(2).cash;
    news(m, 1);
    expect(m.event('INSURANCE_PAYOUT')).toMatchObject({ seat: 2, days: 3, amount: 2000 * 3 });
    expect(m.player(2).cash).toBe(mc + 6000);
  });

  it('news 4 外星人：以随机一处有建筑的地产为中心、半宽 100：清为无主，窗内的人住院 3 天、毁车（不记敌意）', () => {
    const sc = arena().edit((s) => land(s, 'L1', 1, 2));
    news(sc, 4, 0);
    expect(sc.event('NEWS')).toMatchObject({ id: 4, params: { lot: 'L1' } });
    expect(sc.event('STRIKE')).toMatchObject({ kind: 'alien', half: newsParam(4, 'halfWidth') });
    expect(sc.state.lands[0]).toMatchObject({ owner: null, level: 0 });
    // 0 号（2 号格 (96,64)）与 1 号（6 号格 (224,64)）都在 L1 (192,32) 的半宽 100 窗内
    const confined = sc.events.filter((e) => e.type === 'CONFINED');
    expect(confined.map((e) => (e.actor.t === 'seat' ? e.actor.seat : -1))).toEqual([0, 1]);
    expect(confined.every((e) => e.days === newsParam(4, 'hospitalDays') && e.where === 'hospital')).toBe(true);
    expect(sc.player(2).st.hospital).toBe(0);
    expect(sc.player(1).hostility).toEqual([0, 0, 0, 0]);
  });

  it('news 5 怪兽 / 19 山洪：清为无主（建筑一并清掉）；15 瓦斯：随机一栋有建筑的住宅拆一级；21 龙卷风：拆一级', () => {
    const a = arena().edit((s) => land(s, 'L2', 1, 3));
    news(a, 5, 0);
    expect(a.state.lands[1]).toMatchObject({ owner: null, level: 0 });
    const b = arena().edit((s) => land(s, 'L2', 1, 3));
    news(b, 19, 1);
    expect(b.state.lands[1]).toMatchObject({ owner: null, level: 0 });
    const c = arena().edit((s) => land(s, 'L4', 2, 3));
    news(c, 15, 0);
    expect(c.state.lands[3]).toMatchObject({ owner: 2, level: 2 });
    const d = arena().edit((s) => land(s, 'L5', 2, 1, true));
    news(d, 21, 4);
    expect(d.state.lands[4]).toMatchObject({ owner: 2, level: 0, chain: false });
  });

  it('news 6 / 14：住宅同名路段每块地价 × 1.3 / × 0.7（trunc）；设施只改这一处', () => {
    const up = arena();
    news(up, 6, 0);
    expect(up.state.lands.slice(0, 3).map((l) => l.landPrice)).toEqual([2600, 2600, 2600]);
    expect(up.state.lands[3]!.landPrice).toBe(1200);
    expect(up.event('NEWS')).toMatchObject({ params: { lot: 'L1' } });
    const down = arena();
    news(down, 14, 3);
    expect(down.state.lands.slice(3).map((l) => l.landPrice)).toEqual([840, 840]);
    const fac = arena();
    news(fac, 6, 5);
    expect(fac.state.facilities[0]!.landPrice).toBe(5200);
  });

  it('news 7：随机一处无主地产公开拍卖（无卖方，成交款进公库；所有在场、未受困者都能出价）', () => {
    const sc = arena();
    news(sc, 7, 0);
    expect(sc.event('AUCTION_STARTED')).toMatchObject({ lot: 'L1', seller: null, source: 'news', bidders: [0, 1, 2] });
    const pool = sc.state.econ.pool;
    // 起拍价 = trunc(2000 × (1 + 0 × 0.5)) × 1 = 2000；1 号按起拍价出价
    sc.act(1, { type: 'BID', inc: 0 });
    sc.act(0, { type: 'PASS' }).act(2, { type: 'PASS' });
    expect(sc.event('AUCTION_ENDED')).toMatchObject({ lot: 'L1', winner: 1, price: 2000 });
    expect(sc.state.lands[0]!.owner).toBe(1);
    expect(sc.state.econ.pool).toBe(pool + 2000);
  });

  it('news 8 / 9 / 10：地产最多（并列取座位最小）、地产最少（含 0 块）、持股最多者得奖金 × PI', () => {
    const a = arena().edit((s) => {
      land(s, 'L4', 2, 0);
      land(s, 'L5', 2, 0);
      land(s, 'L1', 1, 0);
    });
    const c2 = a.player(2).cash;
    news(a, 8);
    expect(a.event('NEWS')).toMatchObject({ id: 8, params: { seat: 2, amount: 10000 }, affected: [2] });
    expect(a.player(2).cash).toBe(c2 + newsParam(8, 'reward'));
    const b = arena().edit((s) => land(s, 'L1', 1, 0));
    const c0 = b.player(0).cash;
    news(b, 9);
    expect(b.event('NEWS')).toMatchObject({ params: { seat: 0, amount: 5000 } });
    expect(b.player(0).cash).toBe(c0 + newsParam(9, 'subsidy'));
    const c = arena().edit((s) => {
      s.players[1]!.holdings[0] = { shares: 500, costCents: 0 };
      s.stocks[0]!.float -= 500;
      s.stocks[0]!.chairman = 1;
    });
    news(c, 10);
    expect(c.event('NEWS')).toMatchObject({ params: { seat: 1, amount: 10000 } });
  });

  it('news 11 / 12 / 13：所得税 trunc(现金 × 0.05)、地价税（含设施）、证交税 → 公库', () => {
    const a = arena().setCash(0, 10019, 0);
    const pool = a.state.econ.pool;
    news(a, 11);
    expect(a.player(0).cash).toBe(10019 - 500);
    expect(a.state.econ.pool).toBe(pool + 500 + 2 * 5000);
    const b = arena().edit((s) => {
      land(s, 'L1', 1, 2);
      Object.assign(s.facilities[0]!, { owner: 1, level: 1, type: 'hotel' });
    });
    const c1 = b.player(1).cash;
    news(b, 12);
    // (2000 + 2 × 500) + (4000 + 1 × 800) = 7800 → × 0.05 = 390
    expect(b.player(1).cash).toBe(c1 - 390);
    expect(b.event('NEWS')).toMatchObject({ affected: [1] });
    const c = arena().edit((s) => {
      s.players[1]!.holdings[0] = { shares: 1000, costCents: 0 };
      s.stocks[0]!.float -= 1000;
      s.stocks[0]!.chairman = 1;
    });
    const c1b = c.player(1).cash;
    news(c, 13);
    // 1000 股 × 80 元 = 80000 → × 0.05 = 4000
    expect(c.player(1).cash).toBe(c1b - 4000);
  });

  it('news 12 税款逐人结算：先付不起的先破产，BANKRUPT 帧跑完才收下一人（剩 2 人时判后面那人赢）', () => {
    // 两人都付不起地价税 trunc(60000 × 0.05) = 3000：0 号先破产、当场终局，1 号不再被收税
    const two = (players: ('human' | 'ai')[]) =>
      scenario({ players })
        .untilMenu(0)
        .teleport(1, 6, 5)
        .edit((s) => {
          Object.assign(s.lands[0]!, { owner: 0, level: 0, landPrice: 60000 });
          Object.assign(s.lands[3]!, { owner: 1, level: 0, landPrice: 60000 });
        })
        .setCash(0, 100, 0)
        .setCash(1, 100, 0);
    const sc = news(two(['human', 'human']), 12);
    expect(sc.event('NEWS')).toMatchObject({ id: 12, affected: [0, 1] });
    expect(settleOrder(sc)).toEqual(['MONEY:0', 'BANKRUPT:0', 'GAME_OVER']);
    expect(sc.state.result).toMatchObject({ reason: 'lastStanding', winner: 1 });
    expect(sc.player(1)).toMatchObject({ alive: true, cash: 100 });
    // 1 真人（0 号）对 1 电脑：真人先破产 → noHumansLeft（此前误判真人为赢家）
    const solo = news(two(['human', 'ai']), 12);
    expect(solo.state.result).toMatchObject({ reason: 'noHumansLeft', winner: null });

    // 3 人：0、1 号都付不起，按座位顺序淘汰；1 号的税在 0 号的破产清算结束之后才收
    const three = arena()
      .edit((s) => {
        Object.assign(s.lands[0]!, { owner: 0, level: 0, landPrice: 60000 });
        Object.assign(s.lands[3]!, { owner: 1, level: 0, landPrice: 60000 });
        Object.assign(s.lands[1]!, { owner: 2, level: 0 });
      })
      .setCash(0, 100, 0)
      .setCash(1, 100, 0);
    news(three, 12);
    // 2 号在 1 号破产后已是最后一人：不再收税
    expect(settleOrder(three)).toEqual([
      'MONEY:0',
      'BANKRUPT:0',
      'BECAME_BEGGAR:0',
      'MONEY:1',
      'BANKRUPT:1',
      'GAME_OVER',
    ]);
    expect(three.state.result).toMatchObject({ reason: 'lastStanding', winner: 2 });
  });

  it('news 16 / 17：步行者 / 乘车者停留 1 次', () => {
    const a = arena();
    news(a, 16);
    expect(a.event('NEWS')).toMatchObject({ affected: [0, 1, 2] });
    // 1 号的回合已经开始（停留计数两段式倒数到 0x80、本回合停住）
    expect(a.state.players.map((p) => p.st.stay)).toEqual([1, 0x80, 1]);
    const b = arena().edit((s) => {
      s.players[1]!.vehicle = 'moto';
      s.pools.items[5] = s.pools.items[5]! - 1;
    });
    news(b, 17);
    expect(b.state.players.map((p) => p.st.stay)).toEqual([0, 0x80, 0]);
    expect(b.event('NEWS')).toMatchObject({ affected: [1] });
  });

  it('news 18 地震：住宅同名路段每块拆一级（连锁店清为空地）；20 台风：以地产为中心半宽 100 拆一级、不伤人', () => {
    const a = arena().edit((s) => {
      land(s, 'L1', 1, 2);
      land(s, 'L2', 2, 1, true);
    });
    news(a, 18, 0);
    expect(a.state.lands.slice(0, 3).map((l) => [l.level, l.chain])).toEqual([
      [1, false],
      [0, false],
      [0, false],
    ]);
    const b = arena().edit((s) => land(s, 'L1', 1, 2));
    news(b, 20, 5);
    expect(b.event('STRIKE')).toMatchObject({ kind: 'typhoon', lots: ['L1'] });
    expect(b.state.lands[0]!.level).toBe(1);
    expect(b.state.players.every((p) => p.st.hospital === 0)).toBe(true);
  });

  it('news 22 挤兑 15 天；23 无贷款者得 trunc(存款 × 0.1) 进存款；26 全面停市 10 天（当天即停）', () => {
    const a = arena();
    news(a, 22);
    expect(a.state.econ.bankRunDays).toBe(newsParam(22, 'days'));
    const b = arena().edit((s) => {
      s.players[1]!.loan = 1000;
      s.players[1]!.loanDue = 20051231;
    });
    const d0 = b.player(0).deposit;
    const d1 = b.player(1).deposit;
    news(b, 23);
    expect(b.player(0).deposit).toBe(d0 + Math.trunc(d0 / 10));
    expect(b.player(1).deposit).toBe(d1);
    expect(b.event('NEWS')).toMatchObject({ affected: [0, 2] });
    const c = arena();
    news(c, 26);
    expect(c.state.econ.marketClosedDays).toBe(10);
    expect(c.state.clock.marketOpen).toBe(false);
  });

  it('news 24 / 25：12 支股票全部跌停 / 涨停 1 天，立即按开盘价重算', () => {
    const a = arena();
    news(a, 24);
    expect(a.state.stocks.every((st) => st.down === 1 && st.up === 0)).toBe(true);
    expect(a.state.stocks[0]!.priceCents).toBe(7200);
    const b = arena();
    news(b, 25);
    expect(b.state.stocks.every((st) => st.up === 1 && st.down === 0)).toBe(true);
    expect(b.state.stocks[0]!.priceCents).toBe(8800);
  });

  it('news 27 停牌（rules.stockSuspendDays，PROGRAM 15 天）；28 随机一支停牌股复牌', () => {
    const a = arena();
    news(a, 27, 3);
    expect(a.event('SUSPENDED')).toMatchObject({ stock: 3, days: 15 });
    expect(a.state.stocks[3]!.suspend).toBe(15);
    const m = arena({ rules: { stockSuspendDays: 10 } });
    news(m, 27, 0);
    expect(m.state.stocks[0]!.suspend).toBe(10);
    const b = arena().edit((s) => {
      s.stocks[2]!.suspend = 5;
    });
    news(b, 28, 0);
    expect(b.event('RESUMED')).toMatchObject({ stock: 2 });
    expect(b.state.stocks[2]!.suspend).toBe(0);
  });

  it('news 29：随机一家有董事长的公司，董事长走免罪 → 嫁祸 → 坐牢 5 天（没有加持）', () => {
    const chair = (s: GameState) => {
      s.players[1]!.holdings[0] = { shares: 500, costCents: 0 };
      s.stocks[0]!.float -= 500;
      s.stocks[0]!.chairman = 1;
    };
    const a = arena().edit(chair);
    news(a, 29, 0);
    expect(a.event('NEWS')).toMatchObject({ params: { company: 'C1', seat: 1, days: 5 }, affected: [1] });
    expect(a.event('CONFINED')).toMatchObject({ actor: { t: 'seat', seat: 1 }, where: 'jail', days: 5 });
    expect(a.events.some((e) => e.type === 'BLESSING')).toBe(false);
    // 免罪卡自动生效
    const b = arena()
      .edit(chair)
      .give(1, { cards: [21] });
    news(b, 29, 0);
    expect(b.player(1).st.jail).toBe(0);
    expect(b.player(1).cards).toEqual([]);
    // 嫁祸卡：问 1 号，嫁给 2 号
    const c = arena()
      .edit(chair)
      .give(1, { cards: [19] });
    news(c, 29, 0);
    c.expectAsk(1, 'SCAPEGOAT').act(1, { type: 'SCAPEGOAT', target: 2 });
    expect(c.event('CONFINED')).toMatchObject({ actor: { t: 'seat', seat: 2 }, days: 5 });
    expect(c.player(1).st.jail).toBe(0);
    // 没有在场、未受困的董事长：不可行
    const d = arena();
    news(d, 29);
    expect(d.event('NEWS').id).not.toBe(29);
  });

  it('news 30–34：随机一家公司罚款 / 海外投资（不乘 PI，本月与累计盈余同减或同增），跌 3 / 涨 3 / 跌 4 天', () => {
    const a = arena();
    news(a, 30, 0);
    expect(a.state.companies[0]).toMatchObject({ surplusMonth: -10000, surplusTotal: -10000 });
    expect(a.state.stocks[0]).toMatchObject({ down: 3, up: 0, priceCents: 7200 });
    expect(a.event('NEWS')).toMatchObject({ params: { company: 'C1', fine: 10000 } });
    const b = arena();
    news(b, 31, 1);
    expect(b.state.companies[1]).toMatchObject({ surplusMonth: 20000, surplusTotal: 20000 });
    expect(b.state.stocks[2]).toMatchObject({ up: 3, down: 0 });
    const c = arena();
    news(c, 32, 1);
    expect(c.state.companies[1]).toMatchObject({ surplusMonth: -20000 });
    expect(c.state.stocks[2]!.down).toBe(4);
    const d = arena();
    news(d, 33, 0);
    expect(d.state.companies[0]!.surplusMonth).toBe(-10000);
    const e = arena();
    news(e, 34, 0);
    expect(e.state.companies[0]!.surplusMonth).toBe(-5000);
  });

  it('news 35：本月盈余 > 10000 的公司盈余 × 2、累计盈余 + 2 × 原盈余，涨 trunc(原盈余 / 10000) & 0xF 天', () => {
    const sc = arena().edit((s) => {
      s.companies[1]!.surplusMonth = 34000;
      s.companies[1]!.surplusTotal = 34000;
      s.econ.ledger.minted += 34000;
    });
    news(sc, 35, 0);
    expect(sc.state.companies[1]).toMatchObject({ surplusMonth: 68000, surplusTotal: 102000 });
    expect(sc.state.stocks[2]!.up).toBe(3);
    // 没有盈余 > 10000 的公司：不可行
    const none = arena();
    news(none, 35);
    expect(none.event('NEWS').id).not.toBe(35);
  });

  it('news：PROGRAM 下不做加持判定；MANUAL（blessingOnNews）时奖金类按财运判定', () => {
    const lucky = (s: GameState) => {
      s.players[0]!.luck.wealth = 150;
      land(s, 'L1', 1, 0);
    };
    const p = arena().edit(lucky);
    const c0 = p.player(0).cash;
    news(p, 9);
    expect(p.player(0).cash).toBe(c0 + 5000);
    expect(p.events.some((e) => e.type === 'BLESSING')).toBe(false);
    const m = arena({ rules: { blessingOnNews: true } }).edit(lucky);
    const m0 = m.player(0).cash;
    news(m, 9);
    expect(m.event('BLESSING')).toMatchObject({ seat: 0, category: 'reward', result: 'high' });
    expect(m.player(0).cash).toBe(m0 + 10000);
    // 劫难类（news 1 延长刑期）：low 天数 ×2，high 逃过
    const unlucky = arena({ rules: { blessingOnNews: true } }).edit((s) => {
      jail(s, 2, 'jail', 4);
      s.players[2]!.luck.fortune = -10;
    });
    news(unlucky, 1);
    expect(unlucky.event('BLESSING')).toMatchObject({ seat: 2, category: 'misfortune', result: 'low' });
    expect(unlucky.player(2).st.jail).toBe(4 + 2 * newsParam(1, 'days'));
    const escaped = arena({ rules: { blessingOnNews: true } }).edit((s) => {
      jail(s, 2, 'jail', 4);
      s.players[2]!.luck.fortune = 150;
    });
    news(escaped, 1);
    expect(escaped.event('NEWS')).toMatchObject({ id: 1, affected: [] });
    expect(escaped.player(2).st.jail).toBe(4);
  });

  it('news：抽牌游标照样前进；不可行的跳过（最多 36 次）', () => {
    const sc = arena();
    const cursor = sc.state.secret.newsCursor;
    news(sc, 0);
    // 没人在押：0 不可行，跳到下一张（游标至少前进 2）
    expect(sc.event('NEWS').id).not.toBe(0);
    expect((sc.state.secret.newsCursor - cursor + 36) % 36).toBeGreaterThanOrEqual(2);
  });
});
