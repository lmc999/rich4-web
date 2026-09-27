// 调试：把本机素材包图集里的若干帧打印成 ASCII（只看形状，不输出像素文件）
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decode(buf) {
  let off = 8; let w = 0, h = 0, ctype = 0, depth = 0; const idat = []; let pal = null; let trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    if (type === 'PLTE') pal = data; if (type === 'tRNS') trns = data;
    if (type === 'IDAT') idat.push(data); off += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const raw = inflateSync(Buffer.concat(idat)); const stride = w * bpp; const out = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) { const a = raw[y * (stride + 1) + 1 + x];
      const left = x >= bpp ? out[y * stride + x - bpp] : 0; const up = y > 0 ? out[(y - 1) * stride + x] : 0; const ul = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v; if (f === 0) v = a; else if (f === 1) v = a + left; else if (f === 2) v = a + up; else if (f === 3) v = a + ((left + up) >> 1);
      else { const p = left + up - ul; const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul); v = a + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul); }
      out[y * stride + x] = v & 255; } }
  const rgba = (x, y) => { const i = (y * w + x) * bpp; if (ctype === 6) return [out[i], out[i + 1], out[i + 2], out[i + 3]]; if (ctype === 2) return [out[i], out[i + 1], out[i + 2], 255];
    if (ctype === 3) { const k = out[i]; return [pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2], trns && k < trns.length ? trns[k] : 255]; } return [out[i], out[i], out[i], 255]; };
  return { w, h, rgba };
}
const [,, atlasJson, pngFile, ...names] = process.argv;
const atlas = JSON.parse(readFileSync(atlasJson, 'utf8'));
const img = decode(readFileSync(pngFile));
for (const n of names) {
  const f = atlas.frames[n].frame; console.log('--', n, f.w, f.h);
  for (let y = 0; y < f.h; y++) { let s = ''; for (let x = 0; x < f.w; x++) { const [r, g, b, a] = img.rgba(f.x + x, f.y + y); s += a < 128 ? ' ' : (r + g + b) / 3 > 140 ? '#' : (r + g + b) / 3 > 60 ? '+' : '.'; } console.log(s); }
}
