// 调试（A12）：摇奖机 FLC（Panel#16）第 0 帧在开奖底图（Panel#15 图0）上的最佳落点（逐像素差最小，只打印坐标）
// 用法：npx tsx test/w3-venues-a-flcmatch.ts
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { decodeFlcFrames, parseFlc } from '../tools/extract/src/gfx/flc';

function decodePng(buf: Buffer): { w: number; h: number; rgba: (x: number, y: number) => number[] } {
  let off = 8;
  let w = 0;
  let h = 0;
  let ctype = 0;
  const idat: Buffer[] = [];
  let pal: Buffer | null = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ctype = data[9]!;
    }
    if (type === 'PLTE') pal = data;
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const bpp = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype]!;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const a = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= bpp ? out[y * stride + x - bpp]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const ul = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp]! : 0;
      let v: number;
      if (f === 0) v = a;
      else if (f === 1) v = a + left;
      else if (f === 2) v = a + up;
      else if (f === 3) v = a + ((left + up) >> 1);
      else {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        v = a + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
      }
      out[y * stride + x] = v & 255;
    }
  }
  return {
    w,
    h,
    rgba: (x, y) => {
      const i = (y * w + x) * bpp;
      if (ctype === 6) return [out[i]!, out[i + 1]!, out[i + 2]!, out[i + 3]!];
      if (ctype === 2) return [out[i]!, out[i + 1]!, out[i + 2]!, 255];
      if (ctype === 3 && pal) {
        const k = out[i]!;
        return [pal[k * 3]!, pal[k * 3 + 1]!, pal[k * 3 + 2]!, 255];
      }
      return [out[i]!, out[i]!, out[i]!, 255];
    },
  };
}

const root = 'rich4-assets';
const flc = parseFlc(new Uint8Array(readFileSync(`${root}/flic/panel/16.5176fe48.flc`)), 'm');
const f0 = decodeFlcFrames(flc)[0]!;
const atlas = JSON.parse(readFileSync(`${root}/sprites/panel/15.69e8196f.json`, 'utf8'));
const png = readdirPng(atlas.meta.image);
function readdirPng(name: string): ReturnType<typeof decodePng> {
  return decodePng(readFileSync(`${root}/sprites/panel/${name}`));
}
const B = atlas.frames['Panel#15/0'].frame;
let best: { x: number; y: number; s: number } | null = null;
for (let oy = 0; oy <= 210; oy++) {
  for (let ox = 100; ox <= 365; ox++) {
    let d = 0;
    let n = 0;
    for (let y = 0; y < flc.height; y += 5) {
      for (let x = 0; x < flc.width; x += 5) {
        const k = f0.pixels[y * flc.width + x]!;
        const c = [f0.palette[k * 3]!, f0.palette[k * 3 + 1]!, f0.palette[k * 3 + 2]!];
        const q = png.rgba(B.x + ox + x, B.y + oy + y);
        d += Math.abs(c[0]! - q[0]!) + Math.abs(c[1]! - q[1]!) + Math.abs(c[2]! - q[2]!);
        n++;
      }
    }
    const s = d / n;
    if (!best || s < best.s) best = { x: ox, y: oy, s };
  }
}
console.log('machine frame0 best at', best);
