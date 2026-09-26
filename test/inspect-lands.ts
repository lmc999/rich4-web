// 临时调试：列出住宅地相对前沿格的方向与 facing
import { readFileSync } from 'node:fs';
import { buildMapDef } from '../tools/extract/src/map/build';
import { parseOverrides } from '../tools/extract/src/map/overrides';

const raw = JSON.parse(readFileSync('.cache/extract/raw/v206-mapdat/map0.raw.json', 'utf8'));
const r = buildMapDef(
  raw,
  parseOverrides(JSON.parse(readFileSync('tools/extract/maps/taiwan.overrides.json', 'utf8'))),
  { mapKey: 'taiwan' },
);
const byId = new Map(r.def.tiles.map((t) => [t.id, t]));
const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
let off = 0;
for (const l of r.def.lots) {
  if (l.kind !== 'land') continue;
  const f = byId.get(l.frontTiles[0]!)!;
  const dx = l.rect.x - f.cell.x,
    dy = l.rect.y - f.cell.y;
  const d = dy < 0 ? 'N' : dx > 0 ? 'E' : dy > 0 ? 'S' : 'W';
  const fac = names[l.facing!]!;
  const ok = fac.includes(d);
  if (!ok) off++;
  if (!ok || process.argv.includes('--all'))
    console.log(
      l.id,
      'front',
      f.id,
      JSON.stringify(f.cell),
      'dir',
      d,
      'facing',
      fac,
      ok ? '' : '  <-- off side',
      'links',
      f.links
        .map(
          (x) =>
            `${x.to}${x.via ? '(via ' + x.via.map((c) => c.x + ',' + c.y).join(' ') + ')' : ''}@${JSON.stringify(byId.get(x.to)!.cell)}`,
        )
        .join(' '),
    );
}
console.log('off-side lands', off);
