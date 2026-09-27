// w2 调试：从本机真实素材包（只读）读 UI 图集帧，打印尺寸、锚点，并把指定帧放大存到 .cache/w2（不入库）
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePngRgba } from '../tools/extract/src/gfx/png';
import { readPng } from '../tools/extract/src/assets/pngRead';

const PACK = 'rich4-assets';
const OUT = '.cache/w2';
mkdirSync(OUT, { recursive: true });
const m = JSON.parse(readFileSync(join(PACK, 'manifest.json'), 'utf8'));

function atlasOf(key: string) {
  const e = m.entries[key];
  const lp = e.atlas[0];
  const f = m.files[lp];
  const a = JSON.parse(readFileSync(join(PACK, f.path), 'utf8'));
  const dir = f.path.slice(0, f.path.lastIndexOf('/') + 1);
  const img = readPng(readFileSync(join(PACK, dir + a.meta.image)));
  return { e, a, img };
}

function frame(key: string, i: number) {
  const { e, a, img } = atlasOf(key);
  const name = `${e.frames.base}/${e.frames.start + i}`;
  const fr = a.frames[name];
  const [ax, ay] = a.meta.r4.anchorsPx[name];
  const { x, y, w, h } = fr.frame;
  const px = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) px.set(img.rgba.subarray(((y + r) * img.w + x) * 4, ((y + r) * img.w + x + w) * 4), r * w * 4);
  return { w, h, ax, ay, px };
}

const args = process.argv.slice(2);
const key = args[0]!;
const { e } = atlasOf(key);
for (let i = 0; i < e.frames.count; i++) {
  const f = frame(key, i);
  console.log(`${key}#${i} ${f.w}x${f.h} anchor ${f.ax},${f.ay}`);
}
if (args[1] !== undefined) {
  const f = frame(key, Number(args[1]));
  const s = Number(args[2] ?? 3);
  const W = f.w * s, H = f.h * s;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.floor(x / s), sy = Math.floor(y / s);
    const o = (y * W + x) * 4, i = (sy * f.w + sx) * 4;
    const grid = (sx % 10 === 0 && x % s === 0) || (sy % 10 === 0 && y % s === 0);
    out[o] = grid ? 255 : f.px[i]!; out[o + 1] = grid ? 0 : f.px[i + 1]!; out[o + 2] = grid ? 0 : f.px[i + 2]!; out[o + 3] = grid ? 255 : f.px[i + 3]!;
  }
  writeFileSync(join(OUT, `${key}-${args[1]}.png`), encodePngRgba(W, H, out));
  // 行扫描：打印每行中间像素颜色（找行条带）
  if (args[3] === 'rows') for (let y = 0; y < f.h; y++) { const i = (y * f.w + Number(args[4] ?? 100)) * 4; console.log(y, f.px[i], f.px[i+1], f.px[i+2], f.px[i+3]); }
  if (args[3] === 'cols') for (let x = 0; x < f.w; x++) { const i = (Number(args[4] ?? 100) * f.w + x) * 4; console.log(x, f.px[i], f.px[i+1], f.px[i+2], f.px[i+3]); }
}
void readdirSync;
