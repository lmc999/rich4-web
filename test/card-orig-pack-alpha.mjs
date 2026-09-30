// 调试脚本（卡片取证）：统计素材包 rich4-assets 里 card.<k> PNG 的透明像素数，并与原版 RAW16 的 0 值像素数对照
// 用法：node test/card-orig-pack-alpha.mjs
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
const m = JSON.parse(readFileSync('rich4-assets/manifest.json', 'utf8'));
const out = [];
for (let k = 1; k <= 30; k++) {
  const e = m.entries[`card.${k}`];
  const f = m.files[e.file];
  const png = PNG.sync.read(readFileSync(`rich4-assets/${f.path}`));
  let clear = 0;
  let semi = 0;
  for (let p = 0; p < png.width * png.height; p++) {
    const a = png.data[p * 4 + 3];
    if (a === 0) clear++;
    else if (a < 255) semi++;
  }
  out.push(`card.${k} ${e.src[0]} ${png.width}x${png.height} transparency=${e.transparency} confidence=${e.confidence} alpha0=${clear} semi=${semi}`);
}
console.log(out.join('\n'));
