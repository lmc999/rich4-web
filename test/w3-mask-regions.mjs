// 调试：解码 8 位灰度掩膜 PNG，按区号统计包围盒（只读本机素材包，不输出像素）
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodeGray(buf) {
  let off = 8;
  let w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];
  let pal = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    if (type === 'PLTE') pal = data;
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (depth !== 8) throw new Error(`depth ${depth} ctype ${ctype}`);
  const bpp = ctype === 0 ? 1 : ctype === 4 ? 2 : ctype === 2 ? 3 : ctype === 6 ? 4 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = raw[y * (stride + 1) + 1 + x];
      const left = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const ul = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (f === 0) v = a; else if (f === 1) v = a + left; else if (f === 2) v = a + up; else if (f === 3) v = a + ((left + up) >> 1);
      else { const p = left + up - ul; const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul); v = a + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul); }
      out[y * stride + x] = v & 255;
    }
  }
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = out[i * bpp];
  return { w, h, g, ctype };
}

const file = process.argv[2];
const { w, h, g, ctype } = decodeGray(readFileSync(file));
console.log('size', w, h, 'ctype', ctype);
const box = new Map();
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const v = g[y * w + x];
  const b = box.get(v) ?? { x0: 1e9, y0: 1e9, x1: -1, y1: -1, n: 0 };
  b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y); b.n++;
  box.set(v, b);
}
for (const [v, b] of [...box].sort((a, b) => a[0] - b[0])) console.log(v, `x${b.x0}..${b.x1} y${b.y0}..${b.y1}`, b.n, (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1));
