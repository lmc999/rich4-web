import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../../data/maps/registry';
import { ECON } from '../../data/tables/economy';
import { type XoshiroState, xoshiroRand15 } from '../../util/rng/xoshiro';
import { engineMap } from '../core/mapCache';
import { scenario } from '../testing/scenario';

const em = engineMap(fixtureRegistry.getMap('test'));

/**
 * engine.md §7.2 回合开始的随机数次序：步骤 0 跳伞（2 次 'parachute'）先于步骤 1 refreshQuota（每支流通股 > 1000
 * 的股票 1 次 'quota'）。事件次序不变：TURN_STARTED 之后才是 PARACHUTE。
 */
describe('场景：首回合随机数次序（跳伞 → 可买量）', () => {
  it('1 号座位首回合：前两次取数决定落点与来路，其后才是可买量', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 4, 3).force('dice', 1).roll(0).expectAsk(0, 'BUY_LAND');
    expect(sc.player(1).placed).toBe(false);
    const rng = structuredClone(sc.state.secret.rng) as XoshiroState;
    const taken = new Set(sc.state.objects.map((o) => o.node));
    const tiles = em.index.placeableTiles().filter((t) => !taken.has(t));
    const node = tiles[xoshiroRand15(rng) % tiles.length]!;
    const nb = em.neighbors(node);
    const prev = nb[xoshiroRand15(rng) % nb.length]!;
    const quota = sc.state.stocks.map((st) =>
      st.float <= ECON.QUOTA_FLOAT_MIN
        ? st.float
        : Math.floor((st.float * (ECON.QUOTA_BASE + (xoshiroRand15(rng) % ECON.QUOTA_RANGE))) / ECON.QUOTA_DEN),
    );

    sc.decline(0);
    const types = sc.events.map((e) => e.type);
    expect(types.indexOf('PARACHUTE')).toBeGreaterThan(types.lastIndexOf('TURN_STARTED'));
    expect(sc.event('PARACHUTE')).toMatchObject({ seat: 1, node, prev });
    expect(sc.player(1)).toMatchObject({ placed: true, node, prevNode: prev });
    expect(sc.player(1).quota).toEqual(quota);
    expect(sc.state.secret.rng).toEqual(rng);
  });
});
