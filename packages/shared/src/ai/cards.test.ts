import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../data/maps/registry';
import { engineMap } from '../engine/core/mapCache';
import { buildTurnMenu } from '../engine/decisions/build';
import { type Scenario, scenario } from '../engine/testing/scenario';
import { simpleView } from '../engine/testing/view';
import type { AiTraits, CardId, GameState, SeatIndex, TurnMenuCardRow } from '../engine/types/index';
import type { GameView } from '../view/types';
import { CARD_AI } from './cards';
import { makeAiContext } from './rng';
import { AiView } from './view';

/**
 * 原版 AI 的用卡判据（design/minigames-ai.md §9.5）：每张卡至少一正一反。
 * 0 号是电脑，站在 5 号格（L1）；1 号在 6 号格，2 号在 12 号格；整张 fixture 都在视野内。
 */
const map = fixtureRegistry.getMap('test');
const em = engineMap(map);

function setup(cards: CardId[], edit?: (s: GameState) => void): Scenario {
  const sc = scenario({ players: ['ai', 'human', 'human'] }).untilMenu(0);
  sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11).give(0, { cards });
  if (edit) sc.edit(edit);
  return sc;
}

function judge(sc: Scenario, card: CardId, traits: Partial<AiTraits> = {}, salt = 'd1') {
  const s = sc.state;
  const rows = buildTurnMenu(s, em, 0).cards;
  const row = rows.find((r) => r.card === card) as TurnMenuCardRow;
  const p = s.players[0]!;
  const ctx = makeAiContext({
    aiSeed: s.secret.aiSeed,
    seat: 0,
    decisionId: salt,
    turnNo: s.clock.turnNo,
    traits: { ...p.aiTraits, ...traits },
    map,
    handVisibility: 'public',
  });
  return { row, target: CARD_AI[card](new AiView(simpleView(s) as GameView, 0, map), row, ctx) };
}

/** 改现金并按差额记台账（铸造 / 销毁） */
function cash(s: GameState, seat: SeatIndex, value: number): void {
  const p = s.players.find((x) => x.seat === seat)!;
  const d = value - p.cash;
  p.cash = value;
  if (d > 0) s.econ.ledger.minted += d;
  else s.econ.ledger.burned += -d;
}

/** 给 seat 持股（从流通股扣）并设为董事长 */
function hold(s: GameState, seat: SeatIndex, stock: number, shares: number): void {
  s.players.find((x) => x.seat === seat)!.holdings[stock] = { shares, costCents: 0 };
  s.stocks[stock]!.float -= shares;
  s.stocks[stock]!.chairman = seat;
}

function own(s: GameState, lot: string, owner: SeatIndex | null, level: number, chain = false): void {
  Object.assign(s.lands.find((l) => l.id === lot)!, { owner, level, chain });
}

describe('cards（AI 用卡判据）', () => {
  it('1 均富：平均现金 > 我的 ×10 且我的现金 < 3000·PI', () => {
    const yes = setup([1], (s) => {
      cash(s, 0, 100);
      cash(s, 1, 50000);
    });
    expect(judge(yes, 1).target).toEqual({ t: 'none' });
    expect(judge(setup([1]), 1).target).toBeNull();
  });

  it('2 均贫：视野内现金 > 50000·PI 且 > 我的 3 倍的对手（取下标最大）', () => {
    const sc = setup([2], (s) => cash(s, 0, 1000));
    expect(judge(sc, 2).target).toEqual({ t: 'seat', seat: 2 });
    expect(judge(setup([2]), 2).target).toBeNull();
  });

  it('3 购地：脚下是最恨的人 ≥2 级的地且买得起；没人可恨时不用', () => {
    const edit = (hate: boolean) => (s: GameState) => {
      own(s, 'L1', 1, 2);
      if (hate) s.players[0]!.hostility[1] = 100;
    };
    expect(judge(setup([3], edit(true)), 3).target).toEqual({ t: 'underfoot', facility: null });
    expect(judge(setup([3], edit(false)), 3).target).toBeNull();
  });

  it('4 换地：脚下是我的 ≤1 级地，与视野内不同街、更贵更高级且值得抢的地互换', () => {
    const edit = (lv: number) => (s: GameState) => {
      own(s, 'L1', 0, 0);
      Object.assign(s.lands[3]!, { owner: 1, level: lv, landPrice: 3000 });
      s.players[0]!.hostility[1] = 50;
    };
    expect(judge(setup([4], edit(2)), 4).target).toEqual({ t: 'lotPair', from: 'L1', to: 'L4' });
    expect(judge(setup([4], edit(0)), 4).target).toBeNull();
  });

  it('5 / 6 换屋、转向：电脑从不使用', () => {
    const sc = setup([5, 6], (s) => own(s, 'L1', 0, 1));
    expect(judge(sc, 5).target).toBeNull();
    expect(judge(sc, 6).target).toBeNull();
  });

  it('7 改建：乖宝宝把脚下自己的 1 级住宅改成连锁店；大老奸要求同街其余都是对手的', () => {
    const sc = setup([7], (s) => own(s, 'L1', 0, 1));
    expect(judge(sc, 7, { personality: 0 }).target).toEqual({ t: 'underfoot', facility: null });
    expect(judge(sc, 7, { personality: 2 }).target).toBeNull();
  });

  it('9 天使：视野内我有 ≥3 块未满级住宅的街', () => {
    const yes = setup([9], (s) => {
      own(s, 'L1', 0, 1);
      own(s, 'L2', 0, 1);
      own(s, 'L3', 0, 2);
    });
    expect(judge(yes, 9).target).toEqual({ t: 'lot', lot: 'L1', facility: null });
    expect(
      judge(
        setup([9], (s) => own(s, 'L1', 0, 1)),
        9,
      ).target,
    ).toBeNull();
  });

  it('10 恶魔：最恨的人在该街 ≥2 间、等级和 ≥7，我的等级和 ≤1', () => {
    const edit = (lv: number) => (s: GameState) => {
      own(s, 'L4', 1, lv);
      own(s, 'L5', 1, 4);
      s.players[0]!.hostility[1] = 10;
    };
    expect(judge(setup([10], edit(3)), 10).target).toMatchObject({ t: 'lot', lot: 'L4' });
    expect(judge(setup([10], edit(2)), 10).target).toBeNull();
  });

  it('11 怪兽：没有最恨的人时，对手的地要 ≥4 级', () => {
    expect(
      judge(
        setup([11], (s) => own(s, 'L4', 1, 4)),
        11,
      ).target,
    ).toEqual({ t: 'lot', lot: 'L4', facility: null });
    expect(
      judge(
        setup([11], (s) => own(s, 'L4', 1, 3)),
        11,
      ).target,
    ).toBeNull();
  });

  it('12 拆除：怪兽判据之外，拆掉我地上的地雷', () => {
    const sc = setup([12], (s) => own(s, 'L2', 0, 1));
    sc.placeObject('mine', 6);
    expect(judge(sc, 12).target).toEqual({ t: 'object', object: sc.lastObjectId });
    expect(judge(setup([12]), 12).target).toBeNull();
  });

  it('13 抢夺：最恨的人手里 f7 ≥1 的最贵一张；否则所有对手手里 f7==2 的最贵一张', () => {
    const sc = setup([13]).give(1, { cards: [3, 15] });
    expect(judge(sc, 13).target).toEqual({ t: 'rob', seat: 1, take: { k: 'card', slot: 1 } });
    expect(judge(setup([13]).give(1, { cards: [4] }), 13).target).toBeNull();
  });

  it('14 停留：对自己——脚下是自己未满级的住宅、同街另有我的地且钱够', () => {
    const edit = (other: boolean) => (s: GameState) => {
      own(s, 'L1', 0, 1);
      if (other) own(s, 'L2', 0, 1);
    };
    expect(judge(setup([14], edit(true)), 14).target).toEqual({ t: 'actor', actor: { t: 'seat', seat: 0 } });
    expect(judge(setup([14], edit(false)), 14).target).toBeNull();
  });

  it('15 冬眠：rng%4==0（按回合盐稳定）', () => {
    let used = 0;
    for (let i = 0; i < 40; i++) {
      const sc = setup([15]);
      sc.edit((s) => {
        s.clock.turnNo = i;
      });
      if (judge(sc, 15).target !== null) used++;
    }
    expect(used).toBeGreaterThan(3);
    expect(used).toBeLessThan(20);
  });

  it('16 / 17 梦游、陷害：最恨的人优先；手里有复仇卡的（公开手牌）不选', () => {
    const sc = setup([17], (s) => {
      s.players[0]!.hostility[2] = 30;
    });
    expect(judge(sc, 17).target).toEqual({ t: 'actor', actor: { t: 'seat', seat: 2 } });
    sc.give(2, { cards: [18] }).give(1, { cards: [18] });
    expect(judge(sc, 17).target).toBeNull();
  });

  it('22 送神符：身上有坏神或炸弹才用', () => {
    expect(judge(setup([22]).attachGod(0, 7), 22).target).toEqual({ t: 'none' });
    expect(judge(setup([22]).attachGod(0, 1), 22).target).toBeNull();
  });

  it('23 请神符：身上没有好神，且视野内最近的神是财神、福神或土地公', () => {
    expect(judge(setup([23]).placeGod(1, 6 + 1), 23).target).toEqual({ t: 'none' });
    expect(judge(setup([23]).placeGod(1, 9).placeGod(5, 7), 23).target).toBeNull();
  });

  it('24 红卡：开市日我持仓市值最大、未涨停的一支；没有持仓不用', () => {
    const sc = setup([24], (s) => hold(s, 0, 4, 100));
    expect(judge(sc, 24).target).toEqual({ t: 'stock', stock: 4 });
    expect(judge(setup([24]), 24).target).toBeNull();
  });

  it('25 黑卡：最恨的人持仓市值最大的一支（我没持有）', () => {
    const sc = setup([25], (s) => {
      hold(s, 1, 3, 100);
      s.players[0]!.hostility[1] = 5;
    });
    expect(judge(sc, 25).target).toEqual({ t: 'stock', stock: 3 });
    expect(judge(setup([25]), 25).target).toBeNull();
  });

  it('26 查税：最恨的人现金 > 30000·PI；否则视野内现金 > 50000·PI 的下标最大者', () => {
    const sc = setup([26], (s) => {
      s.players[0]!.hostility[1] = 5;
    });
    expect(judge(sc, 26).target).toEqual({ t: 'seat', seat: 1 });
    const poor = setup([26], (s) => {
      cash(s, 1, 100);
      cash(s, 2, 100);
    });
    expect(judge(poor, 26).target).toBeNull();
  });

  it('27 涨价：我在该街等级和 ≥7、对手 ≤3、占比 ≥66%', () => {
    const edit = (lv: number) => (s: GameState) => {
      own(s, 'L1', 0, lv);
      own(s, 'L2', 0, 4);
      own(s, 'L3', 1, 1);
    };
    expect(judge(setup([27], edit(3)), 27).target).toEqual({ t: 'lot', lot: 'L1', facility: null });
    expect(judge(setup([27], edit(2)), 27).target).toBeNull();
  });

  it('28 查封：前方 6 格内某街我没有地、对手等级和 ≥7', () => {
    const edit = (lv: number) => (s: GameState) => {
      own(s, 'L4', 1, lv);
      own(s, 'L5', 2, 4);
    };
    expect(judge(setup([28], edit(3)), 28).target).toEqual({ t: 'lot', lot: 'L4', facility: null });
    expect(judge(setup([28], edit(2)), 28).target).toBeNull();
  });

  it('29 同盟：视野内不是最恨的人、没和我结盟的，取地产最多者', () => {
    const sc = setup([29], (s) => {
      own(s, 'L4', 2, 1);
      s.players[0]!.hostility[1] = 9;
    });
    expect(judge(sc, 29).target).toEqual({ t: 'seat', seat: 2 });
    const hated = setup([29], (s) => {
      s.players[0]!.hostility[1] = 9;
      s.players[0]!.hostility[2] = 1;
      s.players[0]!.alliance = { seat: 2, days: 3 };
      s.players[2]!.alliance = { seat: 0, days: 3 };
    });
    expect(judge(hated, 29).target).toBeNull();
  });

  it('30 乌龟：前方 3 格没有岔路且都是可买 / 可加盖的格、钱够', () => {
    const yes = setup([30], (s) => own(s, 'L1', 0, 1));
    expect(judge(yes, 30).target).toEqual({ t: 'actor', actor: { t: 'seat', seat: 0 } });
    const no = setup([30], (s) => {
      own(s, 'L2', 1, 5);
      own(s, 'L3', 1, 5);
    });
    expect(judge(no, 30).target).toBeNull();
  });

  it('18–21 被动卡：从不主动出', () => {
    const sc = setup([18, 19, 20, 21]);
    for (const c of [18, 19, 20, 21] as CardId[]) expect(judge(sc, c).target).toBeNull();
  });
});
