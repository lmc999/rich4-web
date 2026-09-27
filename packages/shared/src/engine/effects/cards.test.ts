import { describe, expect, it } from 'vitest';
import { type AsciiArea, buildAsciiMap } from '../../data/maps/fixtures/ascii';
import { TEST_MAP_SPEC } from '../../data/maps/fixtures/testMap';
import { createRegistry, fixtureRegistry } from '../../data/maps/registry';
import { CMB } from '../../data/tables/combat';
import { ECON } from '../../data/tables/economy';
import { engineMap } from '../core/mapCache';
import { buildTurnMenu } from '../decisions/build';
import { movePrice } from '../rules/stock';
import { type Scenario, scenario } from '../testing/scenario';
import type { CardId, SeatIndex } from '../types/ids';

/**
 * 30 张卡逐张（design/engine.md §10.2；docs/research/r_cards.md）。fixture 'test'：
 *   1 银行 → 2 新闻 → 3 命运 → 4 卡片 → 5 L1 → 6 L2 → 7 L3（S01）→ 8 乐透 → 9 魔法屋 → 10 百货 → 11 L4 → 12 L5（S02）
 *   → 13 岔路 → 14 监狱 → 15 医院 → 16 → 17/18 F1 → 1。整张图都在半宽 220 的视窗内。
 * 场景默认棋盘干净（没有开局摆放的神明、礼物、宝箱）；0 号在 TURN_MENU，1、2 号放在 6、12 号格。
 */
const em = engineMap(fixtureRegistry.getMap('test'));

function setup(cards: CardId[], o: { players?: ('human' | 'ai')[] } = {}): Scenario {
  const sc = scenario({ players: o.players ?? ['human', 'human', 'human'] }).untilMenu(0);
  sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11);
  return sc.give(0, { cards });
}

function setLand(sc: Scenario, lot: string, owner: SeatIndex | null, level: number, chain = false): void {
  sc.edit((s) => {
    const l = s.lands.find((x) => x.id === lot)!;
    l.owner = owner;
    l.level = level as 0;
    l.chain = chain;
  });
}

describe('cards（30 张卡的效果）', () => {
  it('1 均富：在场玩家现金平均（向零取整，余数销毁）；高于平均者敌意 +(现金 − 平均)/100', () => {
    const sc = setup([1]).setCash(0, 100, 0).setCash(1, 1000, 0).setCash(2, 3000, 0);
    const net = () => sc.state.econ.ledger.burned - sc.state.econ.ledger.minted;
    const before = net();
    sc.useCard(0, 1);
    expect(sc.state.players.map((p) => p.cash)).toEqual([1366, 1366, 1366]);
    expect(net() - before).toBe(2);
    expect(sc.player(2).hostility[0]).toBe(16);
    expect(sc.player(1).hostility[0]).toBe(0);
    sc.expectEvents(['CARD_USED', 'MONEY', 'MONEY', 'MONEY']).expectAsk(0, 'TURN_MENU');
  });

  it('2 均贫：与范围内一名对手现金平分；吃亏的对手敌意 +差额/100', () => {
    const sc = setup([2]).setCash(0, 1000, 0).setCash(1, 9001, 0);
    sc.useCard(0, 2, { t: 'seat', seat: 1 });
    expect([sc.player(0).cash, sc.player(1).cash]).toEqual([5000, 5000]);
    expect(sc.player(1).hostility[0]).toBe(40);
    expect(() => sc.useCard(0, 2, { t: 'seat', seat: 0 })).toThrow(/no card 2/);
  });

  it('3 购地：脚下别人的地按 (地价 + 等级×房价)×PI 付给原主，地契重算；现金不足不可用（卡保留）', () => {
    const sc = setup([3, 3]);
    setLand(sc, 'L1', 1, 2);
    sc.setCash(0, 2999, 0);
    expect(() => sc.useCard(0, 3, { t: 'underfoot', facility: null })).toThrow(/NOT_USABLE/);
    sc.setCash(0, 3000, 0);
    const c1 = sc.player(1).cash;
    sc.useCard(0, 3, { t: 'underfoot', facility: null });
    expect(sc.state.lands[0]).toMatchObject({ owner: 0, level: 2 });
    expect(sc.player(0).cash).toBe(0);
    expect(sc.player(1).cash).toBe(c1 + 3000);
    expect(sc.player(1).hostility[0]).toBe(1600);
    expect(sc.player(0).cards).toEqual([3]);
    sc.expectEvents(['CARD_USED', 'MONEY', 'LAND_BOUGHT']);
  });

  it('4 换地：脚下地块与范围内同类地块交换地主（等级留在原地）', () => {
    const sc = setup([4]);
    setLand(sc, 'L1', 0, 1);
    setLand(sc, 'L4', 1, 3);
    sc.useCard(0, 4, { t: 'lotPair', from: 'L1', to: 'L4' });
    expect(sc.state.lands[0]).toMatchObject({ owner: 1, level: 1 });
    expect(sc.state.lands[3]).toMatchObject({ owner: 0, level: 3 });
    expect(() => sc.give(0, { cards: [4] }).useCard(0, 4, { t: 'lotPair', from: 'L1', to: 'F1' })).toThrow(
      /INVALID_TARGET/,
    );
  });

  it('5 换屋：交换等级与连锁店，地主不变', () => {
    const sc = setup([5]);
    setLand(sc, 'L1', 0, 1);
    setLand(sc, 'L4', 1, 1, true);
    sc.useCard(0, 5, { t: 'lotPair', from: 'L1', to: 'L4' });
    expect(sc.state.lands[0]).toMatchObject({ owner: 0, level: 1, chain: true });
    expect(sc.state.lands[3]).toMatchObject({ owner: 1, level: 1, chain: false });
  });

  it('4 / 5 换地、换屋：研究所只在换了地主、改了类型或等级低于项目时研发作废', () => {
    // 两块设施的小图：F1（17/18 号格）与 F2（11/12 号格，原 L4/L5）
    const f1 = TEST_MAP_SPEC.areas.find((a): a is Extract<AsciiArea, { kind: 'facility' }> => a.id === 'F1')!;
    const def = buildAsciiMap({
      ...TEST_MAP_SPEC,
      id: 'twofac',
      layout: TEST_MAP_SPEC.layout.map((r) => r.replace(/~/g, 'G').replace('b2', '.').replace('b1', '.')),
      tiles: TEST_MAP_SPEC.tiles.map((t) => (t.id === 11 || t.id === 12 ? { ...t, lot: 'F2' } : t)),
      streets: TEST_MAP_SPEC.streets.filter((x) => x.id !== 'S02'),
      areas: [...TEST_MAP_SPEC.areas.filter((a) => a.id !== 'L4' && a.id !== 'L5'), { ...f1, symbol: 'G', id: 'F2' }],
    });
    const registry = createRegistry([def]);
    const run = (card: CardId, f2: { owner: SeatIndex; level: number; type: 'lab' | 'hotel' }) => {
      const sc = scenario({ registry, map: 'twofac', players: ['human', 'human'] }).untilMenu(0);
      sc.teleport(0, 17, 16).give(0, { cards: [card] });
      sc.edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 0, level: 3, type: 'lab', research: { project: 2, days: 4 } });
        Object.assign(s.facilities[1]!, { owner: f2.owner, level: f2.level, type: f2.type, research: null });
      });
      sc.useCard(0, card, { t: 'lotPair', from: 'F1', to: 'F2' });
      return sc;
    };
    const cancelled = (sc: Scenario) => sc.events.filter((e) => e.type === 'RESEARCH_CANCELLED');
    // 换地：同一地主 → 不换主，研发保留
    let sc = run(4, { owner: 0, level: 2, type: 'hotel' });
    expect(cancelled(sc)).toEqual([]);
    expect(sc.state.facilities[0]).toMatchObject({ owner: 0, type: 'lab', research: { project: 2, days: 4 } });
    // 换地：换了地主 → 作废（发给原地主）
    sc = run(4, { owner: 1, level: 2, type: 'hotel' });
    expect(cancelled(sc)).toMatchObject([{ seat: 0, lot: 'F1', project: 2 }]);
    expect(sc.state.facilities[0]).toMatchObject({ owner: 1, research: null });
    // 换屋：两个研究所互换、换后等级仍 ≥ 项目 → 保留
    sc = run(5, { owner: 0, level: 2, type: 'lab' });
    expect(cancelled(sc)).toEqual([]);
    expect(sc.state.facilities[0]).toMatchObject({ level: 2, type: 'lab', research: { project: 2, days: 4 } });
    // 换屋：换成旅馆 → 作废，事件在 LOT_LEVEL 之后
    sc = run(5, { owner: 0, level: 2, type: 'hotel' });
    sc.expectEvents(['CARD_USED', 'LOT_LEVEL', 'LOT_LEVEL', 'RESEARCH_CANCELLED'], 'exact');
    expect(sc.state.facilities[0]).toMatchObject({ type: 'hotel', research: null });
  });

  it('6 转向：来路改为当前前进候选（随机取），REVERSED', () => {
    const sc = setup([6]);
    sc.useCard(0, 6, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    expect(sc.player(1)).toMatchObject({ node: 6, prevNode: 7 });
    sc.expectEvents(['CARD_USED', 'REVERSED']);
  });

  it('7 改建：住宅在普通与连锁店之间切换（变连锁店等级取 min(等级,1)）；设施改为指定类型', () => {
    const sc = setup([7, 7]);
    setLand(sc, 'L1', 1, 3);
    sc.useCard(0, 7, { t: 'underfoot', facility: null });
    expect(sc.state.lands[0]).toMatchObject({ owner: 1, level: 1, chain: true });
    sc.teleport(0, 18, 1).edit((s) => {
      Object.assign(s.facilities[0]!, { owner: 1, level: 3, type: 'hotel' });
    });
    sc.useCard(0, 7, { t: 'underfoot', facility: 'gas' });
    expect(sc.state.facilities[0]).toMatchObject({ owner: 1, level: 1, type: 'gas' });
  });

  it('8 拍卖：脚下的地产开拍（起拍 trunc(地价 × (1 + 等级 × 0.5)) × PI），出卡者不能出价，成交款进他的存款', () => {
    const sc = setup([8]);
    setLand(sc, 'L1', 1, 2);
    const landPrice = sc.state.lands[0]!.landPrice;
    const start = landPrice * 2;
    const dep0 = sc.player(0).deposit;
    sc.useCard(0, 8, { t: 'underfoot', facility: null });
    expect(sc.event('AUCTION_STARTED')).toMatchObject({ lot: 'L1', seller: 0, source: 'card', start, bidders: [1, 2] });
    // 1、2 号同时被问；出卡者没有
    sc.expectAsk(1, 'AUCTION_BID').expectAsk(2, 'AUCTION_BID').expectNoAsk(0);
    expect(sc.pending(1).options).toMatchObject({ lot: 'L1', level: 2, start, price: start, leader: null, others: 1 });
    const stale = sc.pending(2).id;
    sc.act(1, { type: 'BID', inc: 100 });
    expect(sc.event('AUCTION_BID')).toMatchObject({ seat: 1, price: start + 100 });
    // 1 号领先后 2 号的旧询问作废、重新发出；1 号不再被问
    expect(() => sc.apply({ type: 'PASS', seat: 2, decisionId: stale })).toThrow(/STALE_DECISION/);
    sc.expectAsk(2, 'AUCTION_BID').expectNoAsk(1);
    expect((sc.pending(2).options as { increments: number[] }).increments).not.toContain(0);
    sc.act(2, { type: 'PASS' });
    expect(sc.event('AUCTION_ENDED')).toMatchObject({ lot: 'L1', winner: 1, price: start + 100 });
    expect(sc.state.lands[0]).toMatchObject({ owner: 1, level: 2 });
    expect(sc.player(0).deposit).toBe(dep0 + start + 100);
    expect(sc.player(0).cards).toEqual([]);
    sc.expectAsk(0, 'TURN_MENU');
  });

  it('8 拍卖：没人出价（流拍）则该地变为无主、建筑保留；自己的地也能拍', () => {
    const sc = setup([8, 8]);
    setLand(sc, 'L1', 0, 3);
    sc.useCard(0, 8, { t: 'underfoot', facility: null });
    sc.act(1, { type: 'PASS' }).act(2, { type: 'QUIT' });
    expect(sc.event('AUCTION_ENDED')).toMatchObject({ lot: 'L1', winner: null });
    expect(sc.state.lands[0]).toMatchObject({ owner: null, level: 3 });
    // 现金 ≤ 起拍价、受困者不能出价
    sc.setCash(1, 10, 0).edit((s) => {
      s.players[2]!.st.hibernate = 3;
    });
    sc.useCard(0, 8, { t: 'underfoot', facility: null });
    expect(sc.event('AUCTION_STARTED')).toMatchObject({ bidders: [] });
    expect(sc.event('AUCTION_ENDED')).toMatchObject({ winner: null });
    sc.expectAsk(0, 'TURN_MENU');
  });

  it('9 天使：同名路段每块 +1（不论地主，满级跳过）；0 级设施首建需附带类型', () => {
    const sc = setup([9, 9]);
    setLand(sc, 'L1', 0, 1);
    setLand(sc, 'L3', 1, 5);
    sc.useCard(0, 9, { t: 'lot', lot: 'L2', facility: null });
    expect(sc.state.lands.slice(0, 3).map((l) => l.level)).toEqual([2, 1, 5]);
    expect(() => sc.useCard(0, 9, { t: 'lot', lot: 'F1', facility: null })).toThrow(/INVALID_TARGET/);
    sc.useCard(0, 9, { t: 'lot', lot: 'F1', facility: 'mall' });
    expect(sc.state.facilities[0]).toMatchObject({ level: 1, type: 'mall', owner: null });
  });

  it('10 恶魔：同名路段全部夷平（地主保留）；地主敌意 等级 × 30 × PI', () => {
    const sc = setup([10]);
    setLand(sc, 'L1', 1, 3);
    setLand(sc, 'L2', 2, 2);
    sc.useCard(0, 10, { t: 'lot', lot: 'L3', facility: null });
    expect(sc.state.lands.slice(0, 3).map((l) => [l.owner, l.level])).toEqual([
      [1, 0],
      [2, 0],
      [null, 0],
    ]);
    expect(sc.player(1).hostility[0]).toBe(90);
    expect(sc.player(2).hostility[0]).toBe(60);
  });

  it('11 怪兽：范围内别人已有建筑的地产夷平；自己的与空地不可选', () => {
    const sc = setup([11]);
    setLand(sc, 'L4', 1, 4);
    setLand(sc, 'L1', 0, 3);
    expect(() => sc.useCard(0, 11, { t: 'lot', lot: 'L1', facility: null })).toThrow(/INVALID_TARGET/);
    sc.useCard(0, 11, { t: 'lot', lot: 'L4', facility: null });
    expect(sc.state.lands[3]).toMatchObject({ owner: 1, level: 0 });
    expect(sc.player(1).hostility[0]).toBe(120);
  });

  it('12 拆除：别人的建筑拆一级（敌意 30×PI）；路面的路障移除回库存', () => {
    const sc = setup([12, 12]);
    setLand(sc, 'L4', 1, 3);
    sc.useCard(0, 12, { t: 'lot', lot: 'L4', facility: null });
    expect(sc.state.lands[3]!.level).toBe(2);
    expect(sc.player(1).hostility[0]).toBe(30);
    sc.placeObject('roadblock', 8, 1);
    const pool = sc.state.pools.items[2]!;
    sc.useCard(0, 12, { t: 'object', object: sc.lastObjectId });
    expect(sc.state.objects).toEqual([]);
    expect(sc.state.pools.items[2]).toBe(pool + 1);
  });

  it('13 抢夺：抢卡（敌意 = 卡价）或抢道具（敌意 = 道具价）', () => {
    const sc = setup([13, 13]);
    sc.give(1, { cards: [20] });
    sc.useCard(0, 13, { t: 'rob', seat: 1, take: { k: 'card', slot: 0 } });
    expect(sc.player(1).cards).toEqual([]);
    expect(sc.player(0).cards).toContain(20);
    expect(sc.player(1).hostility[0]).toBe(25);
    const mines = sc.player(0).items[3]!;
    sc.useCard(0, 13, { t: 'rob', seat: 1, take: { k: 'item', item: 3 } });
    expect(sc.player(1).items[3]).toBe(0);
    expect(sc.player(0).items[3]).toBe(mines + 1);
    expect(sc.player(1).hostility[0]).toBe(50);
  });

  it('13 抢夺：自己该道具已有 9 个时被抢的道具回库存（机车 / 汽车同样按 9 封顶）', () => {
    const sc = setup([13]);
    sc.give(0, { items: [{ item: 5, qty: 9 }] }).give(1, { items: [{ item: 5, qty: 1 }] });
    const pool = sc.state.pools.items[5]!;
    sc.useCard(0, 13, { t: 'rob', seat: 1, take: { k: 'item', item: 5 } });
    expect(sc.player(0).items[5]).toBe(9);
    expect(sc.player(1).items[5]).toBe(0);
    expect(sc.state.pools.items[5]).toBe(pool + 1);
    sc.expectEvents(['CARD_USED', 'ITEM_LOST'], 'exact');
  });

  it('14 停留：对自己写 0x80（本回合掷出 0 步），对别人写 1', () => {
    const sc = setup([14, 14]);
    sc.useCard(0, 14, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    expect(sc.player(1).st.stay).toBe(CMB.STAY_OTHER);
    sc.useCard(0, 14, { t: 'actor', actor: { t: 'seat', seat: 0 } });
    expect(sc.player(0).st.stay).toBe(0x80);
    sc.roll(0);
    expect(sc.event('DICE_ROLLED')).toMatchObject({ steps: 0 });
  });

  it('15 冬眠：所有棋盘上的对手冬眠 5 天并清除梦游；敌意 150×PI；自己不受影响', () => {
    const sc = setup([15]);
    sc.edit((s) => {
      s.players[1]!.st.sleepwalk = 3;
    });
    sc.useCard(0, 15);
    expect(sc.state.players.map((p) => p.st.hibernate)).toEqual([0, 5, 5]);
    expect(sc.player(1).st.sleepwalk).toBe(0);
    expect(sc.player(2).hostility[0]).toBe(150);
  });

  it('16 梦游：对手梦游 5 天、交通工具退回背包；目标冬眠中则无效（卡照扣）', () => {
    const sc = setup([16, 16]);
    sc.edit((s) => {
      s.players[1]!.vehicle = 'car';
      s.players[1]!.diceCount = 3;
      s.pools.items[6] = s.pools.items[6]! - 1;
    });
    sc.useCard(0, 16, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    expect(sc.player(1)).toMatchObject({ vehicle: 'walk', diceCount: 1 });
    expect(sc.player(1).st.sleepwalk).toBe(CMB.SLEEPWALK_DAYS);
    expect(sc.player(1).items[6]).toBe(1);
    expect(sc.player(1).hostility[0]).toBe(150);
    sc.edit((s) => {
      s.players[2]!.st.hibernate = 3;
    });
    sc.useCard(0, 16, { t: 'actor', actor: { t: 'seat', seat: 2 } });
    sc.expectEvents(['CARD_USED', 'CARD_NO_EFFECT']);
    expect(sc.player(2).st.sleepwalk).toBe(0);
    expect(sc.player(0).cards).toEqual([]);
  });

  it('17 陷害：对手坐牢 5 天（搬到关押格）；敌意 150×PI', () => {
    const sc = setup([17]);
    sc.useCard(0, 17, { t: 'actor', actor: { t: 'seat', seat: 2 } });
    expect(sc.player(2)).toMatchObject({ node: 14, st: expect.objectContaining({ jail: 5 }) });
    expect(sc.player(2).hostility[0]).toBe(150);
    sc.expectEvents(['CARD_USED', 'CONFINED']);
  });

  it('18–21 复仇 / 嫁祸 / 免费 / 免罪：被动卡不能主动打出', () => {
    const sc = setup([18, 19, 20, 21]);
    for (const c of [18, 19, 20, 21] as CardId[]) {
      expect(() => sc.useCard(0, c)).toThrow(/NOT_USABLE/);
    }
    const rows = buildTurnMenu(sc.state, em, 0).cards;
    expect(rows.map((r) => [r.card, r.usable, r.reason])).toEqual([
      [18, false, 'passive'],
      [19, false, 'passive'],
      [20, false, 'passive'],
      [21, false, 'passive'],
    ]);
  });

  it('22 送神符：送走身上的坏神（搭档刷出）与定时炸弹；只有好神时不可用', () => {
    const sc = setup([22, 22]);
    sc.attachGod(0, 5);
    sc.edit((s) => {
      s.players[0]!.bomb = { fuse: 10 };
      s.pools.items[4] = s.pools.items[4]! - 1;
    });
    const pool = sc.state.pools.items[4]!;
    sc.useCard(0, 22);
    expect(sc.player(0).god).toBeNull();
    expect(sc.player(0).bomb).toBeNull();
    expect(sc.state.pools.items[4]).toBe(pool + 1);
    expect(sc.player(0).luck).toEqual({ bad: 0, wealth: 0, fortune: 0 });
    expect(sc.state.gods.find((g) => g.kind === 6)!.where.t).toBe('road');
    sc.attachGod(0, 1);
    expect(() => sc.useCard(0, 22)).toThrow(/NOT_USABLE/);
  });

  it('23 请神符：请来范围内最近的可附身神明 → 附身并发威', () => {
    const sc = setup([23]);
    sc.placeGod(3, 7).placeGod(9, 13);
    const hand = sc.player(0).cards.length;
    sc.useCard(0, 23);
    expect(sc.player(0).god).toMatchObject({ kind: 3, days: 7 });
    expect(sc.player(0).cards.length).toBe(hand - 1 + 1);
    sc.expectEvents(['CARD_USED', 'GOD_ATTACHED', 'GOD_POWER', 'CARD_GAINED']);
  });

  it('24 / 25 红卡、黑卡：立即按开盘价 ±10% 重定当日价，走势计数 2；休市日不可用', () => {
    const sc = setup([24, 25]);
    expect(sc.state.clock.marketOpen).toBe(true);
    const open = sc.state.stocks[3]!.openCents;
    sc.useCard(0, 24, { t: 'stock', stock: 3 });
    expect(sc.state.stocks[3]).toMatchObject({ up: 2, down: 0, priceCents: movePrice(open, ECON.STOCK_LIMIT_PCT) });
    sc.useCard(0, 25, { t: 'stock', stock: 3 });
    expect(sc.state.stocks[3]).toMatchObject({ up: 0, down: 2, priceCents: movePrice(open, -ECON.STOCK_LIMIT_PCT) });
    sc.give(0, { cards: [24] }).edit((s) => {
      s.clock.marketOpen = false;
    });
    expect(() => sc.useCard(0, 24, { t: 'stock', stock: 3 })).toThrow(/NOT_USABLE/);
  });

  it('26 查税：对手现金的 20% 转入出卡者存款；敌意 税额/100', () => {
    const sc = setup([26]).setCash(1, 10000, 0);
    const dep = sc.player(0).deposit;
    sc.useCard(0, 26, { t: 'seat', seat: 1 });
    expect(sc.player(1).cash).toBe(8000);
    expect(sc.player(0).deposit).toBe(dep + 2000);
    expect(sc.player(1).hostility[0]).toBe(20);
  });

  it('27 / 28 涨价、查封：住宅同名路段标记 5 天，设施只标这一处；后写覆盖前写', () => {
    const sc = setup([27, 28, 28]);
    sc.useCard(0, 27, { t: 'lot', lot: 'L2', facility: null });
    expect(sc.state.lands.slice(0, 3).map((l) => l.mark)).toEqual(
      new Array(3).fill({ kind: 'raise', days: ECON.MARK_DAYS }),
    );
    sc.useCard(0, 28, { t: 'lot', lot: 'L1', facility: null });
    expect(sc.state.lands[1]!.mark).toEqual({ kind: 'seal', days: ECON.MARK_DAYS });
    sc.useCard(0, 28, { t: 'lot', lot: 'F1', facility: null });
    expect(sc.state.facilities[0]!.mark).toEqual({ kind: 'seal', days: ECON.MARK_DAYS });
    expect(sc.state.lands[3]!.mark).toBeNull();
  });

  it('28 查封研究所：进行中的研发作废（RESEARCH_CANCELLED 给业主）；涨价不影响研发', () => {
    const sc = setup([27, 28]);
    sc.edit((s) => {
      Object.assign(s.facilities[0]!, { owner: 1, level: 2, type: 'lab', research: { project: 2, days: 3 } });
    });
    sc.useCard(0, 27, { t: 'lot', lot: 'F1', facility: null });
    expect(sc.state.facilities[0]!.research).toEqual({ project: 2, days: 3 });
    sc.useCard(0, 28, { t: 'lot', lot: 'F1', facility: null });
    sc.expectEvents(['CARD_USED', 'MARK_SET', 'RESEARCH_CANCELLED'], 'exact');
    expect(sc.event('RESEARCH_CANCELLED')).toMatchObject({ seat: 1, lot: 'F1', project: 2 });
    expect(sc.state.facilities[0]).toMatchObject({ research: null, mark: { kind: 'seal' } });
  });

  it('29 同盟：先解除双方旧同盟，再互相绑定 7 天', () => {
    const sc = setup([29, 29]);
    sc.useCard(0, 29, { t: 'seat', seat: 1 });
    expect(sc.player(0).alliance).toEqual({ seat: 1, days: 7 });
    expect(sc.player(1).alliance).toEqual({ seat: 0, days: 7 });
    sc.useCard(0, 29, { t: 'seat', seat: 2 });
    expect(sc.player(1).alliance).toBeNull();
    expect(sc.player(2).alliance).toEqual({ seat: 0, days: 7 });
    sc.expectEvents(['CARD_USED', 'ALLIANCE_BROKEN', 'ALLIANCE_FORMED']);
  });

  it('30 乌龟：对自己 2、对别人 3；乌龟期间只走 1 步、遥控骰子不可用', () => {
    const sc = setup([30, 30]);
    sc.useCard(0, 30, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    expect(sc.player(1).st.tortoise).toBe(CMB.TORTOISE_OTHER);
    sc.useCard(0, 30, { t: 'actor', actor: { t: 'seat', seat: 0 } });
    expect(sc.player(0).st.tortoise).toBe(CMB.TORTOISE_SELF);
    expect(() => sc.useItem(0, 8, { t: 'dice', value: 6 })).toThrow(/NOT_USABLE/);
    sc.roll(0);
    expect(sc.event('DICE_ROLLED')).toMatchObject({ steps: 1 });
  });

  it('14 / 30 停留、乌龟对梦游中的对手同样生效：梦游乱走也先看停留（0 步）与乌龟（1 步）', () => {
    const rolledBy = (sc: Scenario, seat: SeatIndex) =>
      sc.log.filter((e) => e.type === 'DICE_ROLLED' && e.seat === seat) as Extract<
        (typeof sc.log)[number],
        { type: 'DICE_ROLLED' }
      >[];
    // 停留：梦游者下一个回合原地不动、不掷骰
    const a = setup([14]);
    a.edit((s) => {
      s.players[1]!.st.sleepwalk = 3;
    });
    a.useCard(0, 14, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    a.roll(0).until(() => rolledBy(a, 1).length > 0);
    expect(rolledBy(a, 1)[0]).toMatchObject({ dice: [], steps: 0, diceCount: 1 });
    expect(a.player(1).node).toBe(6);
    // 乌龟：梦游者之后 3 次都只走 1 步
    const b = setup([30]);
    b.edit((s) => {
      s.players[1]!.st.sleepwalk = 5;
    });
    b.useCard(0, 30, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    b.roll(0).until(() => rolledBy(b, 1).length >= 3);
    expect(rolledBy(b, 1).map((e) => [e.dice.length, e.steps])).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
  });

  it('选错目标或卡槽不符：抛错且卡保留', () => {
    const sc = setup([2]);
    expect(() => sc.act(0, { type: 'USE_CARD', slot: 0, card: 3, target: { t: 'none' } })).toThrow(/INVALID_TARGET/);
    expect(() => sc.useCard(0, 2, { t: 'seat', seat: 3 as SeatIndex })).toThrow();
    expect(sc.player(0).cards).toEqual([2]);
  });
});
