// M11：打印 .cpuprofile 某个时间段（秒）内样本的调用链归类（root 之下第 1–2 层 + 第一个项目内函数）。
// 用法：node test/m11-cpuprofile-window.mjs <file.cpuprofile> <从秒> <到秒>
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
for (let i = 0; i < prof.samples.length; i++) {
  t += prof.timeDeltas[i] / 1000;
  const rel = (t - prof.startTime / 1000) / 1000;
  if (rel < Number(from) || rel > Number(to)) continue;
  const chain = [];
  for (let x = prof.samples[i]; x !== undefined; x = parent.get(x)) chain.unshift(x);
  if (nodes.get(chain.at(-1)).callFrame.functionName === '(idle)') continue;
  const own = chain.filter((x) => nodes.get(x).callFrame.url.includes('main.mjs')).map(name);
  const k = `${chain.slice(1, 3).map(name).join(' > ')} || ${own.slice(0, 4).join(' > ')}`;
  cnt.set(k, (cnt.get(k) ?? 0) + (prof.timeDeltas[i + 1] ?? 0) / 1000);
}
for (const [k, v] of [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${v.toFixed(0).padStart(6)}ms  ${k}`);
