// 调研（出卡插画，只读）：把素材包里 card.1..card.30（Data#530–559）按卡号排成 6×5 的对照图，并统计每张的透明像素，
// 输出到 .cache/card/current/card-art-sheet.png 与 card-art-stats.json（含原版素材，不入库）。
// 用法：node test/card-art-sheet.mjs [素材包目录=rich4-assets]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const DIR = process.argv[2] ?? 'rich4-assets';
const OUT = '.cache/card/current';
mkdirSync(OUT, { recursive: true });
const m = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const W = 165;
const H = 256;
const COLS = 6;
const GAP = 8;
const sheet = new PNG({ width: COLS * (W + GAP) + GAP, height: 5 * (H + GAP) + GAP });
// 底色洋红：透明处一眼可见
for (let i = 0; i < sheet.data.length; i += 4) sheet.data.set([255, 0, 255, 255], i);
const stats = [];
for (let k = 1; k <= 30; k++) {
  const e = m.entries[`card.${k}`];
  const f = m.files[e.file];
  const png = PNG.sync.read(readFileSync(join(DIR, f.path)));
  let transparent = 0;
  let semi = 0;
  const corners = [];
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const a = png.data[(y * png.width + x) * 4 + 3];
      if (a === 0) transparent++;
      else if (a < 255) semi++;
    }
  for (const [x, y] of [
    [0, 0],
    [png.width - 1, 0],
    [0, png.height - 1],
    [png.width - 1, png.height - 1],
    [Math.floor(png.width / 2), Math.floor(png.height / 2)],
  ]) {
    const i = (y * png.width + x) * 4;
    corners.push(Array.from(png.data.subarray(i, i + 4)));
  }
  stats.push({ card: k, key: `card.${k}`, src: e.src, file: f.path, w: png.width, h: png.height, transparent, semi, corners });
  const ox = GAP + ((k - 1) % COLS) * (W + GAP);
  const oy = GAP + Math.floor((k - 1) / COLS) * (H + GAP);
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const si = (y * png.width + x) * 4;
      const a = png.data[si + 3];
      if (a === 0) continue;
      const di = ((oy + y) * sheet.width + ox + x) * 4;
      sheet.data.set([png.data[si], png.data[si + 1], png.data[si + 2], 255], di);
    }
}
writeFileSync(join(OUT, 'card-art-sheet.png'), PNG.sync.write(sheet));
writeFileSync(join(OUT, 'card-art-stats.json'), JSON.stringify(stats, null, 1));
for (const s of stats) console.log(s.key, s.src.join(), `${s.w}x${s.h}`, 'transparent', s.transparent, 'corners', JSON.stringify(s.corners));
