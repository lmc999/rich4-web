// 调试脚本（卡片取证）：打印卡片 RAW16 四角与边缘的 0 值分布（'.'=0x0000，'#'=非 0），看透明方式
// 用法：npx tsx test/card-orig-corner.ts 530 539
import { readFileSync } from 'node:fs';
import { MkfArchive } from '../tools/extract/src/mkf/container';
const data = MkfArchive.open(readFileSync('original/Game/Data.mkf'), 'Data');
const W = 165;
const H = 256;
for (const a of process.argv.slice(2)) {
  const i = Number(a);
  const b = data.read(i);
  const v = (x: number, y: number) => b[2 * (y * W + x)]! | (b[2 * (y * W + x) + 1]! << 8);
  console.log(`== Data#${i} 左上 24×16`);
  for (let y = 0; y < 16; y++) console.log(Array.from({ length: 24 }, (_, x) => (v(x, y) ? '#' : '.')).join(''));
  console.log(`== Data#${i} 右下 24×16`);
  for (let y = H - 16; y < H; y++) console.log(Array.from({ length: 24 }, (_, x) => (v(W - 24 + x, y) ? '#' : '.')).join(''));
  // 每行 0 值个数（整图），看是否整条边框/大块黑
  const perRow = Array.from({ length: H }, (_, y) => {
    let n = 0;
    for (let x = 0; x < W; x++) if (!v(x, y)) n++;
    return n;
  });
  console.log('rows zero count:', perRow.join(','));
}
