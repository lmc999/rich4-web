import { describe, expect, it } from 'vitest';
import { buildFixtureMaps } from '../../data/maps/fixtures/testMap';
import { createRegistry, type DataRegistry } from '../../data/maps/registry';
import type { IndustryKey } from '../../data/maps/types';
import { CARD } from '../../data/tables/ids';
import { TABLES } from '../../data/tables/index';
import { nextDate } from '../rules/calendar';
import { scenario } from '../testing/scenario';
import type { GameState } from '../types/state';

/**
 * 设施（大块地）与企业格（design/engine.md §8；docs/research/g_map.md §4.2–§4.3）。
 * fixture 'test' / 'test-allkinds'：16 → 17、18（设施 F1：地价 4000，rateWindow [800,600,1500,3500,7000,13000]）→ 1；
 * 'test-allkinds'：22 → 23 → 24、25（企业 C3：保险，收费基数 600，资产额 500000，股票 1，流通 6000）。
 */
function registryWithC3(industry: number, industryKey: IndustryKey): DataRegistry {
  const maps = buildFixtureMaps();
  const c3 = maps.find((m) => m.id === 'test-allkinds')!.companies.find((c) => c.id === 'C3')!;
  c3.industry = industry;
  c3.industryKey = industryKey;
  return createRegistry(maps, { tables: TABLES, verifyHash: false });
}

/** 1 号成为 C3（股票 1）的董事长 */
function chairmanC3(s: GameState, seat: 0 | 1 = 1): void {
  s.players[seat]!.holdings[1] = { shares: 100, costCents: 500000 };
  s.stocks[1]!.float -= 100;
  s.stocks[1]!.chairman = seat;
}

function companyScenario(industry: number, key: IndustryKey, o: { vehicle?: 'walk' | 'car' } = {}) {
  return scenario({
    map: 'test-allkinds',
    registry: registryWithC3(industry, key),
    players: ['human', 'human'],
    config: { vehicle: o.vehicle ?? 'walk' },
  })
    .untilMenu(0)
    .edit((s) => chairmanC3(s));
}

/** 0 号从 23 走 1 步停在 C3 */
function landOnC3(sc: ReturnType<typeof companyScenario>, dice?: 1 | 2 | 3) {
  return sc.teleport(0, 23, 22).force('dice', 1).roll(0, dice);
}

describe('company：企业格收费（各行业）', () => {
  it('company.airline：转盘 n × 收费基数 × PI，并消失 n 天；n = 0「不用出國」不收费', () => {
    const sc = companyScenario(1, 'airline');
    sc.force('wheel', 6);
    landOnC3(sc);
    expect(sc.event('COMPANY_FEE')).toMatchObject({ seat: 0, company: 'C3', industry: 1, amount: 1200, wheel: 2 });
    expect(sc.event('CONFINED')).toMatchObject({ where: 'away', days: 2, cause: { k: 'airline', ref: 'C3' } });
    expect(sc.player(0)).toMatchObject({ cash: 98800, st: expect.objectContaining({ away: 2 }) });
    expect(sc.state.companies[2]).toMatchObject({ surplusMonth: 1200, surplusTotal: 1200 });
    sc.expectNoAsk(0, 'SUBSCRIBE_SHARES');
    // 出国期间：2 个受阻回合 + 1 个走回的回合
    sc.until((s) => s.players[0]!.st.away === 0 && s.pending[0]?.seat === 0 && s.pending[0]?.kind === 'TURN_MENU');
    expect(sc.log.filter((e) => e.type === 'TURN_BLOCKED' && e.seat === 0 && e.reason === 'away')).toHaveLength(2);

    const zero = companyScenario(1, 'airline');
    zero.force('wheel', 0);
    landOnC3(zero);
    expect(zero.event('COMPANY_FEE')).toMatchObject({ amount: 0, wheel: 0 });
    expect(zero.player(0).st.away).toBe(0);
    zero.expectAsk(0, 'SUBSCRIBE_SHARES');
  });

  it('company.electronics：收费基数 × 已过天数，不乘 PI', () => {
    const sc = companyScenario(3, 'electronics').edit((s) => {
      s.clock.elapsedDays = 10;
      s.econ.priceIndex = 3;
    });
    landOnC3(sc);
    expect(sc.event('COMPANY_FEE')).toMatchObject({ industry: 3, amount: 6000, wheel: null });
  });

  it('company.insurance：转盘 d × 收费基数 × PI 并投保 d 天；董事长免费投保', () => {
    const sc = companyScenario(4, 'insurance').edit((s) => {
      s.econ.priceIndex = 2;
    });
    sc.force('wheel', 2);
    landOnC3(sc);
    expect(sc.event('COMPANY_FEE')).toMatchObject({ industry: 4, amount: 36000, wheel: 30 });
    expect(sc.event('STATUS_SET')).toMatchObject({ status: 'insurance', value: 30 });
    expect(sc.player(0).insuranceDays).toBe(30);

    const ch = companyScenario(4, 'insurance').edit((s) => chairmanC3(s, 0));
    ch.force('wheel', 0);
    landOnC3(ch);
    expect(ch.event('COMPANY_FEE')).toMatchObject({ seat: 0, amount: 0, wheel: 5 });
    expect(ch.player(0)).toMatchObject({ insuranceDays: 5, cash: 100000 });
  });

  it('company.auto / oil：收费基数 × k × 步数 × PI（汽车 k=2），步行免费', () => {
    const walk = companyScenario(5, 'auto');
    landOnC3(walk);
    expect(walk.events.some((e) => e.type === 'COMPANY_FEE')).toBe(false);
    for (const [ind, key] of [
      [5, 'auto'],
      [6, 'oil'],
    ] as const) {
      const car = companyScenario(ind, key, { vehicle: 'car' });
      landOnC3(car, 1);
      expect(car.event('COMPANY_FEE')).toMatchObject({ industry: ind, amount: 600 * 2 * 1 });
    }
  });

  it('company.sect：收费基数 × 步数 × PI；饭店、银行、百货在企业分支不收费', () => {
    const sc = companyScenario(12, 'sect');
    landOnC3(sc);
    expect(sc.event('COMPANY_FEE')).toMatchObject({ industry: 12, amount: 600 });
    for (const [ind, key] of [
      [2, 'hotel'],
      [7, 'bank'],
      [10, 'dept'],
    ] as const) {
      const none = companyScenario(ind, key);
      landOnC3(none);
      expect(none.events.some((e) => e.type === 'COMPANY_FEE')).toBe(false);
      none.expectAsk(0, 'SUBSCRIBE_SHARES');
    }
  });

  it('company.construction：选自己一块地加盖 1 级，付 地价 × PI；找不到目标收 1000 × PI；董事长免费加 2 级', () => {
    const sc = companyScenario(11, 'construction').edit((s) => {
      s.lands[0]!.owner = 0;
      s.lands[0]!.level = 1;
    });
    landOnC3(sc).expectAsk(0, 'CONSTRUCTION_PICK');
    expect(sc.pending(0).options).toMatchObject({
      company: 'C3',
      chairman: false,
      levels: 1,
      canSkip: false,
      lots: [{ lot: 'L1', level: 1, cost: 2000, rent: 1000 }],
    });
    expect(() => sc.act(0, { type: 'SKIP' })).toThrow(/NOT_ALLOWED/);
    expect(() => sc.act(0, { type: 'PICK_LOT', lot: 'L2' })).toThrow(/INVALID_TARGET/);
    sc.act(0, { type: 'PICK_LOT', lot: 'L1' });
    expect(sc.event('LOT_LEVEL')).toMatchObject({ lot: 'L1', from: 1, to: 2 });
    expect(sc.event('COMPANY_FEE')).toMatchObject({ industry: 11, amount: 2000 });

    const none = companyScenario(11, 'construction');
    landOnC3(none);
    expect(none.event('COMPANY_FEE')).toMatchObject({ amount: 1000 });
    none.expectNoAsk(0, 'CONSTRUCTION_PICK');

    const ch = companyScenario(11, 'construction').edit((s) => {
      chairmanC3(s, 0);
      s.lands[1]!.owner = 0;
    });
    landOnC3(ch).expectAsk(0, 'CONSTRUCTION_PICK');
    expect(ch.pending(0).options).toMatchObject({ chairman: true, levels: 2, lots: [{ lot: 'L2', cost: 0 }] });
    ch.act(0, { type: 'PICK_LOT', lot: 'L2' });
    expect(ch.event('LOT_LEVEL')).toMatchObject({ lot: 'L2', from: 0, to: 2 });
    expect(ch.events.some((e) => e.type === 'COMPANY_FEE')).toBe(false);
    expect(ch.player(0).cash).toBe(100000);
  });

  it('company：付不起时可用免费卡；原版企业消费不接对方的反应台词（exe 0x41a796 传 -1），PASSIVE.other 为 null', () => {
    const sc = companyScenario(1, 'airline')
      .setCash(0, 500, 0)
      .give(0, { cards: [CARD.FREE] });
    sc.force('wheel', 6);
    landOnC3(sc).expectAsk(0, 'USE_FREE_CARD').confirm(0);
    expect(sc.event('PASSIVE')).toMatchObject({ seat: 0, card: CARD.FREE, context: 'fee', other: null });
    expect(sc.events.some((e) => e.type === 'COMPANY_FEE')).toBe(false);
  });

  it('company：没有董事长不收费、只问认购；付不起即破产', () => {
    const sc = scenario({ map: 'test-allkinds', players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 23, 22).force('dice', 1).roll(0);
    expect(sc.events.some((e) => e.type === 'COMPANY_FEE')).toBe(false);
    sc.expectAsk(0, 'SUBSCRIBE_SHARES');

    const br = scenario({ map: 'test-allkinds', players: ['human', 'human', 'human'] })
      .untilMenu(0)
      .edit((s) => chairmanC3(s))
      .setCash(0, 1000, 500);
    br.force('wheel', 2).teleport(0, 23, 22).force('dice', 1).roll(0);
    expect(br.event('COMPANY_FEE')).toMatchObject({ amount: 1500 });
    expect(br.event('BANKRUPT')).toMatchObject({ seat: 0, cause: { k: 'fee', ref: 'C3' } });
  });
});

describe('facility：买、首建、加盖与收费', () => {
  it('facility.buy-build-upgrade：买地价 × PI；首建再付地价 × PI 并选类型；加盖 rate0 × PI；加油站上限 1 级', () => {
    // 1 号一直关着：排除他踩到新闻（税）、魔法屋对 0 号现金的影响
    const sc = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .bench(1);
    sc.teleport(0, 16, 15).force('dice', 1).roll(0).expectAsk(0, 'BUY_FACILITY');
    expect(sc.pending(0).options).toMatchObject({ lot: 'F1', price: 4000, level: 0, type: 'park' });
    sc.confirm(0);
    expect(sc.event('LAND_BOUGHT')).toMatchObject({ seat: 0, lot: 'F1', price: 4000 });
    sc.untilMenu(0).teleport(0, 16, 15).force('dice', 1).roll(0).expectAsk(0, 'BUILD_FACILITY');
    const o = sc.pending(0).options as { cost: number; types: { type: string; cap: number }[] };
    expect(o.cost).toBe(4000);
    expect(o.types.map((t) => [t.type, t.cap])).toEqual([
      ['park', 1],
      ['hotel', 5],
      ['mall', 5],
      ['gas', 1],
      ['lab', 5],
    ]);
    sc.act(0, { type: 'BUILD_FACILITY', facility: 'hotel' });
    expect(sc.event('FACILITY_BUILT')).toMatchObject({ lot: 'F1', facility: 'hotel', seat: 0 });
    expect(sc.state.facilities[0]).toMatchObject({ level: 1, type: 'hotel' });
    sc.untilMenu(0).teleport(0, 16, 15).force('dice', 1).roll(0).expectAsk(0, 'UPGRADE_FACILITY');
    expect(sc.pending(0).options).toMatchObject({ cost: 800, fromLevel: 1, toLevel: 2, cap: 5 });
    sc.confirm(0);
    expect(sc.state.facilities[0]!.level).toBe(2);
    expect(sc.player(0).cash).toBe(100000 - 4000 - 4000 - 800);

    const gas = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 0, level: 1, type: 'gas' });
      });
    gas.teleport(0, 16, 15).force('dice', 1).roll(0).expectNoAsk(0, 'UPGRADE_FACILITY');
  });

  it('facility.buy-leveled：买下带建筑的无主设施只付 地价 × PI（与等级无关，exe 0x41a86b），等级与类型随地保留', () => {
    const sc = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: null, level: 3, type: 'hotel' });
        s.econ.priceIndex = 3;
      });
    sc.teleport(0, 16, 15).force('dice', 1).roll(0).expectAsk(0, 'BUY_FACILITY');
    expect(sc.pending(0).options).toMatchObject({ lot: 'F1', price: 12000, level: 3, type: 'hotel' });
    sc.confirm(0);
    expect(sc.event('LAND_BOUGHT')).toMatchObject({ seat: 0, lot: 'F1', price: 12000 });
    expect(sc.state.facilities[0]).toMatchObject({ owner: 0, level: 3, type: 'hotel' });
    expect(sc.player(0).cash).toBe(100000 - 12000);
  });

  it('tenure.lab：地契到期时研究所的研发作废（RESEARCH_CANCELLED 给原业主），新业主不继承', () => {
    const sc = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, {
          owner: 0,
          level: 2,
          type: 'lab',
          research: { project: 2, days: 4 },
          tenure: nextDate(s.clock.date),
        });
      });
    const expire = sc.state.facilities[0]!.tenure;
    sc.until((s) => s.clock.date === expire && s.facilities[0]!.owner === null);
    expect(sc.state.facilities[0]).toMatchObject({ owner: null, tenure: 0, level: 2, type: 'lab', research: null });
    expect(sc.log.find((e) => e.type === 'TENURE_EXPIRED')).toMatchObject({ lots: ['F1'] });
    expect(sc.log.find((e) => e.type === 'RESEARCH_CANCELLED')).toMatchObject({ seat: 0, lot: 'F1', project: 2 });
    // 1 号买下后（无主设施只付地价 × PI）再过几天也拿不到 0 号的研发
    sc.untilMenu(1).teleport(1, 16, 15).force('dice', 1).roll(1).expectAsk(1, 'BUY_FACILITY').confirm(1);
    expect(sc.state.facilities[0]).toMatchObject({ owner: 1, research: null });
    const from = sc.log.length;
    const end = sc.state.clock.elapsedDays + 8;
    sc.until((s) => s.clock.elapsedDays >= end);
    // 之后的交付只能来自 1 号自己开始的研发（旧业主剩 3 天的进度不应被继承）
    const after = sc.log.slice(from);
    const started = after.findIndex((e) => e.type === 'RESEARCH_STARTED' && e.seat === 1);
    const done = after.findIndex((e) => e.type === 'RESEARCH_DONE');
    expect(done === -1 || (started !== -1 && started < done)).toBe(true);
  });

  it('facility.fortune：福神附身买下 0 级设施 → 免费首建（FACILITY_TYPE）', () => {
    const sc = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .edit((s) => {
        s.players[0]!.god = { kind: 3, days: 7 };
        s.gods.find((g) => g.kind === 3)!.where = { t: 'attached', seat: 0 };
      });
    sc.teleport(0, 16, 15).force('dice', 1).roll(0).expectAsk(0, 'BUY_FACILITY');
    expect(sc.pending(0).options).toMatchObject({ fortuneBonus: true });
    sc.confirm(0).expectAsk(0, 'FACILITY_TYPE');
    sc.act(0, { type: 'CHOOSE_FACILITY_TYPE', facility: 'mall' });
    expect(sc.state.facilities[0]).toMatchObject({ owner: 0, level: 1, type: 'mall' });
    expect(sc.player(0).cash).toBe(96000);
  });

  it('facility.fee：旅馆 n × rate × PI 并住 n 天；购物中心 m × rate；加油站 500 × k × 步数；地主受阻免收', () => {
    const hotel = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 1, level: 2, type: 'hotel' });
      });
    hotel.force('wheel', 5).teleport(0, 16, 15).force('dice', 1).roll(0);
    expect(hotel.event('FEE_PAID')).toMatchObject({ payer: 0, lot: 'F1', feeKind: 'hotel', wheel: 2, amount: 3000 });
    expect(hotel.event('HOTEL_STAY')).toMatchObject({ seat: 0, lot: 'F1', days: 2 });
    expect(hotel.player(0)).toMatchObject({ cash: 97000, st: expect.objectContaining({ hotel: 1 }) });
    expect(hotel.player(0).monthly.loss).toBe(3000 + 4000);
    expect(hotel.player(1).cash).toBe(103000);
    expect(hotel.state.facilities[0]!.lastFee).toBe(3000);
    // 住 2 天：1 个受阻回合 + 1 个走回的回合
    hotel.until((s) => s.players[0]!.st.hotel === 0 && s.pending[0]?.seat === 0 && s.pending[0]?.kind === 'TURN_MENU');
    expect(hotel.log.filter((e) => e.type === 'TURN_BLOCKED' && e.seat === 0 && e.reason === 'hotel')).toHaveLength(1);
    expect(hotel.log.filter((e) => e.type === 'RETURNED' && e.seat === 0)).toHaveLength(1);

    const mall = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 1, level: 3, type: 'mall', mark: { kind: 'raise', days: 3 } });
      });
    mall.force('wheel', 11).teleport(0, 16, 15).force('dice', 1).roll(0);
    expect(mall.event('FEE_PAID')).toMatchObject({ feeKind: 'mall', wheel: 6, amount: 6 * 3500 * 2 });

    const gas = scenario({ players: ['human', 'human'], config: { vehicle: 'car' } })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 1, level: 1, type: 'gas' });
      });
    gas.teleport(0, 15, 14).force('dice', 1, 1).roll(0, 2);
    expect(gas.event('FEE_PAID')).toMatchObject({ feeKind: 'gas', wheel: null, amount: 500 * 2 * 2 });

    const walk = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 1, level: 1, type: 'gas' });
      });
    walk.teleport(0, 16, 15).force('dice', 1).roll(0);
    expect(walk.events.some((e) => e.type === 'FEE_PAID')).toBe(false);

    const exempt = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 1, level: 2, type: 'hotel' });
        s.players[1]!.st.hibernate = 3;
      });
    exempt.teleport(0, 16, 15).force('dice', 1).roll(0);
    expect(exempt.event('TOLL_EXEMPT')).toMatchObject({ payer: 0, lot: 'F1', reason: 'ownerHibernate' });
    expect(exempt.player(0).st.hotel).toBe(0);
  });

  it('insurance.claim：投保中住旅馆，按 2000 × 天数 × PI 从首家保险公司的盈余理赔到现金', () => {
    const sc = scenario({ map: 'test-allkinds', players: ['human', 'human'] })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 1, level: 1, type: 'hotel' });
        s.players[0]!.insuranceDays = 10;
        s.econ.priceIndex = 2;
      });
    sc.force('wheel', 7).teleport(0, 16, 15).force('dice', 1).roll(0);
    expect(sc.event('FEE_PAID')).toMatchObject({ wheel: 3, amount: 3 * 600 * 2 });
    expect(sc.event('INSURANCE_PAYOUT')).toMatchObject({ seat: 0, amount: 2000 * 3 * 2, days: 3 });
    expect(sc.player(0).cash).toBe(100000 - 3600 + 12000);
    expect(sc.state.companies[2]).toMatchObject({ surplusMonth: -12000, surplusTotal: -12000 });
  });

  it('research：业主停在自己的研究所 → RESEARCH（1..等级）；5 天后交付道具 8+项目；查封时不问', () => {
    const sc = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .bench(1)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 0, level: 2, type: 'lab' });
      });
    sc.teleport(0, 16, 15).force('dice', 1).roll(0).expectAsk(0, 'UPGRADE_FACILITY').decline(0);
    sc.expectAsk(0, 'RESEARCH');
    expect(sc.pending(0).options).toMatchObject({
      lot: 'F1',
      level: 2,
      current: null,
      projects: [
        { project: 1, item: 9, days: 5 },
        { project: 2, item: 10, days: 5 },
      ],
    });
    expect(() => sc.act(0, { type: 'RESEARCH', project: 3 })).toThrow(/OUT_OF_RANGE/);
    sc.act(0, { type: 'RESEARCH', project: 2 });
    expect(sc.event('RESEARCH_STARTED')).toMatchObject({ seat: 0, lot: 'F1', project: 2, days: 5 });
    // 之后 0 号随机走动：新闻、命运只抽到不影响研发与行动的
    sc.stackDeck('fate', [3, 20, 21, 22, 25]).stackDeck('news', [26, 24, 25, 22, 27]);
    sc.until((s) => s.players[0]!.items[10] === 1, 2000);
    const done = sc.log.find((e) => e.type === 'RESEARCH_DONE');
    expect(done).toMatchObject({ seat: 0, lot: 'F1', project: 2, item: 10, delivered: true });
    expect(sc.state.facilities[0]!.research).toBeNull();
    expect(sc.log.filter((e) => e.type === 'TURN_STARTED' && e.actor.t === 'seat' && e.actor.seat === 0)).toHaveLength(
      6,
    );

    const sealed = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 0, level: 5, type: 'lab', mark: { kind: 'seal', days: 3 } });
      });
    sealed.teleport(0, 16, 15).force('dice', 1).roll(0).expectNoAsk(0, 'RESEARCH');
  });
});
