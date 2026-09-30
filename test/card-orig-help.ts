// 调试脚本（卡片取证）：在 help.mkf（#1–99 Big5 说明文）里找卡片说明，确认卡片说明只出现在「說明」画面
// 用法：npx tsx test/card-orig-help.ts 均富卡
import { readFileSync } from 'node:fs';
import { MkfArchive } from '../tools/extract/src/mkf/container';
const help = MkfArchive.open(readFileSync('original/Game/help.mkf'), 'help');
const key = process.argv[2] ?? '均富卡';
const dec = new TextDecoder('big5');
for (let i = 1; i < help.count; i++) {
  const s = dec.decode(help.read(i)).replace(/\0+/g, '｜');
  if (s.includes(key)) console.log(`help#${i}: ${s.slice(0, 160)}`);
}
