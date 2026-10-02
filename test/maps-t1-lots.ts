/**
 * T1 调试脚本：列出 .cache/extract/maps/<key>.map.json 中指定地块的前沿格、facing、期望格与实际格（格点坐标）。
 * 用法（仓库根）：npx tsx test/maps-t1-lots.ts <key> L36 L38 ...
 */
import { readFileSync } from 'node:fs';

const [key, ...ids] = process.argv.slice(2);
const d = JSON.parse(readFileSync(`.cache/extract/maps/${key}.map.json`, 'utf8'));
const b = JSON.parse(readFileSync(`.cache/extract/maps/${key}.build.json`, 'utf8'));
const g = b.geometry;
const sh = g.bounds.shift;
const lat = g.lattice;
const DIRN = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const tile = new Map(d.tiles.map((t: { id: number; cell: { x: number; y: number } }) => [t.id, t]));
for (const id of ids) {
  const l = [...d.lots, ...d.companies].find((x: { id: string }) => x.id === id);
  if (!l) {
    console.log(`${id}: 不存在`);
    continue;
  }
  const want = {
    x: Math.floor((l.world.x - lat.origin[0]) / lat.tile + 0.5),
    y: Math.floor((l.world.y - lat.origin[1]) / lat.tile + 0.5),
  };
  const fronts = l.frontTiles
    .map((t: number) => {
      const c = (tile.get(t) as { cell: { x: number; y: number } }).cell;
      return `${t}@(${c.x - sh.x},${c.y - sh.y})`;
    })
    .join(' ');
  console.log(
    `${id} 前沿 ${fronts} facing ${l.facing}(${DIRN[l.facing]}) 世界 (${l.world.x},${l.world.y}) 期望 (${want.x},${want.y}) 实际 [${l.rect.x - sh.x},${l.rect.y - sh.y},${l.rect.w},${l.rect.h}] 街 ${l.streetId ?? '-'}`,
  );
}
