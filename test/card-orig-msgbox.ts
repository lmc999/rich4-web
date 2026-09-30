// 调试脚本（卡片取证）：读 Data#476（SMP 共享 UI）帧表，确认 +0x48 = 图5 的尺寸与锚点，并按原版坐标合成「用卡」画面样稿
// 用法：npx tsx test/card-orig-msgbox.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MkfArchive } from '../tools/extract/src/mkf/container';
import { encodePngRgba } from '../tools/extract/src/gfx/png';
import { putRgb555 } from '../tools/extract/src/gfx/rgb555';

const OUT = '.cache/card/orig';
mkdirSync(OUT, { recursive: true });
const data = MkfArchive.open(readFileSync('original/Game/Data.mkf'), 'Data');
const smp = data.read(476);
const dv = new DataView(smp.buffer, smp.byteOffset, smp.byteLength);
const sig = String.fromCharCode(...smp.subarray(0, 4));
const n = dv.getUint32(4, true);
const start = dv.getUint32(8, true);
console.log(`Data#476 sig=${JSON.stringify(sig)} frames=${n} start=${start}`);
const frames: { w: number; h: number; x: number; y: number; g: number; off: number }[] = [];
let off = start;
for (let i = 0; i < n; i++) {
  const b = 12 + 12 * i;
  const f = { w: dv.getInt16(b, true), h: dv.getInt16(b + 2, true), x: dv.getInt16(b + 4, true), y: dv.getInt16(b + 6, true), g: dv.getUint32(b + 8, true), off };
  off += f.g;
  frames.push(f);
  console.log(`图${i} 帧表偏移 +0x${b.toString(16)} ${f.w}×${f.h} 锚点(${f.x},${f.y})`);
}

// 按 exe fcn.00440bac 的坐标合成：640×480 画面，棋盘区 (0,40)-(440,480) 铺灰；
// 图5 以锚点画在 (220,129)（fcn.00454a78→fcn.004542b2 色键 0x0000）；卡图不透明画在 (138,200)（fcn.00454a55→fcn.0045419a rep movs）
const W = 640;
const H = 480;
const rgba = new Uint8Array(W * H * 4);
for (let y = 40; y < 480; y++) for (let x = 0; x < 440; x++) putRgb555(rgba, (y * W + x) * 4, 0x4210);
const f5 = frames[5]!;
for (let yy = 0; yy < f5.h; yy++)
  for (let xx = 0; xx < f5.w; xx++) {
    const v = dv.getUint16(f5.off + 2 * (yy * f5.w + xx), true);
    if (v === 0) continue;
    const X = 220 - f5.x + xx;
    const Y = 129 - f5.y + yy;
    if (X >= 0 && X < W && Y >= 0 && Y < H) putRgb555(rgba, (Y * W + X) * 4, v);
  }
const card = Number(process.argv[2] ?? 10);
const art = data.read(529 + card);
for (let yy = 0; yy < 256; yy++)
  for (let xx = 0; xx < 165; xx++) {
    const v = art[2 * (yy * 165 + xx)]! | (art[2 * (yy * 165 + xx) + 1]! << 8);
    putRgb555(rgba, ((200 + yy) * W + 138 + xx) * 4, v);
  }
writeFileSync(`${OUT}/mock-cardshow-k${card}.png`, encodePngRgba(W, H, rgba));
console.log(`box 图5 左上 = (${220 - f5.x},${129 - f5.y}) 右下 = (${220 - f5.x + f5.w},${129 - f5.y + f5.h})；card (138,200)-(303,456)`);
console.log(`${OUT}/mock-cardshow-k${card}.png`);

// 另存 Data#476 图5（色键 0x0000 → 透明），给 HTML 样稿用
{
  const f = frames[5]!;
  const px = new Uint8Array(f.w * f.h * 4);
  for (let p = 0; p < f.w * f.h; p++) {
    const v = dv.getUint16(f.off + 2 * p, true);
    if (v !== 0) putRgb555(px, p * 4, v);
  }
  writeFileSync(`${OUT}/data476-f5.png`, encodePngRgba(f.w, f.h, px));
}
