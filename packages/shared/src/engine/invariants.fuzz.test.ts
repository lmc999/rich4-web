import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { newGame } from './testing/builders';
import { candidateIntents } from './testing/randomIntent';
import type { GameAction } from './types/intent';

/**
 * 不变量与属性测试（architecture §8；design/engine.md §15、§16.4）：
 * 随机种子 × 随机合法 intent（从 options 里挑），每个 action 之后跑 validateState 的详细版，
 * 牌堆、道具池、股本、资金台账、地产、帧栈与待决策必须始终成立。
 */
describe('invariants fuzz（fast-check）', () => {
  it('随机对局每一步都满足全部不变量', { timeout: 120_000 }, () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9a-f]{1,8}$/),
        fc.constantFrom('test', 'test-allkinds'),
        fc.integer({ min: 2, max: 4 }),
        fc.array(fc.nat(), { minLength: 150, maxLength: 150 }),
        (seed, map, n, choices) => {
          const controllers = (['human', 'ai', 'ai', 'human'] as const).slice(0, n);
          const g = newGame({ map, seed, players: [...controllers], config: { timeLimitDays: 30 } });
          let s = g.state;
          for (const c of choices) {
            if (s.status !== 'playing') break;
            const d = s.pending[c % s.pending.length]!;
            const cands = candidateIntents(d);
            const intent = cands[c % cands.length]!;
            s = g.engine.applyAction(s, { ...intent, seat: d.seat, decisionId: d.id } as GameAction).state;
            const bad = g.engine.explainState(s);
            if (bad.length > 0) throw new Error(`seed ${seed} map ${map}: ${bad.join('; ')}`);
          }
          expect(s.status === 'playing' || s.result !== null).toBe(true);
        },
      ),
      { numRuns: 25, seed: 20260927 },
    );
  });

  it('限时对局一定结束（30 天）', { timeout: 120_000 }, () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-f]{2,6}$/), (seed) => {
        const g = newGame({ seed, players: ['ai', 'ai', 'ai'], config: { timeLimitDays: 30 }, devChecks: false });
        let s = g.state;
        for (let i = 0; i < 3000 && s.status === 'playing'; i++) {
          const d = s.pending[0]!;
          s = g.engine.applyAction(s, { ...d.defaultIntent, seat: d.seat, decisionId: d.id } as GameAction).state;
        }
        expect(s.status).toBe('over');
        expect(s.result?.elapsedDays).toBeLessThanOrEqual(30);
      }),
      { numRuns: 10, seed: 7 },
    );
  });
});
