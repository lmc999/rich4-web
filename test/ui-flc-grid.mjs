// 临时调试：每个 FLC 取中间帧，缩小后拼成网格
import { openMkf, decodeFlc, contactSheet, savePng, downscale } from './ui-lib.mjs';
const [nm, from, to, out, scale = 4, which = 'mid'] = process.argv.slice(2);
const m = openMkf(`./original/Game/${nm}.mkf`);
const imgs = [];
for (let i = +from; i <= +to; i++) {
  const fl = decodeFlc(m.read(i));
  const k = which === 'mid' ? fl.frames.length >> 1 : which === 'last' ? fl.frames.length - 1 : +which;
  let im = fl.frames[Math.min(k, fl.frames.length - 1)];
  im = downscale(im, +scale); im.label = i; imgs.push(im);
}
savePng(out, contactSheet(imgs, { maxW: 1500 }));
