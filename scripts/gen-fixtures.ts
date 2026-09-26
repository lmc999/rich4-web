/**
 * 生成入库的 fixture 地图 JSON（packages/shared/src/data/maps/fixtures/*.json）。
 * 用法：npm run fixtures（= tsx scripts/gen-fixtures.ts）；加 --check 只比对不写入，有差异时退出码 1。
 * 输出由 shared 的 ASCII 生成器确定性产出，重复运行字节一致。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtureMaps, FIXTURE_FILES, fixtureJson, validateMap } from '@rich4/shared/data';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'packages/shared/src/data/maps/fixtures');
const check = process.argv.includes('--check');

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

let stale = 0;
for (const def of buildFixtureMaps()) {
  const res = validateMap(def, { strict4: true });
  if (!res.ok) {
    const errors = res.issues.filter((i) => i.severity === 'error');
    console.error(`fixture ${def.id} fails validateMap:`, errors);
    process.exit(2);
  }
  const file = FIXTURE_FILES[def.id];
  if (!file) throw new Error(`no fixture file name for map ${def.id}`);
  const path = join(outDir, file);
  const text = fixtureJson(def);
  const rel = relative(root, path);
  if (readOrNull(path) === text) {
    console.log(`unchanged ${rel} (dataHash ${def.meta.dataHash})`);
    continue;
  }
  stale++;
  if (check) {
    console.error(`stale ${rel}`);
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${rel} (dataHash ${def.meta.dataHash})`);
  }
}
if (check && stale > 0) process.exit(1);
