// 临时调试：探索台湾节点坐标的格点参数（只读 .cache 中的 raw JSON，只打印统计）
import { readFileSync } from 'node:fs';

const r = JSON.parse(readFileSync('.cache/extract/raw/v206-mapdat/map0.raw.json', 'utf8'));
const nodes = r.nodes;
const edges = [];
for (const n of nodes) for (const a of n.adj) if (a > n.id) edges.push([n.id, a]);
const byId = new Map(nodes.map((n) => [n.id, n]));
for (const T of [16, 20, 24, 28, 30, 32, 33, 34, 36, 40, 44, 48]) {
  let best = null;
  for (let ox = 0; ox < T; ox += 1)
    for (let oy = 0; oy < T; oy += 1) {
      const cell = (n) => [Math.round((n.x - ox) / T), Math.round((n.y - oy) / T)];
      const seen = new Map();
      let coll = 0;
      for (const n of nodes) {
        const k = cell(n).join(',');
        if (seen.has(k)) coll++;
        else seen.set(k, n.id);
      }
      const cls = { unit: 0, diag: 0, long: 0, other: 0, zero: 0 };
      let viaSum = 0;
      for (const [a, b] of edges) {
        const ca = cell(byId.get(a)),
          cb = cell(byId.get(b));
        const dx = Math.abs(ca[0] - cb[0]),
          dy = Math.abs(ca[1] - cb[1]);
        if (dx + dy === 0) cls.zero++;
        else if (dx + dy === 1) cls.unit++;
        else if (dx === 1 && dy === 1) cls.diag++;
        else if (dx === 0 || dy === 0) cls.long++;
        else cls.other++;
        viaSum += Math.max(0, dx + dy - 1);
      }
      const score = coll * 1000 + cls.zero * 1000 + viaSum;
      if (!best || score < best.score) best = { score, ox, oy, coll, cls, viaSum };
    }
  console.log(T, JSON.stringify(best));
}
// 方向分类
const dirs = {};
for (const [a, b] of edges) {
  const A = byId.get(a),
    B = byId.get(b);
  const dx = B.x - A.x,
    dy = B.y - A.y;
  const ax = Math.abs(dx),
    ay = Math.abs(dy);
  const k = ay <= 0.414 * ax ? 'H' : ax <= 0.414 * ay ? 'V' : 'D';
  const len = Math.sqrt(dx * dx + dy * dy);
  dirs[k] = dirs[k] ?? [];
  dirs[k].push(Math.floor(len));
}
for (const [k, v] of Object.entries(dirs)) console.log(k, v.length, v.sort((a, b) => a - b).join(' '));
