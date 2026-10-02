// 调试脚本（T2 地图素材）：资源目录自检、覆盖率、排除段与分组计数。用法：npx tsx test/maps-t2-catalog-check.ts
import { catalogCoverage, catalogV206, validateCatalog, unreferencedLandmarks } from '../tools/extract/src/assets/catalog.v206';
const c = catalogV206();
console.log(validateCatalog(c));
const cov = catalogCoverage(c);
console.log(cov.totals, cov.percent);
console.log(c.exclusions.map(e=>`${e.mkf}#${e.from}-${e.to}`).join(' '));
console.log(unreferencedLandmarks());
const groups = new Map<string, number>();
for (const it of c.items) groups.set(it.group, (groups.get(it.group) ?? 0) + 1);
console.log([...groups].filter(([g]) => g.startsWith('map.') || g.startsWith('board') || g.startsWith('illustration') || g==='title'));
console.log(c.items.filter(it=>it.group==='board.landmarks').map(it=>it.res));
