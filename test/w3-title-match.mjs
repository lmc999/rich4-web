// 调试（A14）：在标题底图 Data#1 图0 里找 START/LOAD/OPTION 常态帧的画点（逐像素差最小；只打印坐标，不输出像素）
// 用法：node test/w3-title-match.mjs <atlas.json> <atlas.png> <base> <part> <x0> <y0> <x1> <y1>（搜索窗口为部件左上角范围）
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
const [,, atlasJson, pngFile, baseName, part, x0, y0, x1, y1] = process.argv;
const atlas = JSON.parse(readFileSync(atlasJson, 'utf8')); const img = decode(readFileSync(pngFile));
const B = atlas.frames[baseName].frame; const F = atlas.frames[part].frame; const anc = atlas.meta.r4.anchorsPx[part];
let best = null;
for (let oy = +y0; oy <= +y1; oy++) for (let ox = +x0; ox <= +x1; ox++) {
  let d = 0, cnt = 0;
  for (let y = 0; y < F.h; y += 2) for (let x = 0; x < F.w; x += 2) { const bx = ox + x, by = oy + y; if (bx < 0 || by < 0 || bx >= B.w || by >= B.h) continue;
    const p = img.rgba(F.x + x, F.y + y); if (p[3] < 128) continue; const q = img.rgba(B.x + bx, B.y + by); cnt++; d += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]); }
  const s = d / Math.max(1, cnt); if (!best || s < best.s) best = { ox, oy, s };
}
console.log(part, `${F.w}x${F.h}`, 'topLeft', best.ox, best.oy, 'drawPoint', best.ox + anc[0], best.oy + anc[1], 'meanDiff', best.s.toFixed(1));
