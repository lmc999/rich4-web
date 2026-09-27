import { newGame } from '../packages/shared/src/engine/testing/builders';
import { intentRng, randomAction } from '../packages/shared/src/engine/testing/randomIntent';
import { performance } from 'node:perf_hooks';
for (const human of [false, true]) {
  const t0 = performance.now();
  let n = 0;
  for (let seed = 0; seed < 6; seed++) {
    const players = human ? (['human', 'ai', 'human', 'ai'] as const) : (['ai', 'ai', 'ai', 'ai'] as const);
    const g = newGame({ players: [...players], seed: (0xf00d + seed).toString(16), config: { timeLimitDays: 0 }, devChecks: true, rules: { timeMachine: process.env.TM as 'global' ?? 'global' } });
    const rng = intentRng((0xbeef + seed).toString(16));
    let state = g.state;
    for (let i = 0; i < 300 && state.status === 'playing'; i++) {
      const a = randomAction(state, rng)!;
      state = g.engine.applyAction(state, a).state;
      n++;
    }
    if (human) console.log('anchor size', JSON.stringify(state.secret.timeAnchor ?? {}).length, 'state', JSON.stringify(state).length);
  }
  console.log(human ? 'human' : 'ai', n, ((performance.now() - t0) / n).toFixed(3), 'ms/action');
}
