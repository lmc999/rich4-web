// 调试（只读调研）：用空 overrides 把原版大陆 / 日本 / 美国图（gm 1/2/3）构建成 MapDef，
// 写到 .cache/maps/engine-probe/（manifest.json + maps/<key>.map.json，gitignore），供引擎 sim / 数据注册表试跑。
// 不改仓库文件，不写 rich4-data/。raw 取自 npm run extract -- map raw 的缓存；股票 / 节日取 .cache/extract/tables.v206.json。
//
//   npx tsx test/maps-engine-probe-build.ts [--with-taiwan]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { holidaysForMap, stocksForMap } from '../tools/extract/src/exe/mapData';
import { buildMapDef } from '../tools/extract/src/map/build';
import { emptyOverrides, parseOverrides } from '../tools/extract/src/map/overrides';
import { buildManifest, manifestEntry } from '../tools/extract/src/map/pack';
import { canonicalJson } from '../tools/extract/src/io/writeCanonicalJson';

const OUT = '.cache/maps/engine-probe';
const MAPS: { key: string; gm: number }[] = [
  { key: 'china', gm: 1 },
  { key: 'japan', gm: 2 },
  { key: 'usa', gm: 3 },
];
if (process.argv.includes('--with-taiwan')) MAPS.unshift({ key: 'taiwan', gm: 0 });

const tables = JSON.parse(readFileSync('.cache/extract/tables.v206.json', 'utf8'));
mkdirSync(join(OUT, 'maps'), { recursive: true });
const entries = [];
for (const { key, gm } of MAPS) {
  const raw = JSON.parse(readFileSync(`.cache/extract/raw/v206-mapdat/map${gm}.raw.json`, 'utf8'));
  const ov =
    key === 'taiwan'
      ? parseOverrides(JSON.parse(readFileSync('tools/extract/maps/taiwan.overrides.json', 'utf8')))
      : emptyOverrides(key, 'v206-mapdat');
  const r = buildMapDef(raw, ov, {
    mapKey: key,
    stocks: stocksForMap(tables, gm),
    holidays: holidaysForMap(tables, gm).holidays,
  });
  const geoErr = r.geometry.report.issues.filter((i) => i.severity === 'error');
  const byClass: Record<string, number> = {};
  for (const i of r.classified) byClass[`${i.class}:${i.code}`] = (byClass[`${i.class}:${i.code}`] ?? 0) + 1;
  console.log(`== ${key} (gm ${gm}) grid ${r.def.grid.w}x${r.def.grid.h} exit ${r.exitCode}`);
  console.log('  counts', JSON.stringify(r.def.meta.counts));
  console.log('  geometry errors', geoErr.length, geoErr.slice(0, 6).map((i) => `${i.code} ${i.msg}`));
  console.log('  semantic issues', r.semantic.issues.map((i) => `${i.severity}:${i.code}`).join(' '));
  console.log('  validateMap', JSON.stringify(byClass));
  for (const i of r.classified.filter((x) => x.class === 'error').slice(0, 12)) {
    console.log(`    [error] ${i.code} ${i.path}: ${i.msg}`);
  }
  const text = canonicalJson(r.def);
  writeFileSync(join(OUT, 'maps', `${key}.map.json`), text);
  try {
    const { entry } = manifestEntry(text, r.semantic.pending);
    entries.push(entry);
  } catch (e) {
    // 几何未 override 时 validateMap 有 E_LOT_FRONT_NOT_ADJ：sim 不做 validateMap，只需要 id / file
    console.log('  manifestEntry failed（仍写入最小条目供 sim 使用）', String(e));
    entries.push({ id: key, file: `maps/${key}.map.json`, probeOnly: true } as never);
  }
}
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(buildManifest(entries), null, 2)}\n`);
console.log(`→ ${OUT}`);
