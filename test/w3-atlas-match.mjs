// 调试：在底图帧里找部件帧的最佳贴合位置（逐像素差最小；只打印坐标）
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
function decode(buf) {
  let off = 8; let w = 0, h = 0, ctype = 0; const idat = []; let pal = null; let trns = null;
  while (off < buf.length) { const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ctype = data[9]; } if (type === 'PLTE') pal = data; if (type === 'tRNS') trns = data; if (type === 'IDAT') idat.push(data); off += 12 + len; }
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype]; const raw = inflateSync(Buffer.concat(idat)); const stride = w * bpp; const out = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)]; for (let x = 0; x < stride; x++) { const a = raw[y * (stride + 1) + 1 + x];
    const left = x >= bpp ? out[y * stride + x - bpp] : 0; const up = y > 0 ? out[(y - 1) * stride + x] : 0; const ul = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
    let v; if (f === 0) v = a; else if (f === 1) v = a + left; else if (f === 2) v = a + up; else if (f === 3) v = a + ((left + up) >> 1); else { const p = left + up - ul; const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul); v = a + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul); }
    out[y * stride + x] = v & 255; } }
  const rgba = (x, y) => { const i = (y * w + x) * bpp; if (ctype === 6) return [out[i], out[i + 1], out[i + 2], out[i + 3]]; if (ctype === 2) return [out[i], out[i + 1], out[i + 2], 255];
    if (ctype === 3) { const k = out[i]; return [pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2], trns && k < trns.length ? trns[k] : 255]; } return [out[i], out[i], out[i], 255]; };
  return { w, h, rgba };
}
const [,, atlasJson, pngFile, baseName, ...parts] = process.argv;
const atlas = JSON.parse(readFileSync(atlasJson, 'utf8')); const img = decode(readFileSync(pngFile));
const B = atlas.frames[baseName].frame;
for (const n of parts) {
  const F = atlas.frames[n].frame; let best = null;
  for (let oy = -2; oy <= B.h - F.h + 2; oy++) for (let ox = -2; ox <= B.w - F.w + 2; ox++) {
    let d = 0, cnt = 0;
    for (let y = 0; y < F.h; y++) for (let x = 0; x < F.w; x++) { const bx = ox + x, by = oy + y; if (bx < 0 || by < 0 || bx >= B.w || by >= B.h) { d += 200; continue; }
      const p = img.rgba(F.x + x, F.y + y); const q = img.rgba(B.x + bx, B.y + by); if (p[3] < 128) continue; cnt++; d += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]); }
    const s = d / Math.max(1, cnt); if (!best || s < best.s) best = { ox, oy, s };
  }
  console.log(n, `${F.w}x${F.h}`, 'at', best.ox, best.oy, 'meanDiff', best.s.toFixed(1));
}
