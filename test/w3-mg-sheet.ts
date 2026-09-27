// 调试（A13）：把本机素材包里某个 Panel 精灵的帧按放大倍率排成一张联系表，输出到 .cache/w3-mg/（不入库）。
// 用法：npx tsx test/w3-mg-sheet.ts <Panel号> [倍率=3] [列数=8] [起始帧] [帧数]
// 每帧格子左上角画帧号（3×5 点阵），锚点画成红色十字。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPng } from '../tools/extract/src/assets/pngRead';
import { encodePngRgba } from '../tools/extract/src/gfx/png';

const DIGITS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

const [, , resArg, scaleArg = '3', colsArg = '8', startArg, countArg] = process.argv;
const res = Number(resArg);
const scale = Number(scaleArg);
const cols = Number(colsArg);
const root = 'rich4-assets';
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const lp = process.env.MKF === "data" ? `sprites/data/${res}.json` : `sprites/panel/${res}.json`;
const f = manifest.files[lp];
const atlas = JSON.parse(readFileSync(join(root, f.path), 'utf8'));
const dir = f.path.slice(0, f.path.lastIndexOf('/') + 1);
const img = readPng(readFileSync(join(root, dir + atlas.meta.image)));
const names = Object.keys(atlas.frames).sort((a, b) => Number(a.split('/')[1]) - Number(b.split('/')[1]));
const start = startArg ? Number(startArg) : 0;
const count = countArg ? Number(countArg) : names.length - start;
const sel = names.slice(start, start + count);
let cw = 0;
let ch = 0;
for (const n of sel) {
  cw = Math.max(cw, atlas.frames[n].frame.w);
  ch = Math.max(ch, atlas.frames[n].frame.h);
}
const cellW = cw * scale + 4;
const cellH = ch * scale + 16;
const rows = Math.ceil(sel.length / cols);
const W = cellW * Math.min(cols, sel.length);
const H = cellH * rows;
const out = new Uint8Array(W * H * 4);
const put = (x: number, y: number, r: number, g: number, b: number): void => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  out[i] = r;
  out[i + 1] = g;
  out[i + 2] = b;
  out[i + 3] = 255;
};
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, 40, 40, 48);
sel.forEach((n, k) => {
  const fr = atlas.frames[n].frame;
  const ox = (k % cols) * cellW + 2;
  const oy = Math.floor(k / cols) * cellH + 14;
  for (let y = 0; y < fr.h * scale; y++)
    for (let x = 0; x < fr.w * scale; x++) {
      const checker = ((x >> 3) + (y >> 3)) % 2 === 0 ? 150 : 110;
      const sx = fr.x + Math.floor(x / scale);
      const sy = fr.y + Math.floor(y / scale);
      const i = (sy * img.w + sx) * 4;
      const a = img.rgba[i + 3]! / 255;
      put(
        ox + x,
        oy + y,
        Math.round(img.rgba[i]! * a + checker * (1 - a)),
        Math.round(img.rgba[i + 1]! * a + checker * (1 - a)),
        Math.round(img.rgba[i + 2]! * a + checker * (1 - a)),
      );
    }
  const ap = atlas.meta.r4.anchorsPx[n];
  if (ap) {
    const ax = ox + ap[0] * scale;
    const ay = oy + ap[1] * scale;
    for (let d = -4; d <= 4; d++) {
      put(ax + d, ay, 255, 0, 0);
      put(ax, ay + d, 255, 0, 0);
    }
  }
  const label = n.split('/')[1]!;
  [...label].forEach((c, ci) => {
    const g = DIGITS[c]!;
    for (let yy = 0; yy < 5; yy++)
      for (let xx = 0; xx < 3; xx++)
        if (g[yy]![xx] === '1')
          for (let q = 0; q < 4; q++) put(ox + ci * 8 + xx * 2 + (q & 1), oy - 12 + yy * 2 + (q >> 1), 255, 230, 0);
  });
});
mkdirSync('.cache/w3-mg', { recursive: true });
const file = `.cache/w3-mg/panel${res}${startArg ? `-${start}` : ''}.png`;
writeFileSync(file, encodePngRgba(W, H, out));
console.log(file, W, H);
