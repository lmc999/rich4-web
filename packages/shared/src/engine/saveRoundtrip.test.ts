import { describe, expect, it } from 'vitest';
import { newGame, stateHash } from './testing/builders';
import { intentRng, randomAction } from './testing/randomIntent';
import type { GameAction } from './types/intent';
import type { GameState } from './types/state';

/**
 * 存档往返（design/engine.md §16.4）：在任意 pending 处 JSON(parse(stringify)) 后继续执行，
 * 结果与不存档一致；往返后的 state 也能通过 validateState 与 migrateState(v1)。
 */
describe('存档往返后继续', () => {
  it('在第 k 个决策处存读档，后续 200 步的哈希与事件与不存档完全一致', { timeout: 120_000 }, () => {
    const g = newGame({ players: ['human', 'ai', 'human'], seed: '5a7e', config: { timeLimitDays: 0 } });
    const rng = intentRng('77');
    const actions: GameAction[] = [];
    const states: GameState[] = [g.state];
    let s = g.state;
    for (let i = 0; i < 260 && s.status === 'playing'; i++) {
      const a = randomAction(s, rng)!;
      actions.push(a);
      s = g.engine.applyAction(s, a).state;
      states.push(s);
    }
    for (const k of [0, 1, 7, 33, 58]) {
      const saved = JSON.stringify(states[k]);
      const loaded = g.engine.migrateState(JSON.parse(saved), 1);
      expect(g.engine.validateState(loaded)).toBe(true);
      expect(stateHash(loaded)).toBe(stateHash(states[k]));
      let x = loaded;
      for (let i = k; i < Math.min(actions.length, k + 200); i++) {
        const r = g.engine.applyAction(x, actions[i]!);
        x = r.state;
        expect(stateHash(x)).toBe(stateHash(states[i + 1]));
      }
    }
  });
});
