import { describe, expect, it } from 'vitest';
import { xoshiroNext32 } from '../../util/rng/xoshiro';
import { scenario } from '../testing/scenario';

/**
 * 岔路随机（architecture §7.2；g_arbitration §2.m）：候选按槽序去掉来路与封路，取 候选[rand15()%n]；
 * 只有 1 个候选也消耗一次随机数；没有任何选路决策。
 * fixture 'test'：13（来路 12）的候选按槽序为 [20(N), 14(W)]。
 */
describe('场景：随机岔路', () => {
  it('强制 fork 下标决定走向；第一步（单候选）也消耗一个 fork 值', () => {
    const toNorth = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .teleport(0, 12, 11)
      .force('fork', 0, 0)
      .force('dice', 2)
      .roll(0);
    expect(toNorth.event('MOVE_SEGMENT').path).toEqual([13, 20]);

    const toWest = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .teleport(0, 12, 11)
      .force('fork', 0, 1)
      .force('dice', 2)
      .roll(0);
    expect(toWest.event('MOVE_SEGMENT').path).toEqual([13, 14]);

    // 单候选那一步只接受下标 0：若把 1 放在第一个，会在第一步就被消耗并判为非法
    const bad = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .teleport(0, 12, 11)
      .force('fork', 1)
      .force('dice', 2);
    expect(() => bad.roll(0)).toThrow(/BAD_FORCED_VALUE/);
  });

  it('单候选的一步恰好消耗一次底层随机数', () => {
    // 先让两人都跳过伞（首回合跳伞也取随机数）
    const sc = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .roll(0)
      .untilMenu(1)
      .roll(1)
      .untilMenu(0);
    // 其余取数全部强制：骰子，以及下一位回合开始时刷新 12 支股票的可买量
    sc.teleport(0, 12, 11)
      .force('dice', 1)
      .force('quota', ...new Array<number>(12).fill(0));
    const before = sc.state.secret.rng.slice() as [number, number, number, number];
    sc.roll(0);
    expect(sc.event('MOVE_SEGMENT').path).toEqual([13]);
    xoshiroNext32(before);
    expect(sc.state.secret.rng).toEqual(before);
  });

  it('不强制时两条岔路都会出现（按种子分布）', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 40 && seen.size < 2; i++) {
      const sc = scenario({ players: ['human', 'human'], seed: (0x1000 + i).toString(16), checkInvariants: false })
        .untilMenu(0)
        .teleport(0, 12, 11)
        .force('dice', 2)
        .roll(0);
      seen.add(sc.event('MOVE_SEGMENT').path[1]!);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([14, 20]);
  });

  it('没有选路决策：移动全程不产生任何待决策，直到落点', () => {
    const sc = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .teleport(0, 12, 11)
      .force('dice', 6)
      .roll(0);
    expect(sc.event('MOVE_SEGMENT').path).toHaveLength(6);
    expect(sc.events.filter((e) => e.type === 'MOVE_SEGMENT')).toHaveLength(1);
  });
});
