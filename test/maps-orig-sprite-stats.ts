// 调试脚本：列出 map.mkf 住宅 27–46、企业/景观 69–149 的 SPR 帧数与主人色（索引 255）像素数，核对其余 3 张图的建筑精灵。
// 用法：npx tsx test/maps-orig-sprite-stats.ts
import { readFileSync } from 'node:fs';
import { countOwnerPixels, parseSpr } from '../tools/extract/src/gfx/spr';
import { MkfArchive } from '../tools/extract/src/mkf/container';

const map = MkfArchive.open(readFileSync('original/Game/map.mkf'), 'map');
const rows: string[] = [];
for (const res of [...Array.from({ length: 20 }, (_, i) => 27 + i), ...Array.from({ length: 81 }, (_, i) => 69 + i)]) {
  const e = map.entry(res);
  const sh = parseSpr(map.read(res), `map#${res}`);
  rows.push(`map#${res} kind=${e.kind} frames=${sh.count} owner=${countOwnerPixels(sh)}`);
}
console.log(rows.join('\n'));
for (const res of [0, 2, 4, 6, 8, 9, 10, 11]) {
  const e = map.entry(res);
  console.log(`map#${res} kind=${e.kind} raw=${e.rawSize} compressed=${e.compressed}`);
}
