// 调试：某帧子矩形内，逐列 / 逐行统计「暗或透明」像素比例，找网格线（只打印数字）
// 用法：node test/w3-region-lines.mjs panel 9 0 x y w h [thr]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
function decode(buf) {
  let off = 8; let w = 0, h = 0, ctype = 0; const idat = [];
  while (off < buf.length) { const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ctype = data[9]; } if (type === 'IDAT') idat.push(data); off += 12 + len; }
  const bpp = { 2: 3, 6: 4 }[ctype]; const raw = inflateSync(Buffer.concat(idat)); const stride = w * bpp; const out = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)]; for (let x = 0; x < stride; x++) { const a = raw[y * (stride + 1) + 1 + x];
    const left = x >= bpp ? out[y * stride + x - bpp] : 0; const up = y > 0 ? out[(y - 1) * stride + x] : 0; const ul = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
    let v; if (f === 0) v = a; else if (f === 1) v = a + left; else if (f === 2) v = a + up; else if (f === 3) v = a + ((left + up) >> 1);
    else { const p = left + up - ul; const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul); v = a + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul); }
    out[y * stride + x] = v & 255; } }
  return { px: (x, y) => { const i = (y * w + x) * bpp; return [...out.subarray(i, i + bpp)]; } };
}
const [,, dir, res, frameNo, X, Y, W, H, thr = '50'] = process.argv;
const d = join(process.env.W3_PACK_DIR ?? 'rich4-assets', 'sprites', dir);
const files = readdirSync(d).filter((f) => f.startsWith(`${res}.`));
const atlas = JSON.parse(readFileSync(join(d, files.find((f) => f.endsWith('.json'))), 'utf8'));
const img = decode(readFileSync(join(d, files.find((f) => f.endsWith('.png')))));
const fr = Object.entries(atlas.frames).find(([k]) => k.endsWith(`/${frameNo}`))[1].frame;
const x0 = +X, y0 = +Y, w = +W, h = +H;
const dark = (x, y) => { const [r, g, b, a] = img.px(fr.x + x, fr.y + y); return a === 0 || (r + g + b) / 3 < +thr; };
const cols = []; for (let x = x0; x < x0 + w; x++) { let n = 0; for (let y = y0; y < y0 + h; y++) if (dark(x, y)) n++; if (n / h > 0.6) cols.push(x); }
const rows = []; for (let y = y0; y < y0 + h; y++) { let n = 0; for (let x = x0; x < x0 + w; x++) if (dark(x, y)) n++; if (n / w > 0.6) rows.push(y); }
console.log('cols', cols.join(','));
console.log('rows', rows.join(','));
