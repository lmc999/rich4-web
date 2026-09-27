// 临时调试：对未知的原始 16bpp 块做行宽自相关探测
import { openMkf } from './ui-lib.mjs';
const [nm, idx, skip = 0] = process.argv.slice(2);
const m = openMkf(`./original/Game/${nm}.mkf`);
const d = m.read(+idx);
const n = (d.length - +skip) >> 1;
const px = new Uint16Array(n);
for (let i = 0; i < n; i++) px[i] = d[+skip + i * 2] | (d[+skip + i * 2 + 1] << 8);
const diff = (a, b) => { const r = Math.abs(((a >> 10) & 31) - ((b >> 10) & 31)) + Math.abs(((a >> 5) & 31) - ((b >> 5) & 31)) + Math.abs((a & 31) - (b & 31)); return r; };
const res = [];
for (let w = 16; w <= 700; w++) { let s = 0, c = 0; for (let i = w; i < n; i += 7) { s += diff(px[i], px[i - w]); c++; } res.push([w, s / c]); }
res.sort((a, b) => a[1] - b[1]);
console.log(d.length, 'best widths', res.slice(0, 10).map(r => `${r[0]}:${r[1].toFixed(2)}`).join(' '));
// 8bpp 假设
const res8 = [];
for (let w = 16; w <= 700; w++) { let s = 0, c = 0; for (let i = w + +skip; i < d.length; i += 7) { s += d[i] === d[i - w] ? 0 : 1; c++; } res8.push([w, s / c]); }
res8.sort((a, b) => a[1] - b[1]);
console.log('8bpp best', res8.slice(0, 8).map(r => `${r[0]}:${r[1].toFixed(3)}`).join(' '));
