// 临时调试：对 .cache 中的台湾 raw 跑 build，打印统计（不写任何文件）
import { readFileSync } from 'node:fs';
import { buildMapDef } from '../tools/extract/src/map/build';
import { emptyOverrides, parseOverrides } from '../tools/extract/src/map/overrides';

const raw = JSON.parse(readFileSync('.cache/extract/raw/v206-mapdat/map0.raw.json', 'utf8'));
const ovArg = process.argv[2];
const ov = ovArg ? parseOverrides(JSON.parse(readFileSync(ovArg, 'utf8'))) : emptyOverrides('taiwan', 'v206-mapdat');
const r = buildMapDef(raw, ov, { mapKey: 'taiwan', strict4: true });
const g = r.geometry.report;
console.log(
  'lattice',
  g.lattice.mode,
  g.lattice.tile,
  g.lattice.origin,
  JSON.stringify(g.lattice.score),
  JSON.stringify(g.lattice.steps),
);
console.log('routes', JSON.stringify(g.routes), JSON.stringify(g.edgeKinds));
console.log('facing', JSON.stringify(g.facing));
console.log('bounds', JSON.stringify(g.bounds), JSON.stringify(g.terrain));
for (const i of g.issues) console.log('GEO', i.severity, i.code, i.msg);
for (const i of r.semantic.issues) console.log('SEM', i.severity, i.code, i.msg);
const byCode: Record<string, number> = {};
for (const i of r.classified) byCode[`${i.class}:${i.code}`] = (byCode[`${i.class}:${i.code}`] ?? 0) + 1;
console.log('validate ok', r.validation.ok, JSON.stringify(byCode), 'exit', r.exitCode);
for (const i of r.classified.filter((x) => x.class === 'error' || x.class === 'contract'))
  console.log('  ', i.class, i.code, i.path, i.msg);
if (process.argv.includes('--ascii')) {
  const def = r.def;
  const grid: string[][] = def.terrain.map((row) =>
    [...row].map((c) => (c === 'w' ? ' ~' : c === 's' ? ' .' : c === 'm' ? ' ^' : ' ,')),
  );
  for (const c of def.roadCells) grid[c.y]![c.x] = ' +';
  for (const l of [...def.lots, ...def.companies])
    for (let y = l.rect.y; y < l.rect.y + l.rect.h; y++)
      for (let x = l.rect.x; x < l.rect.x + l.rect.w; x++)
        grid[y]![x] = l.id.startsWith('L') ? ' L' : l.id.startsWith('F') ? ' F' : ' C';
  for (const m of def.landmarks)
    for (let y = m.rect.y; y < m.rect.y + m.rect.h; y++)
      for (let x = m.rect.x; x < m.rect.x + m.rect.w; x++)
        grid[y]![x] = m.kind === 'scenery' ? ' S' : m.kind === 'jail' ? ' J' : ' H';
  for (const t of def.tiles) grid[t.cell.y]![t.cell.x] = String(t.id % 100).padStart(2, '0');
  console.log(grid.map((r2) => r2.join('')).join('\n'));
}
