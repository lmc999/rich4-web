// 调研脚本：打印 .cache/maps/<key>.map.json 某区域的网格占用（路格号 / v=连接格 / 地块 id / 景观 S<n>），并给出格点坐标换算（lattice = grid − shift）。
// 用法：node test/maps-grid-ascii.mjs china 12 28 26 38   （key x0 y0 x1 y1，网格坐标）
import { readFileSync } from 'node:fs';
const [key, x0, y0, x1, y1] = process.argv.slice(2);
const d = JSON.parse(readFileSync(`.cache/maps/${key}.map.json`, 'utf8'));
const b = JSON.parse(readFileSync(`.cache/maps/${key}.build.json`, 'utf8'));
const sh = b.geometry.bounds.shift;
const lab = new Map();
for (const t of d.tiles) lab.set(`${t.cell.x},${t.cell.y}`, String(t.id));
for (const c of d.roadCells) if (!lab.has(`${c.x},${c.y}`)) lab.set(`${c.x},${c.y}`, 'v');
const rect = (id, r) => {
  for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) lab.set(`${x},${y}`, id);
};
for (const l of d.lots) rect(l.id, l.rect);
for (const c of d.companies) rect(c.id, c.rect);
for (const m of d.landmarks) rect(`S${m.id}`, m.rect);
console.log(`${key} shift ${JSON.stringify(sh)}（lattice = grid − shift）`);
let hdr = '      ';
for (let x = +x0; x <= +x1; x++) hdr += String(x).padStart(5);
console.log(hdr);
for (let y = +y0; y <= +y1; y++) {
  let row = `y${String(y).padStart(3)}  `;
  for (let x = +x0; x <= +x1; x++) row += (lab.get(`${x},${y}`) ?? '.').padStart(5);
  console.log(row);
}
