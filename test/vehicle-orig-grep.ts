// 临时调研（交通工具）：线性扫描代码段，按正则匹配反汇编文本（用于在 v3.11 里找与 v2.06 对应的指令）
// 用法：npx tsx test/vehicle-orig-grep.ts <v206|v311> '<正则>'
import { readFileSync } from 'node:fs';
import { decodeAt, formatInsn } from '../tools/extract/src/exe/x86';
import { PeFile } from '../tools/extract/src/pe/scan';

const [ed, re] = process.argv.slice(2);
const exe = ed === 'v206' ? 'original/Game/rich4.exe' : 'original/MultiverseJourney/rich4.exe';
const f = new PeFile(new Uint8Array(readFileSync(exe)), ed);
const sp = f.spans('code')[0]!;
const rx = new RegExp(re!);
for (let off = sp.off; off < sp.end; ) {
  const i = decodeAt(f.bytes, off, sp.va + (off - sp.off), sp.end);
  const t = formatInsn(i);
  if (rx.test(t)) console.log(`${i.va.toString(16)} ${t}`);
  off += i.len;
}
