// M11：统计某函数（在调用链上出现）的样本时间，按「秒内相位」（模 10 秒）聚合，看是否有周期性堆积。
// 用法：node test/m11-cpuprofile-periodic.mjs <file.cpuprofile> <函数名> [周期秒=10] [从秒=25]
import { readFileSync } from 'node:fs';

const [file, fn, periodArg, fromArg] = process.argv.slice(2);
const period = Number(periodArg ?? 10) * 1000;
const from = Number(fromArg ?? 25) * 1000;
const prof = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const has = new Map();
const hit = (id) => {
  if (has.has(id)) return has.get(id);
  let r = false;
  for (let x = id; x !== undefined; x = parent.get(x)) if (nodes.get(x).callFrame.functionName === fn) r = true;
  has.set(id, r);
  return r;
};
const bins = new Array(20).fill(0);
let t = prof.startTime / 1000;
for (let i = 0; i < prof.samples.length; i++) {
  t += prof.timeDeltas[i] / 1000;
  const rel = t - prof.startTime / 1000;
  if (rel < from || !hit(prof.samples[i])) continue;
  bins[Math.floor(((rel % period) / period) * 20)] += (prof.timeDeltas[i + 1] ?? 0) / 1000;
}
console.log(bins.map((v, i) => `${((i * period) / 20 / 1000).toFixed(1)}s:${v.toFixed(0)}`).join('  '));
