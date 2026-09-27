// 调试（A13）：企鹅底图（Panel#80 图0）HUD 白框里预画数字的包围盒，用来确定 Panel#79 数字的贴点（不输出像素文件）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPng } from '../tools/extract/src/assets/pngRead';

const root = 'rich4-assets';
const m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

function load(lp: string): { atlas: any; img: ReturnType<typeof readPng> } {
  const f = m.files[lp];
  const atlas = JSON.parse(readFileSync(join(root, f.path), 'utf8'));
  const img = readPng(readFileSync(join(root, f.path.slice(0, f.path.lastIndexOf('/') + 1) + atlas.meta.image)));
  return { atlas, img };
}

const p80 = load('sprites/panel/80.json');
const fr = p80.atlas.frames['Panel#80/0'].frame;
const dark = (x: number, y: number): boolean => {
  const i = ((fr.y + y) * p80.img.w + fr.x + x) * 4;
  return p80.img.rgba[i]! + p80.img.rgba[i + 1]! + p80.img.rgba[i + 2]! < 300;
};
for (const bx of [48, 67, 93, 112, 184, 203, 548, 567, 587]) {
  let x0 = 999;
  let y0 = 999;
  let x1 = -1;
  let y1 = -1;
  for (let y = 419; y < 452; y++)
    for (let x = bx; x < bx + 19; x++) {
      if (!dark(x, y)) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  console.log('box', bx, 'dark bbox', x0, y0, x1, y1);
}
const p79 = load('sprites/panel/79.json');
for (const n of ['Panel#79/8', 'Panel#79/1']) {
  const d = p79.atlas.frames[n].frame;
  let x0 = 999;
  let y0 = 999;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < d.h; y++)
    for (let x = 0; x < d.w; x++) {
      const i = ((d.y + y) * p79.img.w + d.x + x) * 4;
      const r = p79.img.rgba;
      if (r[i + 3]! > 0 && r[i]! + r[i + 1]! + r[i + 2]! < 300) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  console.log(n, 'dark bbox', x0, y0, x1, y1);
}
