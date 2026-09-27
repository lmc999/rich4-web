// 调研：把 MKF 内 FLIC 的若干帧拼成样张，便于目视确认用途。输出到 .cache/assets-research/audio/。只读原版。
// 用法：node test/ar_flic_sheet.mjs <mkf> <ids 逗号分隔或 a-b> <输出名> [每个取几帧=1] [缩小倍数=2]
import { openMkf, decodeFlc, contactSheet, savePng, downscale } from './ui-lib.mjs';
const ROOT = '.';
const [mkf, idsArg, outName, nPick = '1', shrink = '2'] = process.argv.slice(2);
const ids = idsArg.split(',').flatMap((t) => { const [a, b] = t.split('-').map(Number); return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, k) => a + k); });
const m = openMkf(`${ROOT}/original/Game/${mkf}`);
const imgs = [];
for (const i of ids) {
  const d = m.read(i);
  const fr = decodeFlc(d, {});
  const n = fr.frames?.length ?? fr.length;
  const frames = fr.frames ?? fr;
  const k = Number(nPick);
  for (let j = 0; j < k; j++) {
    const idx = k === 1 ? Math.floor(n / 2) : Math.round((j * (n - 1)) / (k - 1));
    const im = downscale(frames[idx], Number(shrink));
    im.label = `${i}${String(idx).padStart(3, '0')}`; // 标签 = 资源号 + 3 位帧号
    imgs.push(im);
  }
}
const sheet = contactSheet(imgs, { maxW: 1500 });
const out = `${ROOT}/.cache/assets-research/audio/${outName}.png`;
savePng(out, sheet);
console.log('saved', out, sheet.w, sheet.h, 'images', imgs.length);
