// 临时调试脚本：粗略测量 applyInPlace / applyAction 的耗时分布
import { fixtureRegistry } from '../packages/shared/src/data/maps/registry';
import { internal } from '../packages/shared/src/engine/api';
import { makeConfig, makeSetups } from '../packages/shared/src/engine/testing/builders';
import { intentRng, randomAction } from '../packages/shared/src/engine/testing/randomIntent';

const e = internal.createEngine(fixtureRegistry);
let n = 0;
const t0 = performance.now();
for (let g = 0; g < 5; g++) {
  const s = e.createGame(
    makeConfig({ config: { timeLimitDays: 730 } }),
    makeSetups(['ai', 'ai', 'ai', 'ai']),
    (0x100 + g).toString(16),
  );
  const rng = intentRng('77' + g);
  while (s.status === 'playing') {
    e.applyInPlace(s, randomAction(s, rng)!);
    n++;
  }
}
const t1 = performance.now();
console.log('inPlace', n, ((t1 - t0) / n).toFixed(4), 'ms/action');
