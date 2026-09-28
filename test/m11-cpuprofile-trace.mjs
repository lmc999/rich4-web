// M11：逐样本打印某时间段（秒）内的时间、样本时长、叶子与最近的项目内函数，看长任务之前发生了什么。
// 用法：node test/m11-cpuprofile-trace.mjs <file.cpuprofile> <从秒> <到秒>
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
let t = prof.startTime / 1000;
let lastKey = '';
for (let i = 0; i < prof.samples.length; i++) {
  t += prof.timeDeltas[i] / 1000;
  const rel = (t - prof.startTime / 1000) / 1000;
  if (rel < Number(from) || rel > Number(to)) continue;
  const id = prof.samples[i];
  const chain = [];
  for (let x = id; x !== undefined; x = parent.get(x)) chain.push(x);
  const top = chain.length > 2 ? name(chain.at(-2)) : '';
  const own = chain.find((x) => nodes.get(x).callFrame.url.includes('main.mjs'));
  const key = `${name(id)} | ${top} | ${own ? name(own) : ''}`;
  const ms = (prof.timeDeltas[i + 1] ?? 0) / 1000;
  if (key !== lastKey || ms > 3) console.log(`${rel.toFixed(3)} ${ms.toFixed(1).padStart(5)}ms  ${key}`);
  lastKey = key;
}
