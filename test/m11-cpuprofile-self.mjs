// M11：某时间段（秒）内的 self 时间 Top（叶子函数 + 其最近的项目内调用者），找长任务里真正耗时的位置。
// 用法：node test/m11-cpuprofile-self.mjs <file.cpuprofile> <从秒> <到秒>
import { readFileSync } from 'node:fs';

const [file, from, to] = process.argv.slice(2);
const prof = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const name = (id) => {
  const cf = nodes.get(id).callFrame;
  return `${cf.functionName || '(anon)'}:${cf.lineNumber + 1}`;
};
const cnt = new Map();
let t = prof.startTime / 1000;
const big = [];
for (let i = 0; i < prof.samples.length; i++) {
  t += prof.timeDeltas[i] / 1000;
  const rel = (t - prof.startTime / 1000) / 1000;
  if (rel < Number(from) || rel > Number(to)) continue;
  const id = prof.samples[i];
  if (nodes.get(id).callFrame.functionName === '(idle)') continue;
  const ms = (prof.timeDeltas[i + 1] ?? 0) / 1000;
  const chain = [];
  for (let x = id; x !== undefined; x = parent.get(x)) chain.push(name(x));
  const k = chain.slice(0, 5).join(' < ');
  cnt.set(k, (cnt.get(k) ?? 0) + ms);
  if (ms > 5) big.push(`${rel.toFixed(3)}s ${ms.toFixed(1)}ms ${chain.slice(0, 8).join(' < ')}`);
}
for (const [k, v] of [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`${v.toFixed(1).padStart(7)}ms  ${k}`);
console.log('\n单个样本 > 5ms：');
for (const b of big.slice(0, 20)) console.log(b);
