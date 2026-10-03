import { describe, expect, it } from 'vitest';
import { buildFixtureMaps, buildTestMapIndustries } from '../../data/maps/fixtures/testMap';
import { createRegistry, type DataRegistry } from '../../data/maps/registry';
import { TABLES } from '../../data/tables/index';
import { scenario } from '../testing/scenario';
import type { SeatIndex } from '../types/ids';
import type { GameState } from '../types/state';

/**
 * 原版另外 3 张图第一次走到的行业与关押结构（fixture 'test-industries'，只给测试用）：
 * - 企业：航空 C1（前沿 6、7）、电子 C2（10、11）、汽车 C3（14、15）、石油 C4（17、18，流通股 0，同大陆「中國石油」）、
 *   建设 C5（22、23）；股票下标 0..4。主环路 1..24 顺时针。
 * - 环路式医院：20 = 保释格 = 关押格（同大陆 63、日本 55、美国 85 / 118）；
 * - 台湾式监狱：保释格 16 → 支线 25（封路）→ 关押格 26（同台湾 12→1、大陆 28→144、日本 78→84）。
 * 获释位置与方向按 exe 核实（VERIFY V-M7，v2.06 0x40d184 / 0x40bc10）：获释不换节点、留在关押格，来路 = 关押格（原版写 0），
 * 下一次起步在全部未封邻格里随机选；关押格放置规则（放物件、跳伞落点）仍待核实，这里只锁定现状。
 */
let registry: DataRegistry | null = null;
function industriesRegistry(): DataRegistry {
  registry ??= createRegistry([...buildFixtureMaps(), buildTestMapIndustries()], { tables: TABLES });
  return registry;
}

function industries(o: { vehicle?: 'walk' | 'moto' | 'car'; players?: 2 | 3 } = {}) {
  return scenario({
    map: 'test-industries',
    registry: industriesRegistry(),
    players: o.players === 3 ? ['human', 'human', 'human'] : ['human', 'human'],
    config: { vehicle: o.vehicle ?? 'walk' },
  }).untilMenu(0);
}

/** seat 成为股票 stock 的董事长（流通股为 0 的石油从保留股里扣） */
function chairman(s: GameState, stock: number, seat: SeatIndex = 1): void {
  s.players[seat]!.holdings[stock] = { shares: 100, costCents: 500000 };
  const st = s.stocks[stock]!;
  if (st.float >= 100) st.float -= 100;
  else s.companies.find((c) => c.stock === stock)!.reserved -= 100;
  st.chairman = seat;
}

/** 与 flow/confine.ts applyConfinement 相同：棋子搬到关押格，来路写成关押格本身 */
function confine(s: GameState, seat: SeatIndex, where: 'hospital' | 'jail', days: number, hold: number): void {
  const p = s.players[seat]!;
  p.st[where] = days;
  p.node = hold;
  p.prevNode = hold;
}

/** 推进到 seat 获释（RELEASED）之后的第一个 TURN_MENU */
function untilReleasedMenu(sc: ReturnType<typeof industries>, seat: SeatIndex): void {
  const from = sc.log.length;
  sc.until(
    (s) =>
      sc.log.slice(from).some((e) => e.type === 'RELEASED' && e.actor.t === 'seat' && e.actor.seat === seat) &&
      s.pending[0]?.seat === seat &&
      s.pending[0]?.kind === 'TURN_MENU',
  );
}

describe('test-industries：各行业的收费与事件路径', () => {
  it('航空（C1）：转盘 0–3 → 收 n × 500 × PI、出国 n 天；n = 0「不用出國」；回来时仍在原节点', () => {
    // AIRLINE_WHEEL = [0,0,1,1,1,1,2,2,2,2,3,3]：强制槽位 0 / 2 / 6 / 10 → n = 0 / 1 / 2 / 3
    for (const [slot, n] of [
      [0, 0],
      [2, 1],
      [6, 2],
      [10, 3],
    ] as const) {
      const sc = industries().edit((s) => chairman(s, 0));
      sc.force('wheel', slot).teleport(0, 5, 4).force('dice', 1).roll(0);
      expect(sc.player(0).node).toBe(6);
      expect(sc.event('COMPANY_FEE')).toMatchObject({ seat: 0, company: 'C1', industry: 1, amount: 500 * n, wheel: n });
      if (n === 0) {
        expect(sc.player(0).st.away).toBe(0);
        sc.expectAsk(0, 'SUBSCRIBE_SHARES');
        continue;
      }
      expect(sc.event('CONFINED')).toMatchObject({ where: 'away', days: n, cause: { k: 'airline', ref: 'C1' } });
      sc.until((s) => s.players[0]!.st.away === 0 && s.pending[0]?.seat === 0 && s.pending[0]?.kind === 'TURN_MENU');
      expect(sc.log.filter((e) => e.type === 'TURN_BLOCKED' && e.seat === 0 && e.reason === 'away')).toHaveLength(n);
      expect(sc.player(0).node).toBe(6);
    }
  });

  it('电子（C2）：收费基数 300 × 已过天数，不乘 PI', () => {
    const sc = industries().edit((s) => {
      chairman(s, 1);
      s.clock.elapsedDays = 12;
      s.econ.priceIndex = 3;
    });
    sc.teleport(0, 9, 8).force('dice', 1).roll(0);
    expect(sc.event('COMPANY_FEE')).toMatchObject({ company: 'C2', industry: 3, amount: 300 * 12, wheel: null });
  });

  it('汽车（C3）与石油（C4）：收费基数 400 × 座驾系数 × 步数 × PI；步行免费', () => {
    // 汽车：机车系数 1，2 步（12 → 13 → 14）
    const moto = industries({ vehicle: 'moto' }).edit((s) => {
      chairman(s, 2);
      s.econ.priceIndex = 2;
    });
    moto.teleport(0, 12, 11).force('dice', 1, 1).roll(0, 2);
    expect(moto.player(0).node).toBe(14);
    expect(moto.event('COMPANY_FEE')).toMatchObject({ company: 'C3', industry: 5, amount: 400 * 1 * 2 * 2 });
    // 石油：汽车系数 2，3 步（14 → 15 → 16 → 17；16 的支线被封，只能往 17）
    const car = industries({ vehicle: 'car' }).edit((s) => chairman(s, 3));
    car.teleport(0, 14, 13).force('dice', 1, 1, 1).roll(0, 3);
    expect(car.player(0).node).toBe(17);
    expect(car.event('COMPANY_FEE')).toMatchObject({ company: 'C4', industry: 6, amount: 400 * 2 * 3 });
    // 步行：两家都不收费
    for (const [from, prev, stock] of [
      [13, 12, 2],
      [16, 15, 3],
    ] as const) {
      const walk = industries().edit((s) => chairman(s, stock));
      walk.teleport(0, from, prev).force('dice', 1).roll(0);
      expect(walk.events.some((e) => e.type === 'COMPANY_FEE')).toBe(false);
    }
  });

  it('石油流通股为 0（同大陆「中國石油」）：没有董事长时只能现场认购保留股', () => {
    const sc = industries();
    sc.teleport(0, 16, 15).force('dice', 1).roll(0).expectAsk(0, 'SUBSCRIBE_SHARES');
    expect(sc.state.stocks[3]!.float).toBe(0);
    expect(sc.state.companies[3]!.reserved).toBe(10000);
  });

  it('建设（C5）：选自己一块地加盖 1 级，付地价 × PI；董事长免费加 2 级', () => {
    const sc = industries().edit((s) => {
      chairman(s, 4);
      s.lands[0]!.owner = 0;
      s.lands[0]!.level = 1;
    });
    sc.teleport(0, 21, 20).force('dice', 1).roll(0).expectAsk(0, 'CONSTRUCTION_PICK');
    expect(sc.pending(0).options).toMatchObject({
      company: 'C5',
      chairman: false,
      levels: 1,
      lots: [{ lot: 'L1', level: 1, cost: 1500 }],
    });
    sc.act(0, { type: 'PICK_LOT', lot: 'L1' });
    expect(sc.event('LOT_LEVEL')).toMatchObject({ lot: 'L1', from: 1, to: 2 });
    expect(sc.event('COMPANY_FEE')).toMatchObject({ company: 'C5', industry: 11, amount: 1500 });

    const ch = industries().edit((s) => {
      chairman(s, 4, 0);
      s.lands[3]!.owner = 0;
    });
    ch.teleport(0, 21, 20).force('dice', 1).roll(0).expectAsk(0, 'CONSTRUCTION_PICK');
    expect(ch.pending(0).options).toMatchObject({ chairman: true, levels: 2, lots: [{ lot: 'L4', cost: 0 }] });
    ch.act(0, { type: 'PICK_LOT', lot: 'L4' });
    expect(ch.event('LOT_LEVEL')).toMatchObject({ lot: 'L4', from: 0, to: 2 });
    expect(ch.events.some((e) => e.type === 'COMPANY_FEE')).toBe(false);
  });
});

describe('test-industries：关押结构与释放方向（V-M7：exe v2.06 0x40d184 / 0x40bc10）', () => {
  /** 关押前站在 at（来路 prev）的 0 号住院 1 天，推进到获释后的回合菜单 */
  function releasedFromLoopHospital(at: number, prev: number) {
    const sc = industries()
      .untilMenu(1)
      .edit((s) => {
        s.players[0]!.node = at;
        s.players[0]!.prevNode = prev;
        confine(s, 0, 'hospital', 1, 20);
      });
    untilReleasedMenu(sc, 0);
    return sc;
  }

  it('环路式医院 20：获释留在关押格，node = prevNode = 20（来路相当于原版 0），关押前的来路不影响', () => {
    for (const [at, prev] of [
      [5, 4],
      [22, 21],
    ] as const) {
      const sc = releasedFromLoopHospital(at, prev);
      expect(sc.event('RETURNED')).toMatchObject({ seat: 0, node: 20 });
      expect(sc.player(0)).toMatchObject({ node: 20, prevNode: 20, savedPrevNode: null, returning: false });
    }
  });

  it('环路式医院 20：出院后第一步在两个邻格里随机选（fork 0 → 19，fork 1 → 21）', () => {
    for (const [fork, to] of [
      [0, 19],
      [1, 21],
    ] as const) {
      const sc = releasedFromLoopHospital(5, 4);
      sc.force('fork', fork).force('dice', 1).roll(0);
      expect(sc.player(0)).toMatchObject({ node: to, prevNode: 20 });
      expect(sc.state.secret.debugQueue).toEqual([]);
    }
  });

  it('台湾式监狱：命运 33 关进支线尽头 26；获释仍在 26，下一步沿支线 26 → 25 → 保释格 16 走出来', () => {
    const sc = industries();
    sc.stackDeck('fate', [33]).teleport(0, 12, 11).force('dice', 1).roll(0);
    expect(sc.event('FATE')).toMatchObject({ seat: 0, id: 33 });
    expect(sc.event('CONFINED')).toMatchObject({ where: 'jail', days: 3 });
    expect(sc.player(0)).toMatchObject({ node: 26, prevNode: 26, savedPrevNode: null });
    untilReleasedMenu(sc, 0);
    expect(sc.log.findLast((e) => e.type === 'RETURNED')).toMatchObject({ seat: 0, node: 26 });
    expect(sc.player(0)).toMatchObject({ node: 26, prevNode: 26 });
    // 关押格只有一个邻格：照样消耗一次 fork 随机数（强制值被取走）
    sc.force('fork', 0).force('dice', 2).roll(0);
    expect(sc.state.secret.debugQueue).toEqual([]);
    expect(sc.event('MOVE_SEGMENT')).toMatchObject({ path: [25, 16] });
    expect(sc.player(0)).toMatchObject({ node: 16, prevNode: 25 });
  });

  it('环路上的关押格：被关的人不算「在棋盘上」，路过的人可以停在同一格并被问保释', () => {
    const sc = industries({ players: 3 }).edit((s) => {
      confine(s, 1, 'hospital', 5, 20);
      s.players[0]!.points = 100;
    });
    sc.teleport(0, 19, 18).force('dice', 1).roll(0);
    expect(sc.player(0).node).toBe(20);
    expect(sc.player(1).node).toBe(20);
    sc.expectAsk(0, 'BAIL');
    expect(sc.pending(0).options).toMatchObject({ where: 'hospital', inmates: [{ seat: 1 }] });
  });
});
