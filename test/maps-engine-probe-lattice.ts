// 调试（只读调研）：打印四张图 map build 的格点参数（T、原点、变换）与网格尺寸，核对「台湾 48 像素一格」类常量
import { readFileSync } from 'node:fs';
import { buildMapDef } from '../tools/extract/src/map/build';
import { emptyOverrides, parseOverrides } from '../tools/extract/src/map/overrides';

for (const [key, gm] of [['taiwan', 0], ['china', 1], ['japan', 2], ['usa', 3]] as const) {
  const raw = JSON.parse(readFileSync(`.cache/extract/raw/v206-mapdat/map${gm}.raw.json`, 'utf8'));
  const ov =
    key === 'taiwan'
      ? parseOverrides(JSON.parse(readFileSync('tools/extract/maps/taiwan.overrides.json', 'utf8')))
      : emptyOverrides(key, 'v206-mapdat');
  const r = buildMapDef(raw, ov, { mapKey: key });
  const g = r.geometry.report;
  const xs = r.def.tiles.map((t) => t.world.x);
  const ys = r.def.tiles.map((t) => t.world.y);
  console.log(
    key,
    'lattice',
    JSON.stringify({ mode: g.lattice.mode, tile: g.lattice.tile, origin: g.lattice.origin, transform: g.lattice.transform, cov32: g.lattice.probe32.coverage }),
    'grid',
    `${r.def.grid.w}x${r.def.grid.h}`,
    'world x',
    Math.min(...xs),
    Math.max(...xs),
    'y',
    Math.min(...ys),
    Math.max(...ys),
    'diag',
    g.routes.diagonal,
    'via',
    g.routes.viaCells,
  );
}
