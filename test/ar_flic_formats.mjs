// 调研：比较 FLIC 在浏览器端的几种交付方式的体积/显存：
//  A) 原样 .flc（解压后的 FLC 字节）+ gzip/brotli 传输；客户端 JS 解码（索引 0 透明）
//  B) PNG 图集（每帧整幅，RGBA）；C) PNG 图集（每帧裁到非透明包围盒）
// 只读原版；样张写到 .cache/assets-research/audio/flic-atlas/
import fs from 'node:fs';
import zlib from 'node:zlib';
import { openMkf, decodeFlc, encodePng, canvas, blit } from './ui-lib.mjs';
const ROOT = '.';
const OUT = `${ROOT}/.cache/assets-research/audio/flic-atlas`;
fs.mkdirSync(OUT, { recursive: true });
const pick = { 'Data.mkf': [482, 483, 497, 499, 510, 513, 518], 'Panel.mkf': [4, 20, 78], 'jump.mkf': [55] };
const rows = [];
function bbox(fr) {
  let x0 = fr.w, y0 = fr.h, x1 = -1, y1 = -1;
  for (let y = 0; y < fr.h; y++) for (let x = 0; x < fr.w; x++) if (fr.rgba[(y * fr.w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function crop(fr, b) {
  const rgba = new Uint8Array(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) rgba.set(fr.rgba.subarray(((b.y0 + y) * fr.w + b.x0) * 4, ((b.y0 + y) * fr.w + b.x0 + b.w) * 4), y * b.w * 4);
  return { w: b.w, h: b.h, rgba };
}
for (const [f, ids] of Object.entries(pick)) {
  const m = openMkf(`${ROOT}/original/Game/${f}`);
  for (const i of ids) {
    const flc = m.read(i);
    const { w, h, frames, speed } = decodeFlc(flc, { transparentIndex: 0 });
    const n = frames.length;
    // B 整幅图集
    const cols = Math.ceil(Math.sqrt(n)), rowsN = Math.ceil(n / cols);
    const full = canvas(cols * w, rowsN * h, [0, 0, 0, 0]);
    frames.forEach((fr, k) => blit(full, fr, (k % cols) * w, Math.floor(k / cols) * h));
    const pngFull = encodePng(full.w, full.h, full.rgba);
    // C 裁剪图集（简单行打包）
    const crops = frames.map((fr) => { const b = bbox(fr); return b ? crop(fr, b) : { w: 1, h: 1, rgba: new Uint8Array(4) }; });
    const maxW = 2048; let x = 0, y = 0, rh = 0; const pos = [];
    for (const c of crops) { if (x + c.w > maxW) { x = 0; y += rh; rh = 0; } pos.push([x, y]); x += c.w; rh = Math.max(rh, c.h); }
    const W = Math.min(maxW, Math.max(...crops.map((c, k) => pos[k][0] + c.w))), H = y + rh;
    const trim = canvas(W, H, [0, 0, 0, 0]);
    crops.forEach((c, k) => blit(trim, c, pos[k][0], pos[k][1]));
    const pngTrim = encodePng(trim.w, trim.h, trim.rgba);
    if (i === 483 || i === 499) fs.writeFileSync(`${OUT}/${f.replace('.mkf', '')}${i}_trim.png`, pngTrim);
    rows.push({ res: `${f}#${i}`, w, h, frames: n, speedMs: speed, durMs: n * speed, flcBytes: flc.length, flcGzip: zlib.gzipSync(flc, { level: 9 }).length, flcBrotli: zlib.brotliCompressSync(flc).length, atlasFull: `${full.w}x${full.h}`, atlasFullMB_RGBA: +(full.w * full.h * 4 / 1048576).toFixed(1), pngFull: pngFull.length, atlasTrim: `${trim.w}x${trim.h}`, atlasTrimMB_RGBA: +(trim.w * trim.h * 4 / 1048576).toFixed(1), pngTrim: pngTrim.length });
  }
}
console.table(rows);
fs.writeFileSync(`${OUT}/compare.json`, JSON.stringify(rows, null, 1));
