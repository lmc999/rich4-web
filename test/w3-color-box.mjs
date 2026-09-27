// 调试：按颜色范围找某帧里的连通矩形块（逐行扫描、合并相邻行），只打印数字。用法：node test/w3-color-box.mjs panel 25 5 r g b tol
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
  return { px: (x, y) => { const i = (y * w + x) * bpp; return [out[i], out[i + 1], out[i + 2]]; } };
}
const [,, dir, res, frameNo, R, G, B, tol = '24', minRun = '8'] = process.argv;
const d = join(process.env.W3_PACK_DIR ?? 'rich4-assets', 'sprites', dir);
const files = readdirSync(d).filter((f) => f.startsWith(`${res}.`));
const atlas = JSON.parse(readFileSync(join(d, files.find((f) => f.endsWith('.json'))), 'utf8'));
const img = decode(readFileSync(join(d, files.find((f) => f.endsWith('.png')))));
const fr = Object.entries(atlas.frames).find(([k]) => k.endsWith(`/${frameNo}`))[1].frame;
const near = (x, y) => { const [r, g, b] = img.px(fr.x + x, fr.y + y); return Math.abs(r - R) <= tol && Math.abs(g - G) <= tol && Math.abs(b - B) <= tol; };
const boxes = [];
for (let y = 0; y < fr.h; y++) {
  let x = 0;
  while (x < fr.w) {
    if (!near(x, y)) { x++; continue; }
    let e = x; while (e < fr.w && near(e, y)) e++;
    if (e - x >= Number(minRun)) {
      const b = boxes.find((q) => q.y1 === y - 1 && Math.abs(q.x0 - x) <= 3 && Math.abs(q.x1 - (e - 1)) <= 3);
      if (b) { b.y1 = y; b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, e - 1); } else boxes.push({ x0: x, y0: y, x1: e - 1, y1: y });
    }
    x = e;
  }
}
for (const b of boxes.filter((q) => q.y1 - q.y0 >= 4)) console.log(`(${b.x0},${b.y0}) ${b.x1 - b.x0 + 1}×${b.y1 - b.y0 + 1}`);
