// 临时调试：把各 MKF 的每个图像资源拼成样张 PNG，供目视识别
import fs from 'node:fs';
import { openMkf, parseSheet, decodeFrame, decodeRaw555, decodeFlc, contactSheet, savePng, downscale } from './ui-lib.mjs';
const ROOT = '.';
const OUT = `${ROOT}/.cache/assets-research/ui/sheets`;
fs.mkdirSync(OUT, { recursive: true });
const [nm, from = 0, to = 1e9] = process.argv.slice(2);
const m = openMkf(`${ROOT}/original/Game/${nm}.mkf`);
for (const e of m.entries) {
  if (e.index < +from || e.index > +to) continue;
  const d = m.read(e.index);
  const sh = parseSheet(d);
  let imgs = null;
  if (sh) {
    imgs = sh.frames.map((f, i) => {
      let im = decodeFrame(sh, d, i);
      if (im.w >= 400) im = downscale(im, 2);
      im.label = i;
      return im;
    });
  } else if (d.length >= 6 && (d[4] | (d[5] << 8)) === 0xaf12) {
    const fl = decodeFlc(d, {});
    const step = Math.max(1, Math.ceil(fl.frames.length / 12));
    imgs = fl.frames.filter((_, i) => i % step === 0).map((im, j) => {
      let r = im;
      if (r.w >= 300) r = downscale(r, 2);
      r.label = j * step;
      return r;
    });
  } else if (d.length === 80000) {
    imgs = [decodeRaw555(d, 200, 200)];
  } else if (d.length === 614400) {
    imgs = [downscale(decodeRaw555(d, 640, 480), 2)];
  }
  if (!imgs || !imgs.length) continue;
  const cv = contactSheet(imgs, { maxW: 1400 });
  savePng(`${OUT}/${nm}-${String(e.index).padStart(3, '0')}.png`, cv);
}
console.log('done', nm);
