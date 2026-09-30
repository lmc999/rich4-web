/**
 * 调研脚本：把 .cache/maps/<key>.map.json（test/maps-other-build.ts 的产物）连同 rich4-data 里的 taiwan 打成一个
 * 临时数据包 .cache/maps/data/（manifest.json + maps/*.map.json），格式与 `extract pack` 相同，供 sim / 服务器调研使用。
 * 不写 rich4-data/。用法（仓库根）：npx tsx test/maps-pack-cache.ts
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../tools/extract/src/io/writeCanonicalJson';
import { buildManifest, type ManifestMapEntry, manifestEntry } from '../tools/extract/src/map/pack';

const out = '.cache/maps/data';
mkdirSync(path.join(out, 'maps'), { recursive: true });
const entries: ManifestMapEntry[] = [];
const sources: [string, string][] = [
  ['taiwan', 'rich4-data/maps/taiwan.map.json'],
  ['china', '.cache/maps/china.map.json'],
  ['japan', '.cache/maps/japan.map.json'],
  ['usa', '.cache/maps/usa.map.json'],
];
for (const [key, file] of sources) {
  if (!existsSync(file)) {
    console.log(`跳过 ${key}：没有 ${file}`);
    continue;
  }
  const text = readFileSync(file, 'utf8');
  const { entry } = manifestEntry(text, []);
  copyFileSync(file, path.join(out, entry.file));
  entries.push(entry);
  console.log(`${key} mapHash ${entry.mapHash} validation ${JSON.stringify(entry.validation)}`);
}
writeFileSync(path.join(out, 'manifest.json'), canonicalJson(buildManifest(entries)));
console.log(`→ ${out}/manifest.json`);
