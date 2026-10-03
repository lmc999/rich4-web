// 调试：fixture 'test' 的监狱 / 医院景观（合成皮肤取地标矩形中心 × 32）到关押格的世界距离，与设施地的门前格（architecture §32 的浏览器测试用）。
// 用法（仓库根目录）：npx tsx test/jail-walkout-fixture-dist.ts
import { buildTestMap } from '@rich4/shared/data';
const def = buildTestMap();
for (const l of def.landmarks) {
  if (l.kind === 'scenery') continue;
  const w = { x: (l.rect.x + l.rect.w / 2) * 32, y: (l.rect.y + l.rect.h / 2) * 32 };
  const t = def.tiles.find((x) => x.id === l.holdTile)!;
  console.log(l.kind, l.rect, w, t.id, t.world, Math.hypot(t.world.x - w.x, t.world.y - w.y));
}
console.log(def.tiles.filter((t) => t.ref?.lot?.startsWith('F')).map((t) => [t.id, t.ref?.lot]));
console.log(def.lots.filter((l) => l.kind === 'facility').map((l) => [l.id, l.world, l.frontTiles]));
