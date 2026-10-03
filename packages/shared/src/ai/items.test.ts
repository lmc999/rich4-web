import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../data/maps/registry';
import { ITEM } from '../data/tables/ids';
import { engineMap } from '../engine/core/mapCache';
import { buildTurnMenu } from '../engine/decisions/build';
import { type Scenario, scenario } from '../engine/testing/scenario';
import { simpleView } from '../engine/testing/view';
import type { AiTraits, GameState, ItemId, SeatIndex, TurnMenuItemRow } from '../engine/types/index';
import type { GameView } from '../view/types';
import { ITEM_AI } from './items';
import { makeAiContext } from './rng';
import { AiView } from './view';

/**
 * 原版 AI 的用道具判据（design/minigames-ai.md §9.6）：每种至少一正一反。
 * 0 号是电脑，站在 5 号格（来路 4，前进方向 6 → 7 → …）；1 号在 6 号格，2 号在 16 号格。
 */
const map = fixtureRegistry.getMap('test');

function setup(items: { item: ItemId; qty?: number }[] = [], edit?: (s: GameState) => void): Scenario {
  const sc = scenario({ players: ['ai', 'human', 'human'] }).untilMenu(0);
  sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 16, 15);
  sc.give(0, { items: items.map((x) => ({ item: x.item, qty: x.qty ?? 1 })) });
  if (edit) sc.edit(edit);
  return sc;
}

const allkinds = fixtureRegistry.getMap('test-allkinds');

function judge(sc: Scenario, item: ItemId, traits: Partial<AiTraits> = {}, turnNo?: number, m = map) {
  const s = sc.state;
  const row = buildTurnMenu(s, engineMap(m), 0).items.find((r) => r.item === item) as TurnMenuItemRow;
  const p = s.players[0]!;
  const ctx = makeAiContext({
    aiSeed: s.secret.aiSeed,
    seat: 0,
    decisionId: 'd1',
    turnNo: turnNo ?? s.clock.turnNo,
    traits: { ...p.aiTraits, ...traits },
    map: m,
    handVisibility: 'public',
  });
  return ITEM_AI[item](new AiView(simpleView(s) as GameView, 0, m), row, ctx);
}

function own(s: GameState, lot: string, owner: SeatIndex | null, level: number): void {
  Object.assign(s.lands.find((l) => l.id === lot)!, { owner, level });
}

/** 对多个回合盐统计判据给出目标的次数 */
function hits(make: () => Scenario, item: ItemId, traits: Partial<AiTraits> = {}): number {
  let n = 0;
  for (let t = 0; t < 60; t++) if (judge(make(), item, traits, t) !== null) n++;
  return n;
}

describe('items（AI 用道具判据）', () => {
  it('1 机器娃娃：前方 4 格没有岔路、路上有坏神或恶犬 → 用；路上干净不用', () => {
    expect(judge(setup([]).placeGod(7, 7), ITEM.ROBOT_DOLL)).toEqual({ t: 'none' });
    expect(judge(setup([]), ITEM.ROBOT_DOLL)).toBeNull();
  });

  it('2 路障：前方第一个空格是无主地且我在同街 ≥2 块 → 放；否则看后方我的高租金街', () => {
    const yes = setup([], (s) => {
      own(s, 'L1', 0, 1);
      own(s, 'L3', 0, 1);
    });
    yes.teleport(1, 12, 11);
    expect(judge(yes, ITEM.ROADBLOCK)).toEqual({ t: 'node', node: 6 });
    expect(judge(setup([]), ITEM.ROADBLOCK)).toBeNull();
  });

  it('2 路障阶段二：后瞻是往回第 2–7 格（来路格不算）；同额按候选的屏幕行序取第一个（v3.11 0x4212ad）', () => {
    // 0 号在 8、来路 7：前瞻第一个空格 9 是魔法屋（阶段一不放）；7 号格 L3 是我的高租金地，但它是来路格，不在后瞻里
    const prevOnly = setup([], (s) => own(s, 'L3', 0, 4));
    prevOnly.teleport(0, 8, 7);
    expect(judge(prevOnly, ITEM.ROADBLOCK)).toBeNull();
    // 0 号在 4、来路 5（逆着走）：前瞻第一个空格 3 是命运（阶段一不放）；后瞻 [6, 7, 8, 9, 10, 11]，L2（6）与 L3（7）同街同额 →
    // 取候选行序靠前的 7（视角 0 里横街右高左低，x 大的先扫到），不是后瞻里更近的 6
    const tie = setup([], (s) => {
      own(s, 'L2', 0, 3);
      own(s, 'L3', 0, 3);
    });
    tie.teleport(1, 16, 15).teleport(0, 4, 5);
    expect(judge(tie, ITEM.ROADBLOCK)).toEqual({ t: 'node', node: 7 });
  });

  it('3 地雷：后瞻 6 格内对手的地块格随机取一；没有则不用', () => {
    const yes = setup([], (s) => own(s, 'L5', 1, 1));
    yes.teleport(0, 10, 11);
    expect(judge(yes, ITEM.MINE)).toEqual({ t: 'node', node: 12 });
    expect(judge(setup([]), ITEM.MINE)).toBeNull();
    // 来路格本身不在后瞻里：0 号在 10、来路 11（L4 是对手的），后瞻从 12 开始
    const prevOnly = setup([], (s) => own(s, 'L4', 1, 1));
    prevOnly.teleport(0, 10, 11);
    expect(judge(prevOnly, ITEM.MINE)).toBeNull();
  });

  it('4 定时炸弹：后瞻 6 格内任一空格', () => {
    expect(judge(setup([]), ITEM.TIME_BOMB)).toMatchObject({ t: 'node' });
    const blocked = setup([]);
    blocked.teleport(0, 1, 2);
    // 1 号格（银行，禁放）往回看 2、3、4…都是空格
    expect(judge(blocked, ITEM.TIME_BOMB)).toMatchObject({ t: 'node' });
  });

  it('5 / 6 机车、汽车：步行时 rng%4==0 才装备；已经开汽车不用汽车', () => {
    const moto = hits(() => setup([{ item: ITEM.MOTORCYCLE }]), ITEM.MOTORCYCLE);
    expect(moto).toBeGreaterThan(5);
    expect(moto).toBeLessThan(30);
    const inCar = () =>
      setup([{ item: ITEM.CAR }], (s) => {
        s.players[0]!.vehicle = 'car';
        s.pools.items[6] = s.pools.items[6]! - 1;
      });
    expect(hits(inCar, ITEM.CAR)).toBe(0);
  });

  it('7 飞弹：目标是视野内的最恨的人（爆风里有我或我的地产就放弃）', () => {
    const far = setup([{ item: ITEM.MISSILE }], (s) => {
      s.players[0]!.hostility[2] = 9;
    });
    expect(judge(far, ITEM.MISSILE)).toEqual({ t: 'node', node: 16 });
    const near = setup([{ item: ITEM.MISSILE }], (s) => {
      s.players[0]!.hostility[1] = 9;
    });
    expect(judge(near, ITEM.MISSILE)).toBeNull();
  });

  it('7 飞弹：最恨的人不在视野内就放弃（不改打视野内的别人）；没有最恨的人才从棋盘上的对手里随机抽', () => {
    // test-allkinds：0 号在 1 号格 (64,64)，1 号在 5 号格 (192,64)，2 号在 26 号格 (512,96)，在 440 视野外
    const mk = (hate: boolean) => () => {
      const sc = scenario({ map: 'test-allkinds', players: ['ai', 'human', 'human'] }).untilMenu(0);
      sc.teleport(0, 1, 18).teleport(1, 5, 4).teleport(2, 26, 25);
      sc.give(0, { items: [{ item: ITEM.MISSILE, qty: 1 }] });
      if (hate) sc.edit((s) => (s.players[0]!.hostility[2] = 999));
      return sc;
    };
    for (let t = 0; t < 10; t++) expect(judge(mk(true)(), ITEM.MISSILE, {}, t, allkinds)).toBeNull();
    const n = (() => {
      let k = 0;
      for (let t = 0; t < 60; t++) {
        const r = judge(mk(false)(), ITEM.MISSILE, {}, t, allkinds);
        if (r !== null) {
          expect(r).toEqual({ t: 'node', node: 5 });
          k++;
        }
      }
      return k;
    })();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(60);
  });

  it('8 遥控骰子：前方 6 格内同街我有 ≥2 块的无主地 → 定这个步数；钱不够不用', () => {
    const yes = setup([], (s) => {
      own(s, 'L1', 0, 1);
      own(s, 'L3', 0, 1);
    });
    expect(judge(yes, ITEM.REMOTE_DICE)).toEqual({ t: 'dice', value: 1 });
    const poor = setup([], (s) => {
      own(s, 'L1', 0, 1);
      own(s, 'L3', 0, 1);
      const p = s.players[0]!;
      s.econ.ledger.burned += p.cash + p.deposit - 100;
      p.cash = 100;
      p.deposit = 0;
    });
    expect(judge(poor, ITEM.REMOTE_DICE)).toBeNull();
  });

  it('9 机器工人：视野内我的可升级地产里租金最高的一块；只对自己的地用', () => {
    const yes = setup([], (s) => {
      own(s, 'L1', 0, 1);
      own(s, 'L2', 0, 3);
    });
    expect(judge(yes, ITEM.ROBOT_WORKER)).toEqual({ t: 'lot', lot: 'L2', facility: null });
    expect(
      judge(
        setup([], (s) => own(s, 'L4', 1, 1)),
        ITEM.ROBOT_WORKER,
      ),
    ).toBeNull();
  });

  it('10 时光机：从不使用', () => {
    expect(judge(setup([{ item: ITEM.TIME_MACHINE }]), ITEM.TIME_MACHINE)).toBeNull();
  });

  it('11 传送机：视野内无主、≥3 级、买得起的地 → 把自己传送到它门前', () => {
    const yes = setup([{ item: ITEM.TELEPORTER }], (s) => own(s, 'L4', null, 3));
    expect(judge(yes, ITEM.TELEPORTER)).toEqual({
      t: 'teleport',
      source: { k: 'actor', actor: { t: 'seat', seat: 0 } },
      dest: { k: 'road', node: 11 },
    });
    expect(judge(setup([{ item: ITEM.TELEPORTER }]), ITEM.TELEPORTER)).toBeNull();
  });

  it('12 工程车：没开工程车时 rng%15 ≤ 个性', () => {
    const mk = () => setup([{ item: ITEM.ENGINEERING_VEHICLE }]);
    expect(hits(mk, ITEM.ENGINEERING_VEHICLE, { personality: 2 })).toBeGreaterThan(
      hits(mk, ITEM.ENGINEERING_VEHICLE, { personality: 0 }),
    );
    const on = () =>
      setup([{ item: ITEM.ENGINEERING_VEHICLE }], (s) => {
        s.players[0]!.vehicle = 'engineer';
        s.players[0]!.engineer = { days: 3, restore: 'walk', dice: 1 };
      });
    expect(hits(on, ITEM.ENGINEERING_VEHICLE, { personality: 2 })).toBe(0);
  });

  it('13 核子飞弹：随机挑有主地产，找一个「我不在那一屏里」的；小地图上全在一屏里 → 不用', () => {
    const sc = setup([{ item: ITEM.NUKE }], (s) => own(s, 'L4', 1, 2));
    expect(judge(sc, ITEM.NUKE)).toBeNull();
  });

  it('13 核子飞弹（exe 0x421e62）：候选只取别人已有建筑的地产；窗内我的地产按块数与等级比例计入，不直接放弃', () => {
    // test-allkinds，2 人：0 号站在 26 号格 (512,96)，离所有住宅都超过 220
    const mk = (edit: (s: GameState) => void) => {
      const sc = scenario({ map: 'test-allkinds', players: ['ai', 'human'] }).untilMenu(0);
      sc.teleport(0, 26, 25)
        .teleport(1, 13, 12)
        .give(0, { items: [{ item: ITEM.NUKE, qty: 1 }] });
      return sc.edit(edit);
    };
    const all5 = (s: GameState) => {
      for (const id of ['L1', 'L2', 'L3', 'L4', 'L5']) own(s, id, 1, 1);
    };
    // 我有一块 0 级设施在窗内：1×4 < 5、0×4 < 5 → 仍发射
    const fire = judge(
      mk((s) => {
        all5(s);
        Object.assign(s.facilities[0]!, { owner: 0, level: 0 });
      }),
      ITEM.NUKE,
      {},
      undefined,
      allkinds,
    );
    expect(fire).toMatchObject({ t: 'node' });
    expect([5, 6, 7, 11, 12]).toContain(fire?.t === 'node' ? fire.node : -1);
    // 我的地产占比过高：1×4 < 5 但等级 3×4 ≥ 5 → 不发射
    const mineHeavy = mk((s) => {
      all5(s);
      Object.assign(s.facilities[0]!, { owner: 0, level: 3, type: 'hotel' });
    });
    expect(judge(mineHeavy, ITEM.NUKE, {}, undefined, allkinds)).toBeNull();
    // 只有我的地产、或别人的都是 0 级：没有候选
    const none = mk((s) => {
      own(s, 'L1', 0, 3);
      own(s, 'L4', 1, 0);
    });
    expect(judge(none, ITEM.NUKE, {}, undefined, allkinds)).toBeNull();
  });
});
