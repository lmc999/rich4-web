// 调试脚本（卡片取证）：读 Data.mkf 里与卡片相关 FLIC（495 得卡、516 怪兽卡、488 拆除卡）的头：尺寸、帧数、帧间隔
// 用法：npx tsx test/card-orig-flic-hdr.ts
import { readFileSync } from 'node:fs';
import { MkfArchive } from '../tools/extract/src/mkf/container';
const data = MkfArchive.open(readFileSync('original/Game/Data.mkf'), 'Data');
for (const i of [495, 516, 488]) {
  const b = data.read(i);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  console.log(
    `Data#${i} size=${dv.getUint32(0, true)} magic=0x${dv.getUint16(4, true).toString(16)} frames=${dv.getUint16(6, true)} ${dv.getUint16(8, true)}x${dv.getUint16(10, true)} depth=${dv.getUint16(12, true)} speed=${dv.getUint32(16, true)}`,
  );
}
