// 调试（A14）：在开局设置部件（jump#4）的某帧里找近白色 / 指定颜色的连通块，打印包围盒（只打印坐标，不输出像素）
// 用法：node test/w3-setup-boxes.mjs <atlas.json> <atlas.png> <frameName> [minArea] [mode]
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
const [,, atlasJson, pngFile, name, minArea = '150', mode = 'white'] = process.argv;
const atlas = JSON.parse(readFileSync(atlasJson, 'utf8')); const img = decode(readFileSync(pngFile));
const F = atlas.frames[name].frame;
const hit = (x, y) => { const [r, g, b, a] = img.rgba(F.x + x, F.y + y); if (a < 128) return false;
  if (mode === 'white') return r > 225 && g > 225 && b > 225;
  if (mode === 'dark') return r + g + b < 60;
  return false; };
const seen = new Uint8Array(F.w * F.h); const boxes = [];
for (let y = 0; y < F.h; y++) for (let x = 0; x < F.w; x++) {
  if (seen[y * F.w + x] || !hit(x, y)) continue;
  let x0 = x, x1 = x, y0 = y, y1 = y, n = 0; const st = [[x, y]]; seen[y * F.w + x] = 1;
  while (st.length) { const [cx, cy] = st.pop(); n++; x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= F.w || ny >= F.h) continue; const k = ny * F.w + nx; if (seen[k] || !hit(nx, ny)) continue; seen[k] = 1; st.push([nx, ny]); } }
  if (n >= +minArea) boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n });
}
boxes.sort((a, b) => a.y - b.y || a.x - b.x);
for (const b of boxes) console.log(JSON.stringify(b));
