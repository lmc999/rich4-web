// 临时调试：把多个样张纵向拼成一张（带资源号），便于一次目视
import fs from 'node:fs';
import zlib from 'node:zlib';
import { canvas, blit, label, savePng, downscale } from './ui-lib.mjs';
function readPng(p) {
  const b = fs.readFileSync(p);
  let o = 8; let w, h; const idat = [];
  while (o < b.length) { const len = b.readUInt32BE(o); const t = b.toString('latin1', o + 4, o + 8); const d = b.subarray(o + 8, o + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); } else if (t === 'IDAT') idat.push(d); o += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)); const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) raw.copy(Buffer.from(rgba.buffer), y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  return { w, h, rgba };
}
const [out, scale, ...files] = process.argv.slice(2);
const s = +scale;
const imgs = files.map(f => { let im = readPng(f); if (s > 1) im = downscale(im, s); im.name = f.match(/-(\d+)\.png$/)[1]; return im; });
const W = Math.max(...imgs.map(i => i.w)) + 60; const H = imgs.reduce((a, i) => a + i.h + 8, 8);
const cv = canvas(W, H, [10, 10, 10, 255]); let y = 8;
for (const im of imgs) { label(cv, 2, y, +im.name, [0, 255, 255, 255], 3); blit(cv, im, 58, y); y += im.h + 8; }
savePng(out, cv);
