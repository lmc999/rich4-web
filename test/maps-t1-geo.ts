/**
 * T1 调试脚本：读 .cache/extract/maps/<key>.{map,build}.json（npm run extract -- map build 的产物），
 * 打印偏侧住宅地与 W_TILES_TOUCH 周围的格点坐标网格（overrides 用的坐标系：lattice = grid − shift）。
 *
 * 用法（仓库根）：npx tsx test/maps-t1-geo.ts <key> [--r 4] [--at x,y]...
 *   格子标记：路格号 / v=连接格 / L12=住宅地 / F3 设施 / C1 企业 / S5 景观 / *=期望格（want）
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: { r: { type: 'string' }, at: { type: 'string', multiple: true } },
});
const key = positionals[0] ?? 'china';
const R = Number(v.r ?? 4);
type Cell = { x: number; y: number };
const d = JSON.parse(readFileSync(`.cache/extract/maps/${key}.map.json`, 'utf8'));
const b = JSON.parse(readFileSync(`.cache/extract/maps/${key}.build.json`, 'utf8'));
const g = b.geometry;
const sh: Cell = g.bounds.shift;
const lat = g.lattice;
const toLat = (c: Cell): Cell => ({ x: c.x - sh.x, y: c.y - sh.y });
const wantOf = (w: Cell): Cell => ({
  x: Math.floor((w.x - lat.origin[0]) / lat.tile + 0.5),
  y: Math.floor((w.y - lat.origin[1]) / lat.tile + 0.5),
});
const lab = new Map<string, string>();
const k = (c: Cell) => `${c.x},${c.y}`;
for (const t of d.tiles) lab.set(k(toLat(t.cell)), String(t.id));
for (const c of d.roadCells) if (!lab.has(k(toLat(c)))) lab.set(k(toLat(c)), 'v');
const rect = (id: string, r: { x: number; y: number; w: number; h: number }) => {
  for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) lab.set(k(toLat({ x, y })), id);
};
for (const l of d.lots) rect(l.id, l.rect);
for (const c of d.companies) rect(c.id, c.rect);
for (const m of d.landmarks) rect(`S${m.id}`, m.rect);
const tileById = new Map<number, { id: number; cell: Cell; links: { to: number; via?: Cell[] }[] }>(
  d.tiles.map((t: { id: number }) => [t.id, t]),
);

function window(center: Cell, marks: Map<string, string> = new Map()): void {
  let hdr = '       ';
  for (let x = center.x - R; x <= center.x + R; x++) hdr += String(x).padStart(5);
  console.log(hdr);
  for (let y = center.y - R; y <= center.y + R; y++) {
    let row = `  y${String(y).padStart(3)} `;
    for (let x = center.x - R; x <= center.x + R; x++) {
      const m = marks.get(k({ x, y }));
      const l = lab.get(k({ x, y })) ?? '.';
      row += (m ? `${l === '.' ? '' : l}${m}` : l).padStart(5);
    }
    console.log(row);
  }
}

const DIRN = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
console.log(
  `${key}: shift (${sh.x},${sh.y}) 原点 (${lat.origin.join(',')}) T=${lat.tile}；offSide ${g.landsOffSide.join(',') || '-'}；relaxed ${g.landsRelaxed.join(',') || '-'}`,
);
for (const id of g.landsOffSide as string[]) {
  const l = d.lots.find((x: { id: string }) => x.id === id);
  const front = tileById.get(l.frontTiles[0])!;
  const want = wantOf(l.world);
  const at = toLat({ x: l.rect.x, y: l.rect.y });
  const fc = toLat(front.cell);
  console.log(
    `\n== ${id} 前沿 ${l.frontTiles.join(',')} @(${fc.x},${fc.y}) facing ${l.facing}(${DIRN[l.facing]}) 期望格 (${want.x},${want.y}) 实际 (${at.x},${at.y}) 街 ${l.streetId}`,
  );
  window(fc, new Map([[k(want), '*']]));
}
for (const [a, bb] of g.unlinkedAdjacent as [number, number][]) {
  const ca = toLat(tileById.get(a)!.cell);
  console.log(`\n== W_TILES_TOUCH ${a}/${bb} @(${ca.x},${ca.y})`);
  window(ca);
}
for (const s of v.at ?? []) {
  const [x, y] = s.split(',').map(Number) as [number, number];
  console.log(`\n== (${x},${y})`);
  window({ x, y });
}
