// 调试：统计本机素材包某帧逐列 / 逐行的暗像素比例（找网格线），只打印数字
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
function decode(buf) {
  let off = 8; let w = 0, h = 0, ctype = 0; const idat = []; let pal = null; let trns = null;
  while (off < buf.length) { const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ctype = data[9]; }
    if (type === 'PLTE') pal = data; if (type === 'tRNS') trns = data; if (type === 'IDAT') idat.push(data); off += 12 + len; }
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype]; const raw = inflateSync(Buffer.concat(idat)); const stride = w * bpp; const out = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)]; for (let x = 0; x < stride; x++) { const a = raw[y * (stride + 1) + 1 + x];
    const left = x >= bpp ? out[y * stride + x - bpp] : 0; const up = y > 0 ? out[(y - 1) * stride + x] : 0; const ul = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
    let v; if (f === 0) v = a; else if (f === 1) v = a + left; else if (f === 2) v = a + up; else if (f === 3) v = a + ((left + up) >> 1);
    else { const p = left + up - ul; const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul); v = a + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul); }
    out[y * stride + x] = v & 255; } }
  const rgba = (x, y) => { const i = (y * w + x) * bpp; if (ctype === 6) return [out[i], out[i + 1], out[i + 2], out[i + 3]]; if (ctype === 2) return [out[i], out[i + 1], out[i + 2], 255];
    if (ctype === 3) { const k = out[i]; return [pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2], trns && k < trns.length ? trns[k] : 255]; } return [out[i], out[i], out[i], 255]; };
  return { w, h, rgba };
}
const [,, dir, res, frameNo, thr = '50'] = process.argv;
const d = join(process.env.W3_PACK_DIR ?? 'rich4-assets', 'sprites', dir);
const files = readdirSync(d).filter((f) => f.startsWith(`${res}.`));
const atlas = JSON.parse(readFileSync(join(d, files.find((f) => f.endsWith('.json'))), 'utf8'));
const img = decode(readFileSync(join(d, files.find((f) => f.endsWith('.png')))));
const fr = Object.entries(atlas.frames).find(([k]) => k.endsWith(`/${frameNo}`))[1].frame;
const dark = (x, y) => { const [r, g, b, a] = img.rgba(fr.x + x, fr.y + y); return a > 0 && (r + g + b) / 3 < Number(thr); };
const cols = []; for (let x = 0; x < fr.w; x++) { let n = 0; for (let y = 0; y < fr.h; y++) if (dark(x, y)) n++; cols.push(Math.round((100 * n) / fr.h)); }
const rows = []; for (let y = 0; y < fr.h; y++) { let n = 0; for (let x = 0; x < fr.w; x++) if (dark(x, y)) n++; rows.push(Math.round((100 * n) / fr.w)); }
console.log('cols>40%:', cols.map((v, i) => (v > 40 ? i : null)).filter((v) => v !== null).join(','));
console.log('rows>40%:', rows.map((v, i) => (v > 40 ? i : null)).filter((v) => v !== null).join(','));
