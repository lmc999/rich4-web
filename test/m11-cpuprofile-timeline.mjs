// M11：.cpuprofile 时间线——每 100ms 的忙碌比例（找周期性尖峰），以及指定函数名出现的时刻。
// 用法：node test/m11-cpuprofile-timeline.mjs <file.cpuprofile> [函数名子串...]
import { readFileSync } from 'node:fs';

const [file, ...needles] = process.argv.slice(2);
const prof = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const BUCKET = 100;
const buckets = new Map();
const hits = new Map(needles.map((n) => [n, []]));
let t = prof.startTime / 1000;
for (let i = 0; i < prof.samples.length; i++) {
  t += prof.timeDeltas[i] / 1000;
  const rel = t - prof.startTime / 1000;
  const n = nodes.get(prof.samples[i]);
  const ms = (prof.timeDeltas[i + 1] ?? 0) / 1000;
  const b = Math.floor(rel / BUCKET);
  if (n.callFrame.functionName !== '(idle)') buckets.set(b, (buckets.get(b) ?? 0) + ms);
  for (const nd of needles) {
    for (let x = prof.samples[i]; x !== undefined; x = parent.get(x)) {
      if (nodes.get(x).callFrame.functionName.includes(nd)) {
        const arr = hits.get(nd);
        if (arr.length === 0 || rel - arr.at(-1) > 50) arr.push(rel);
        break;
      }
    }
  }
}
const hot = [...buckets].filter(([, v]) => v > 60).sort((a, b) => a[0] - b[0]);
console.log('忙碌 > 60% 的 100ms 桶（秒）：', hot.map(([b, v]) => `${(b / 10).toFixed(1)}:${v.toFixed(0)}`).join(' '));
for (const [nd, arr] of hits) console.log(`${nd}：`, arr.map((x) => (x / 1000).toFixed(2)).join(' '));
