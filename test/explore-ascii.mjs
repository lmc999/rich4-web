// 临时调试：按给定 T/offset 量化并打印 ASCII（节点编号、住宅地期望格）
import { readFileSync } from 'node:fs';

const [T, ox, oy] = (process.argv[2] ?? '48,1,26').split(',').map(Number);
const r = JSON.parse(readFileSync('.cache/extract/raw/v206-mapdat/map0.raw.json', 'utf8'));
const cell = (p) => [Math.round((p.x - ox) / T), Math.round((p.y - oy) / T)];
const grid = new Map();
const put = (c, s) => {
  const k = c.join(',');
  grid.set(k, (grid.get(k) ? grid.get(k) + '|' : '') + s);
};
for (const n of r.nodes) put(cell(n), String(n.id).padStart(3));
for (const l of r.lands) put(cell(l), 'L' + String(l.id).padStart(2));
for (const f of r.facilities) put(cell(f), 'F' + f.id + ' ');
for (const c of r.companies) put(cell(c), 'C' + c.id + ' ');
for (const s of r.landscapes) put(cell(s), 'S' + String(s.id).padStart(2));
let minx = 1e9,
  miny = 1e9,
  maxx = -1e9,
  maxy = -1e9;
for (const k of grid.keys()) {
  const [x, y] = k.split(',').map(Number);
  minx = Math.min(minx, x);
  maxx = Math.max(maxx, x);
  miny = Math.min(miny, y);
  maxy = Math.max(maxy, y);
}
console.log('x', minx, maxx, 'y', miny, maxy);
for (let y = miny; y <= maxy; y++) {
  let line = String(y).padStart(3) + ' ';
  for (let x = minx; x <= maxx; x++) {
    const v = grid.get(x + ',' + y);
    line += v ? (v.length > 3 ? '#' + v.slice(-3) : v.padStart(4)) : '   .';
  }
  console.log(line);
}
for (const [k, v] of grid) if (v.includes('|')) console.log('collide', k, v);
