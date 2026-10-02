/**
 * T1 调试脚本：列出 .cache/extract/maps/<key>.map.json 中指定路格的世界坐标、格点坐标（浮点与量化后）与连边。
 * 用法（仓库根）：npx tsx test/maps-t1-tiles.ts <key> 74 75 76 ...   或   <key> 74-80
 */
import { readFileSync } from 'node:fs';

const [key, ...args] = process.argv.slice(2);
const ids = args.flatMap((a) => {
  const m = /^(\d+)-(\d+)$/.exec(a);
  if (!m) return [Number(a)];
  const out: number[] = [];
  for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i);
  return out;
});
const d = JSON.parse(readFileSync(`.cache/extract/maps/${key}.map.json`, 'utf8'));
const b = JSON.parse(readFileSync(`.cache/extract/maps/${key}.build.json`, 'utf8'));
const sh = b.geometry.bounds.shift;
const lat = b.geometry.lattice;
for (const id of ids) {
  const t = d.tiles.find((x: { id: number }) => x.id === id);
  if (!t) continue;
  const fx = (t.world.x - lat.origin[0]) / lat.tile;
  const fy = (t.world.y - lat.origin[1]) / lat.tile;
  const links = t.links
    .map(
      (l: { to: number; via?: { x: number; y: number }[]; blocked: boolean }) =>
        `${l.to}${l.blocked ? '(封)' : ''}${l.via ? `via[${l.via.map((c) => `${c.x - sh.x},${c.y - sh.y}`).join(' ')}]` : ''}`,
    )
    .join(' ');
  console.log(
    `${String(id).padStart(3)} 世界 (${t.world.x},${t.world.y}) 格点 (${fx.toFixed(2)},${fy.toFixed(2)}) → (${t.cell.x - sh.x},${t.cell.y - sh.y}) ${t.kind} 连 ${links}`,
  );
}
