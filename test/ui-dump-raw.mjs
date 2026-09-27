// 临时调试：把已知尺寸的裸 16bpp 资源批量拼样张
import { openMkf, decodeRaw555, contactSheet, savePng, downscale } from './ui-lib.mjs';
const [nm, from, to, w, h, out, scale = 1] = process.argv.slice(2);
const m = openMkf(`./original/Game/${nm}.mkf`);
const imgs = [];
for (let i = +from; i <= +to; i++) { let im = decodeRaw555(m.read(i), +w, +h); if (+scale > 1) im = downscale(im, +scale); im.label = i; imgs.push(im); }
savePng(out, contactSheet(imgs, { maxW: 1600 }));
