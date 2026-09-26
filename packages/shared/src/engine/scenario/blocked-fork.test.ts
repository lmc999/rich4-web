import { describe, expect, it } from 'vitest';
import { scenario } from '../testing/scenario';

/**
 * 静态封路与死路（architecture §5.1 TileLink.blocked；§7.2）：
 * - fixture 'test' 的 04→19 被封：从 4（来路 3）只能到 5；反方向 19→4 可走（捷径只能从 13 进入）。
 * - fixture 'test-allkinds' 的 26 是死路：候选为空就掉头回来路，且不消耗随机数。
 */
describe('场景：封路的岔路与死路', () => {
  it('4（来路 3）永远走向 5，不会进入被封的 19', () => {
    for (let i = 0; i < 20; i++) {
      const sc = scenario({ players: ['human', 'human'], seed: (0x2000 + i).toString(16), checkInvariants: false })
        .untilMenu(0)
        .teleport(0, 4, 3)
        .force('dice', 1)
        .roll(0);
      expect(sc.event('MOVE_SEGMENT').path).toEqual([5]);
    }
  });

  it('被封的是 4→19 这个方向：19→4 照常可走，到 4 后在 5 与 3 之间随机', () => {
    const sc = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .teleport(0, 20, 13)
      .force('fork', 0, 0, 1)
      .force('dice', 3)
      .roll(0);
    expect(sc.event('MOVE_SEGMENT').path).toEqual([19, 4, 3]);
  });

  it('死路掉头：26 没有前进候选，回到 25；掉头不消耗 fork 值', () => {
    const sc = scenario({ map: 'test-allkinds', players: ['human', 'human'] })
      .untilMenu(0)
      .teleport(0, 25, 24)
      .force('fork', 0, 0, 0)
      .force('dice', 3)
      .roll(0);
    expect(sc.event('MOVE_SEGMENT').path).toEqual([26, 25, 24]);
    // 25→26、26→25（掉头，不耗）、25→24 共消耗 2 个，剩 1 个
    expect(sc.state.secret.debugQueue).toEqual([{ purpose: 'fork', values: [0] }]);
  });

  it('via 长边：22 与 23 之间经过两个连接格，但行走只算 1 步', () => {
    const sc = scenario({ map: 'test-allkinds', players: ['human', 'human'] })
      .untilMenu(0)
      .teleport(0, 22, 21)
      .force('dice', 1)
      .roll(0);
    expect(sc.event('MOVE_SEGMENT').path).toEqual([23]);
    expect(sc.event('POINTS_GAINED')).toMatchObject({ seat: 0, amount: 10, source: 'square' });
  });
});
