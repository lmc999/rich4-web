// 调试：找某帧里近白色像素的包围盒（新闻板插图框），只打印数字
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
  return { w, h, px: (x, y) => { const i = (y * w + x) * bpp; return [out[i], out[i + 1], out[i + 2]]; } };
}
const [,, dir, res, frameNo] = process.argv;
const d = join(process.env.W3_PACK_DIR ?? 'rich4-assets', 'sprites', dir);
const files = readdirSync(d).filter((f) => f.startsWith(`${res}.`));
const atlas = JSON.parse(readFileSync(join(d, files.find((f) => f.endsWith('.json'))), 'utf8'));
const img = decode(readFileSync(join(d, files.find((f) => f.endsWith('.png')))));
const fr = Object.entries(atlas.frames).find(([k]) => k.endsWith(`/${frameNo}`))[1].frame;
let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
for (let y = 0; y < fr.h; y++) for (let x = 0; x < fr.w; x++) { const [r, g, b] = img.px(fr.x + x, fr.y + y); if (r > 240 && g > 240 && b > 240) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } }
console.log({ x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 });
