// M11 压测热点分析：读 node --cpu-prof 生成的 .cpuprofile，打印 self / inclusive 时间 Top N，
// 以及最长的连续忙碌段（非 idle 样本连成的段，近似「阻塞事件循环」的长任务）和段内的主要函数。
// 用法：node test/m11-cpuprofile-top.mjs <file.cpuprofile> [topN=30]
import { readFileSync } from 'node:fs';

const [file, topArg] = process.argv.slice(2);
const TOP = Number(topArg ?? 30);
const prof = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const short = (url) => (url ? url.replace(/^.*\/(node_modules|apps|packages)\//, '$1/') : '');
const label = (n) => {
  const cf = n.callFrame;
  return `${cf.functionName || '(anonymous)'} ${short(cf.url)}:${cf.lineNumber + 1}`;
};

// 每个样本的时长
const dt = prof.timeDeltas;
const samples = prof.samples;
const total = (prof.endTime - prof.startTime) / 1000;
const self = new Map();
const incl = new Map();
let idle = 0;
let gc = 0;
for (let i = 0; i < samples.length; i++) {
  const ms = (dt[i + 1] ?? 0) / 1000;
  const n = nodes.get(samples[i]);
  const name = n.callFrame.functionName;
  if (name === '(idle)') idle += ms;
  if (name === '(garbage collector)') gc += ms;
  const l = label(n);
  self.set(l, (self.get(l) ?? 0) + ms);
  const seen = new Set();
  for (let id = samples[i]; id !== undefined; id = parent.get(id)) {
    const k = label(nodes.get(id));
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + ms);
  }
}
const busy = total - idle;
console.log(`总时长 ${(total / 1000).toFixed(1)}s，忙 ${(busy / 1000).toFixed(1)}s（${((busy / total) * 100).toFixed(1)}%），GC ${(gc / 1000).toFixed(2)}s`);
const top = (m, title) => {
  console.log(`\n── ${title}（ms，占忙碌时间 %）`);
  for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
    console.log(`${v.toFixed(0).padStart(8)}  ${((v / busy) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
};
top(self, 'self time Top');
top(incl, 'inclusive time Top');

// 连续忙碌段
const segs = [];
let cur = null;
let t = prof.startTime / 1000;
for (let i = 0; i < samples.length; i++) {
  t += dt[i] / 1000;
  const n = nodes.get(samples[i]);
  const isIdle = n.callFrame.functionName === '(idle)';
  if (!isIdle) {
    if (!cur) cur = { start: t, end: t, ids: [] };
    cur.end = t + (dt[i + 1] ?? 0) / 1000;
    cur.ids.push(samples[i]);
  } else if (cur) {
    segs.push(cur);
    cur = null;
  }
}
if (cur) segs.push(cur);
console.log('\n── 最长的连续忙碌段（ms，相对 profile 开始的秒数）');
for (const s of segs.sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 12)) {
  const cnt = new Map();
  for (const id of s.ids) {
    // 取栈上第一个项目自己的函数（apps/ 或 packages/）作为归因
    let k = null;
    for (let x = id; x !== undefined; x = parent.get(x)) {
      const u = nodes.get(x).callFrame.url;
      if (u.includes('/apps/') || u.includes('/packages/') || u.includes('main.mjs')) {
        k = label(nodes.get(x));
        break;
      }
    }
    k ??= label(nodes.get(id));
    cnt.set(k, (cnt.get(k) ?? 0) + 1);
  }
  const heads = [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 4);
  console.log(
    `${(s.end - s.start).toFixed(0).padStart(6)}ms @${((s.start - prof.startTime / 1000) / 1000).toFixed(1)}s  ` +
      heads.map(([k, v]) => `${k}×${v}`).join(' | '),
  );
}
