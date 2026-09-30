// 调试脚本（卡片取证）：读 Panel#11（卡片欄 / 道具欄 SMP）帧表，确认图0 尺寸与锚点；并按 exe 坐标把图0 与卡名格位画成样稿
// 用法：npx tsx test/card-orig-panel11.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { MkfArchive } from '../tools/extract/src/mkf/container';
import { encodePngRgba } from '../tools/extract/src/gfx/png';
import { putRgb555 } from '../tools/extract/src/gfx/rgb555';
const panel = MkfArchive.open(readFileSync('original/Game/Panel.mkf'), 'Panel');
const b = panel.read(11);
const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
const n = dv.getUint32(4, true);
let off = dv.getUint32(8, true);
const fr: { w: number; h: number; x: number; y: number; off: number }[] = [];
for (let i = 0; i < n; i++) {
  const e = 12 + 12 * i;
  const f = { w: dv.getInt16(e, true), h: dv.getInt16(e + 2, true), x: dv.getInt16(e + 4, true), y: dv.getInt16(e + 6, true), off };
  off += dv.getUint32(e + 8, true);
  fr.push(f);
  if (i < 3) console.log(`Panel#11 图${i} ${f.w}×${f.h} 锚点(${f.x},${f.y})`);
}
const f0 = fr[0]!;
const px = new Uint8Array(f0.w * f0.h * 4);
for (let p = 0; p < f0.w * f0.h; p++) putRgb555(px, p * 4, dv.getUint16(f0.off + 2 * p, true));
writeFileSync('.cache/card/orig/panel11-f0.png', encodePngRgba(f0.w, f0.h, px));
console.log('.cache/card/orig/panel11-f0.png');
