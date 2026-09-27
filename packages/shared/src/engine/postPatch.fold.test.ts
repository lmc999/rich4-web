import { describe, expect, it } from 'vitest';
import { applyPostPatch, diffPublic, foldPosts, publicWorld } from './core/postPatch';
import { newGame } from './testing/builders';
import { intentRng, randomAction } from './testing/randomIntent';
import type { PublicWorld } from './types/state';

/**
 * 跨包一致性（architecture §8「postPatch.fold.test.ts」）：20 个种子 × 300 个 action，
 * 逐个 action 断言 fold(applyPostPatch, publicWorld(prev), events) ≡ publicWorld(next)，且不出现 SYNC。
 * 客户端 viewFold.test.ts 用同一个 applyPostPatch。
 */
function snapshot(w: PublicWorld): PublicWorld {
  return JSON.parse(JSON.stringify(publicWorld(w))) as PublicWorld;
}

describe('post 折叠一致性', () => {
  it('20 个种子 × 300 个 action：fold(applyPostPatch) == publicWorld(next)，没有 SYNC', { timeout: 120_000 }, () => {
    let actions = 0;
    let events = 0;
    for (let seed = 0; seed < 20; seed++) {
      const players = seed % 3 === 0 ? (['human', 'ai', 'human', 'ai'] as const) : (['human', 'ai', 'ai'] as const);
      const g = newGame({
        players: [...players],
        seed: (0xf00d + seed).toString(16),
        config: { timeLimitDays: 0, vehicle: seed % 2 === 0 ? 'walk' : 'car' },
      });
      const rng = intentRng((0xbeef + seed).toString(16));
      let state = g.state;
      for (let i = 0; i < 300 && state.status === 'playing'; i++) {
        const a = randomAction(state, rng)!;
        const prev = snapshot(state);
        const r = g.engine.applyAction(state, a);
        expect(r.events.some((e) => e.type === 'SYNC')).toBe(false);
        const folded = foldPosts(prev, r.events);
        expect(folded).toEqual(snapshot(r.state));
        state = r.state;
        actions++;
        events += r.events.length;
      }
    }
    expect(actions).toBeGreaterThan(5000);
    expect(events).toBeGreaterThan(actions);
  });

  it('diffPublic / applyPostPatch 的基本性质', () => {
    const { state } = newGame();
    const a = snapshot(state);
    expect(diffPublic(a, a)).toBeUndefined();
    expect(applyPostPatch(a, undefined)).toBe(a);
    const b = JSON.parse(JSON.stringify(a)) as PublicWorld;
    b.players[1]!.cash = 1;
    b.lands[2]!.owner = 1;
    b.clock.turnNo = 99;
    b.objects.push({ id: 1, kind: 'mine', node: 3, placedBy: 0 });
    const p = diffPublic(a, b)!;
    expect(p.players).toEqual([{ seat: 1, set: { cash: 1 } }]);
    expect(p.lands).toEqual([{ id: 'L3', set: { owner: 1 } }]);
    expect(p.clock).toEqual({ turnNo: 99 });
    expect(p.objects).toHaveLength(a.objects.length + 1);
    expect(p.econ).toBeUndefined();
    const c = applyPostPatch(a, p);
    expect(c).toEqual(b);
    // 未变的实体保持引用，入参不被修改
    expect(c.players[0]).toBe(a.players[0]);
    expect(a.players[1]!.cash).not.toBe(1);
    // post 的值是深拷贝：之后再改 b 不影响 post
    b.players[1]!.cash = 2;
    expect(p.players![0]!.set.cash).toBe(1);
  });
});
