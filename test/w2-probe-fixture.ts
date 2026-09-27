// 调试：打印 fixture 地图的几何（A6 原版棋盘用）
import { buildFixtureMaps } from '@rich4/shared/data';

for (const d of buildFixtureMaps()) {
  console.log(
    d.id,
    d.grid,
    d.tiles.length,
    d.tiles.slice(0, 3).map((t) => ({ id: t.id, cell: t.cell, world: t.world, kind: t.kind, lc: t.landingCode })),
  );
  console.log(d.lots.slice(0, 2).map((l) => ({ id: l.id, world: l.world, rect: l.rect, facing: l.facing, kind: l.kind })));
  console.log(d.companies.map((c) => ({ id: c.id, world: c.world, rect: c.rect, facing: c.facing })));
  console.log(d.landmarks.map((l) => ({ id: l.id, kind: l.kind, rect: l.rect })));
  console.log(
    'boat',
    d.tiles.filter((t) => ((t.src?.flags ?? 0) & 0x80000000) !== 0).map((t) => t.id),
  );
}
