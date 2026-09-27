/**
 * 解压 + 渲染样图（调试脚本）：验证 LZHUF 解压结果为“有意义的图像”，并弄清 imgOff/imgSize 的语义。
 * 输出 .cache/assets-research/samples/*.png 与 samples/stats.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Mkf, encodePng, rgb555, u16 } from './mkf-lib.ts';

const OUT = './.cache/assets-research/samples';
mkdirSync(OUT, { recursive: true });

interface Img { w: number; h: number; rgba: Uint8Array }
const newImg = (w: number, h: number): Img => ({ w, h, rgba: new Uint8Array(w * h * 4) });

function checker(img: Img) {
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const v = ((x >> 3) + (y >> 3)) & 1 ? 200 : 235;
      const o = (y * img.w + x) * 4;
      img.rgba[o] = v; img.rgba[o + 1] = v; img.rgba[o + 2] = v === 200 ? 220 : 245; img.rgba[o + 3] = 255;
    }
}
function blit(dst: Img, src: Img, dx: number, dy: number) {
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const so = (y * src.w + x) * 4;
      if (src.rgba[so + 3] === 0) continue;
      const tx = dx + x, ty = dy + y;
      if (tx < 0 || ty < 0 || tx >= dst.w || ty >= dst.h) continue;
      const to = (ty * dst.w + tx) * 4;
      dst.rgba.set(src.rgba.subarray(so, so + 4), to);
    }
}
function sheet(frames: Img[], maxW = 1100, pad = 4): Img {
  let x = pad, y = pad, rowH = 0, W = 0;
  const pos: [number, number][] = [];
  for (const f of frames) {
    if (x + f.w + pad > maxW && x > pad) { x = pad; y += rowH + pad; rowH = 0; }
    pos.push([x, y]); x += f.w + pad; rowH = Math.max(rowH, f.h); W = Math.max(W, x);
  }
  const out = newImg(Math.max(W, 1), y + rowH + pad);
  checker(out);
  frames.forEach((f, i) => blit(out, f, pos[i]![0], pos[i]![1]));
  return out;
}
const save = (name: string, img: Img) => writeFileSync(`${OUT}/${name}.png`, encodePng(img.w, img.h, img.rgba));

/** 16 位 RGB555 像素块 → Img；key 为透明色（null 表示不透明） */
function raw16(p: Uint8Array, off: number, w: number, h: number, key: number | null = null): Img {
  const img = newImg(w, h);
  for (let k = 0; k < w * h; k++) {
    const v = u16(p, off + 2 * k);
    const [r, g, b] = rgb555(v);
    img.rgba.set([r, g, b, key !== null && v === key ? 0 : 255], k * 4);
  }
  return img;
}
function pal555(p: Uint8Array, off: number): [number, number, number][] {
  const pal: [number, number, number][] = [];
  for (let k = 0; k < 256; k++) pal.push(rgb555(u16(p, off + 2 * k)));
  return pal;
}
function idx8(p: Uint8Array, off: number, w: number, h: number, pal: [number, number, number][], transparent0 = true): Img {
  const img = newImg(w, h);
  for (let k = 0; k < w * h; k++) {
    const c = p[off + k]!;
    const [r, g, b] = pal[c]!;
    img.rgba.set([r, g, b, transparent0 && c === 0 ? 0 : 255], k * 4);
  }
  return img;
}

interface Chunk { w: number; h: number; x: number; y: number; gsize: number; off: number }
function spriteChunks(p: Uint8Array): { tag: string; start: number; chunks: Chunk[] } {
  const tag = Buffer.from(p.subarray(0, 3)).toString('latin1');
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const n = dv.getUint32(4, true), start = dv.getUint32(8, true);
  let off = tag === 'SPR' ? start + 512 : start;
  const chunks: Chunk[] = [];
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 12;
    const c = { w: dv.getInt16(o, true), h: dv.getInt16(o + 2, true), x: dv.getInt16(o + 4, true), y: dv.getInt16(o + 6, true), gsize: dv.getUint32(o + 8, true), off };
    chunks.push(c); off += c.gsize;
  }
  return { tag, start, chunks };
}

function renderSprite(p: Uint8Array, limit = 64, smpKey: number | null = null): Img[] {
  const { tag, start, chunks } = spriteChunks(p);
  const pal = tag === 'SPR' ? pal555(p, start) : null;
  return chunks.slice(0, limit).map((c) => (pal ? idx8(p, c.off, c.w, c.h, pal) : raw16(p, c.off, c.w, c.h, smpKey)));
}

// ---------- FLIC（仅用于验证：COLOR_256 / BYTE_RUN / DELTA_FLC / COPY / BLACK） ----------
function flicFrames(p: Uint8Array, maxFrames = 8): { frames: Img[]; walk: { ok: boolean; frames: number; types: Record<string, number>; end: number } } {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const size = dv.getUint32(0, true), nf = dv.getUint16(6, true), W = dv.getUint16(8, true), H = dv.getUint16(10, true);
  const oframe1 = dv.getUint32(80, true);
  let pos = oframe1 || 128;
  const pal: [number, number, number][] = Array.from({ length: 256 }, () => [0, 0, 0]);
  const fb = new Uint8Array(W * H);
  const frames: Img[] = [];
  const types: Record<string, number> = {};
  let count = 0;
  let ok = true;
  while (pos < size && count < nf + 1) {
    const csize = dv.getUint32(pos, true), ctype = dv.getUint16(pos + 4, true);
    if (csize < 16 || pos + csize > size) { ok = false; break; }
    types[`0x${ctype.toString(16)}`] = (types[`0x${ctype.toString(16)}`] ?? 0) + 1;
    if (ctype === 0xf1fa) {
      const nsub = dv.getUint16(pos + 6, true);
      let sp = pos + 16;
      for (let s = 0; s < nsub; s++) {
        const ssize = dv.getUint32(sp, true), stype = dv.getUint16(sp + 4, true);
        types[`sub${stype}`] = (types[`sub${stype}`] ?? 0) + 1;
        const d = sp + 6;
        if (stype === 4 || stype === 11) { // COLOR_256 / COLOR_64
          let q = d; const packets = dv.getUint16(q, true); q += 2; let ci = 0;
          for (let k = 0; k < packets; k++) {
            ci += p[q++]!; let cnt = p[q++]!; if (cnt === 0) cnt = 256;
            for (let m = 0; m < cnt; m++) {
              const sh = stype === 11 ? 2 : 0;
              pal[ci++ & 255] = [p[q]! << sh, p[q + 1]! << sh, p[q + 2]! << sh]; q += 3;
            }
          }
        } else if (stype === 15) { // BYTE_RUN
          let q = d;
          for (let y = 0; y < H; y++) {
            q++; let x = 0;
            while (x < W) {
              const c = (p[q++]! << 24) >> 24;
              if (c < 0) { for (let m = 0; m < -c; m++) fb[y * W + x++] = p[q++]!; }
              else { const v = p[q++]!; for (let m = 0; m < c; m++) fb[y * W + x++] = v; }
            }
          }
        } else if (stype === 7) { // DELTA_FLC (SS2)
          let q = d; let lines = dv.getUint16(q, true); q += 2; let y = 0;
          while (lines > 0) {
            let w = dv.getInt16(q, true); q += 2;
            if (w < 0) { if (w & 0x4000) { y += -w; } else { fb[y * W + W - 1] = w & 0xff; } continue; }
            let x = 0;
            for (let k = 0; k < w; k++) {
              x += p[q++]!; const c = (p[q++]! << 24) >> 24;
              if (c > 0) { for (let m = 0; m < c; m++) { fb[y * W + x++] = p[q++]!; fb[y * W + x++] = p[q++]!; } }
              else { const a = p[q++]!, b = p[q++]!; for (let m = 0; m < -c; m++) { fb[y * W + x++] = a; fb[y * W + x++] = b; } }
            }
            y++; lines--;
          }
        } else if (stype === 16) { fb.set(p.subarray(d, d + W * H)); }
        else if (stype === 13) { fb.fill(0); }
        sp += ssize;
      }
      if (frames.length < maxFrames) {
        const img = newImg(W, H);
        for (let k = 0; k < W * H; k++) { const [r, g, b] = pal[fb[k]!]!; img.rgba.set([r, g, b, 255], k * 4); }
        frames.push(img);
      }
      count++;
    }
    pos += csize;
  }
  return { frames, walk: { ok: ok && pos === size, frames: count, types, end: pos } };
}

const stats: Record<string, unknown> = {};
const mk = {
  data: new Mkf('Game/Data.mkf'),
  panel: new Mkf('Game/Panel.mkf'),
  jump: new Mkf('Game/jump.mkf'),
  map: new Mkf('Game/map.mkf'),
  help: new Mkf('Game/help.mkf'),
};

// 1) 压缩的 SMP / SPR
const jobs: [keyof typeof mk, number, string][] = [
  ['map', 8, 'map08_SMP_C'],
  ['map', 12, 'map12_SMP_C'],
  ['map', 13, 'map13_SPR_C'],
  ['map', 15, 'map15_SMP_C'],
  ['jump', 5, 'jump05_SPR_C'],
  ['jump', 40, 'jump40_SPR_C'],
  ['data', 0, 'data000_SMP_C'],
  ['data', 1, 'data001_SMP'],
  ['data', 88, 'data088_SPR'],
  ['data', 480, 'data480_SPR_C'],
  ['panel', 0, 'panel000_SMP_C'],
  ['panel', 1, 'panel001_SMP_C'],
  ['panel', 26, 'panel026_SMP_C'],
  ['panel', 30, 'panel030_SPR_C'],
  ['map', 100, 'map100_SPR'],
  ['help', 0, 'help000_SMP'],
];
for (const [m, i, name] of jobs) {
  const r = mk[m].get(i);
  const frames = renderSprite(r.payload, 48);
  save(name, sheet(frames, 1280));
  stats[name] = { compressed: r.compressed, raw: r.raw, stored: r.stored, frames: frames.length, dims: frames.slice(0, 6).map((f) => `${f.w}x${f.h}`) };
}

// 2) RAW16（无头，尺寸由 exe 硬编码；这里用自相关推断）
for (const [m, i, w, h] of [
  ['data', 4, 200, 200], ['data', 50, 200, 200], ['data', 400, 388, 251], ['data', 450, 388, 251],
  ['data', 530, 165, 256], ['data', 560, 640, 480], ['panel', 92, 640, 480], ['jump', 0, 640, 480], ['jump', 3, 640, 480],
] as [keyof typeof mk, number, number, number][]) {
  const r = mk[m].get(i);
  save(`${m}${String(i).padStart(3, '0')}_RAW16${r.compressed ? '_C' : ''}_${w}x${h}`, raw16(r.payload, 0, w, h));
  stats[`${m}#${i}`] = { compressed: r.compressed, raw: r.raw, imgOff: r.imgOff, imgSize: r.imgSize, w, h };
}

// 3) FLIC（压缩）
for (const [m, i] of [['data', 375], ['data', 482], ['data', 519], ['panel', 78], ['jump', 43]] as [keyof typeof mk, number][]) {
  const r = mk[m].get(i);
  const { frames, walk } = flicFrames(r.payload, 12);
  save(`${m}${String(i).padStart(3, '0')}_FLIC${r.compressed ? '_C' : ''}`, sheet(frames, 1400));
  stats[`${m}#${i}_flic`] = { compressed: r.compressed, walk };
}

// 4) GND：imgOff=16,imgSize=512 → 调色板；其后 u16[n] 索引表，再后 n 个 8 位索引 32×32 图块
{
  const r = mk.map.get(0);
  const p = r.payload;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const w = dv.getUint16(4, true), h = dv.getUint16(6, true), n = dv.getUint32(8, true);
  const pal = pal555(p, 16);
  const tilesOff = 16 + 512 + 2 * n; // 16 头 + 512 调色板 + u16[n]（恒等索引表）
  const tiles: Img[] = [];
  for (let t = 0; t < 64; t++) tiles.push(idx8(p, tilesOff + t * 1024, 32, 32, pal, false));
  save('map000_GND_tiles0-63', sheet(tiles, 600, 2));
  const rest = p.length - 528 - n * 1024;
  stats.gnd = { w, h, n, restBytes: rest, restPerTile: rest / n, u32_12: dv.getUint32(12, true) };
}

// 5) Panel DATA（8 位）
for (const i of [8, 19, 22]) {
  const r = mk.panel.get(i);
  const vals = new Map<number, number>();
  for (const b of r.payload) vals.set(b, (vals.get(b) ?? 0) + 1);
  stats[`panel#${i}_data`] = { compressed: r.compressed, raw: r.raw, distinct: [...vals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12) };
  if (r.raw === 307200) {
    const img = newImg(640, 480);
    const lut = [...vals.keys()].sort((a, b) => a - b);
    for (let k = 0; k < 307200; k++) { const v = r.payload[k]!; const c = v === 0 ? 0 : 60 + Math.round((lut.indexOf(v) / lut.length) * 195); img.rgba.set([c, (c * 7) % 256, 255 - c, 255], k * 4); }
    save(`panel${String(i).padStart(3, '0')}_DATA${r.compressed ? '_C' : ''}_640x480_u8`, img);
  }
}
writeFileSync(`${OUT}/stats.json`, JSON.stringify(stats, null, 1));
console.log(JSON.stringify(stats, null, 1));
