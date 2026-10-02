// 临时调研：线性扫描 v2.06 / v3.11 代码段，列出引用某个数据地址（玩家结构字段）的全部指令
// 用法：npx tsx test/vehicle-orig-scan.ts <v206|v311> <va>[,<va>...] [--write]
import { readFileSync } from 'node:fs';
import { decodeAt, formatInsn, type Insn } from '../tools/extract/src/exe/x86';
import { PeFile } from '../tools/extract/src/pe/scan';

const [ed, vasS, flag] = process.argv.slice(2);
const exe = ed === 'v206' ? 'original/Game/rich4.exe' : 'original/MultiverseJourney/rich4.exe';
const f = new PeFile(new Uint8Array(readFileSync(exe)), ed);
const sp = f.spans('code')[0]!;
const insns: Insn[] = [];
for (let off = sp.off; off < sp.end; ) {
  const i = decodeAt(f.bytes, off, sp.va + (off - sp.off), sp.end);
  insns.push(i);
  off += i.len;
}
const pats = vasS!.split(',').map((v) => `0x${Number.parseInt(v, 16).toString(16)}`);
for (const i of insns) {
  const t = formatInsn(i);
  if (!pats.some((p) => new RegExp(`${p}\\b`).test(t))) continue;
  if (flag === '--write' && !/^(mov|inc|dec|add|sub|and|or|xor|shl|shr|sar|neg|not)\w* (byte|word|dword) \[/.test(t)) continue;
  console.log(`${i.va.toString(16)} ${t}`);
}
