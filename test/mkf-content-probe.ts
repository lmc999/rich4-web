// 内容级探查（调试脚本）：SPR/SMP 透明色统计、GND 布局、map 结构数据与 MapDat 同一性
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Mkf, encodePng, rgb555, u16 } from './mkf-lib.ts';
const OUT = './.cache/assets-research/samples';
const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex').slice(0, 12);

// 1) SPR/SMP 四角像素统计
const corner = { SPR: new Map<number, number>(), SMP: new Map<number, number>() };
const pal0 = new Map<number, number>();
for (const rel of ['Game/Data.mkf', 'Game/Panel.mkf', 'Game/jump.mkf', 'Game/map.mkf']) {
  const m = new Mkf(rel);
  for (let i = 0; i < m.n; i++) {
    const r = m.get(i); const p = r.payload;
    if (p.length < 12) continue;
    const tag = Buffer.from(p.subarray(0, 3)).toString('latin1');
    if (tag !== 'SPR' && tag !== 'SMP') continue;
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const n = dv.getUint32(4, true), start = dv.getUint32(8, true);
    let off = tag === 'SPR' ? start + 512 : start;
    if (tag === 'SPR') { const v = u16(p, start); pal0.set(v, (pal0.get(v) ?? 0) + 1); }
    for (let k = 0; k < n; k++) {
      const w = dv.getInt16(12 + 12 * k, true), h = dv.getInt16(14 + 12 * k, true), g = dv.getUint32(20 + 12 * k, true);
      const bpp = tag === 'SPR' ? 1 : 2;
      for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]] as [number, number][]) {
        const o = off + (y * w + x) * bpp;
        const v = bpp === 1 ? p[o]! : u16(p, o);
        const mp = corner[tag as 'SPR' | 'SMP'];
        mp.set(v, (mp.get(v) ?? 0) + 1);
      }
      off += g;
    }
  }
}
const top = (m: Map<number, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v, c]) => `0x${v.toString(16)}:${c}`);
console.log('SPR corner index top', top(corner.SPR));
console.log('SMP corner rgb555 top', top(corner.SMP));
console.log('SPR palette[0] top', top(pal0));

// 2) GND 布局：16 头 + 512 调色板 + u16[n] + n×1024
const map = new Mkf('Game/map.mkf');
const g = map.get(0).payload;
const gdv = new DataView(g.buffer, g.byteOffset, g.byteLength);
const W = gdv.getUint16(4, true), H = gdv.getUint16(6, true), N = gdv.getUint32(8, true);
const tbl: number[] = []; for (let k = 0; k < N; k++) tbl.push(gdv.getUint16(528 + 2 * k, true));
const uniq = new Set(tbl);
console.log('GND', { W, H, N, tblMin: Math.min(...tbl), tblMax: Math.max(...tbl), tblDistinct: uniq.size, first16: tbl.slice(0, 16) });
const tiles0 = 528 + 2 * N;
// 72×72 图块按行优先拼成 2304×2304，再 1/4 缩略
const S = 4, WW = (W * 32) / S, HH = (H * 32) / S;
const rgba = new Uint8Array(WW * HH * 4);
const pal = Array.from({ length: 256 }, (_, k) => rgb555(u16(g, 16 + 2 * k)));
for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
  const t = ty * W + tx;
  for (let y = 0; y < 32; y += S) for (let x = 0; x < 32; x += S) {
    const c = g[tiles0 + t * 1024 + y * 32 + x]!; const [r, gg, b] = pal[c]!;
    const o = (((ty * 32 + y) / S) * WW + (tx * 32 + x) / S) * 4; rgba.set([r, gg, b, 255], o);
  }
}
writeFileSync(`${OUT}/map000_GND_rowmajor_quarter.png`, encodePng(WW, HH, rgba));

// 3) map 结构数据同一性
const md = new Mkf('Game/MapDat.MKF');
const mj = new Mkf('MultiverseJourney/map.mkf');
for (let k = 0; k < 4; k++) console.log(`MapDat#${k} ${sha1(md.get(k).payload)} | map.mkf#${2 * k + 1} ${sha1(map.get(2 * k + 1).payload)} | v311 map#${2 * k + 1} ${sha1(mj.get(2 * k + 1).payload)}`);
for (let k = 4; k < 8; k++) console.log(`v311 map#${2 * k + 1} len=${mj.get(2 * k + 1).raw} ${sha1(mj.get(2 * k + 1).payload)}`);
for (let k = 0; k < 8; k++) console.log(`GND v206#${2 * k} ${k < 4 ? sha1(map.get(2 * k).payload) : '-'} v311#${2 * k} ${sha1(mj.get(2 * k).payload)}`);
