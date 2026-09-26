// 调试脚本：打印真实引擎自对弈的事件序列（M3 第二部分前端主循环参考）
import { intentRng, newGame, randomAction } from '../packages/shared/src/engine/testing/index';

const g = newGame({ players: ['human', 'ai', 'human', 'ai'], seed: 'abcd' });
let s = g.state;
console.log(
  'initial pending',
  s.pending.map((d) => `${d.seat}:${d.kind}`),
);
const rng = intentRng('1234');
for (let i = 0; i < 40 && s.status === 'playing'; i++) {
  const a = randomAction(s, rng)!;
  const r = g.engine.applyAction(s, a);
  console.log(`#${i} ${a.seat} ${a.type}`, r.events.map((e) => e.type + (e.post ? '*' : '')).join(' '));
  s = r.state;
  console.log(
    '   pending',
    s.pending.map((d) => `${d.seat}:${d.kind}`),
  );
}
