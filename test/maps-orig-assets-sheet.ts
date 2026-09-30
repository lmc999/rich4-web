// 调试脚本：把 test/maps-orig-assets-dump.ts 解出的 PNG 按前缀拼成联系表（便于目视核对）。
// 用法：npx tsx test/maps-orig-assets-sheet.ts <输出名> <每行列数> <缩放分母> <文件前缀...>
// 例：npx tsx test/maps-orig-assets-sheet.ts holiday-china 7 1 holiday-data28 holiday-data29 ...
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readPng } from '../tools/extract/src/assets/pngRead';
import { encodePngRgba } from '../tools/extract/src/gfx/png';

const DIR = '.cache/maps/assets';
const [name, colsArg, divArg, ...prefixes] = process.argv.slice(2);
if (!name || !colsArg || !divArg || prefixes.length === 0) throw new Error('参数不足');
const cols = Number(colsArg);
const div = Number(divArg);
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.png') && prefixes.some((p) => f === `${p}.png`))
  .sort((a, b) => prefixes.findIndex((p) => a === `${p}.png`) - prefixes.findIndex((p) => b === `${p}.png`));
const imgs = files.map((f) => {
  const p = readPng(readFileSync(`${DIR}/${f}`), f);
  const w = Math.max(1, Math.floor(p.w / div));
  const h = Math.max(1, Math.floor(p.h / div));
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) rgba.set(p.rgba.subarray(((y * div) * p.w + x * div) * 4, ((y * div) * p.w + x * div) * 4 + 4), (y * w + x) * 4);
  return { w, h, rgba };
});
const cw = Math.max(...imgs.map((i) => i.w)) + 4;
const ch = Math.max(...imgs.map((i) => i.h)) + 4;
const rows = Math.ceil(imgs.length / cols);
const W = cw * Math.min(cols, imgs.length);
const H = ch * rows;
const out = new Uint8Array(W * H * 4);
for (let p = 0; p < W * H; p++) out.set([255, 0, 255, 255], p * 4);
imgs.forEach((img, k) => {
  const ox = (k % cols) * cw + 2;
  const oy = Math.floor(k / cols) * ch + 2;
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const s = (y * img.w + x) * 4;
      if (img.rgba[s + 3] === 0) continue;
      out.set(img.rgba.subarray(s, s + 4), ((oy + y) * W + ox + x) * 4);
    }
});
writeFileSync(`${DIR}/sheet-${name}.png`, encodePngRgba(W, H, out));
console.log(`sheet-${name}.png ${W}×${H}：${files.join(' ')}`);
