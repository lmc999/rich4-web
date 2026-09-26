// 临时调试：整节线性扫描后，打印某 VA 前后若干条指令（带 Big5 串注释）
// 用法：npx tsx test/d2-around.ts <v206|v311> <va> [before=10] [after=30]
import { readFileSync } from 'node:fs';
import { decodeAt, formatInsn, type Insn } from '../tools/extract/src/exe/x86';
import { PeFile } from '../tools/extract/src/pe/scan';

const [ed, vaS, bS, aS] = process.argv.slice(2);
const exe = ed === 'v206' ? 'original/Game/rich4.exe' : 'original/MultiverseJourney/rich4.exe';
const f = new PeFile(new Uint8Array(readFileSync(exe)), ed);
const sp = f.spans('code')[0]!;
const insns: Insn[] = [];
for (let off = sp.off; off < sp.end; ) {
  const i = decodeAt(f.bytes, off, sp.va + (off - sp.off), sp.end);
  insns.push(i);
  off += i.len;
}
const target = Number.parseInt(vaS!, 16);
const k = insns.findIndex((i) => i.va + i.len > target);
const b = Number(bS ?? 10);
const a = Number(aS ?? 30);
for (let j = Math.max(0, k - b); j < Math.min(insns.length, k + a); j++) {
  const i = insns[j]!;
  const t = formatInsn(i);
  const notes: string[] = [];
  for (const m of t.matchAll(/0x(4[6-8][0-9a-f]{4})\b/g)) {
    const s = f.kindOfVa(Number.parseInt(m[1]!, 16)) === 'data' ? f.big5At(Number.parseInt(m[1]!, 16), 200) : null;
    if (s) notes.push(JSON.stringify(s));
  }
  console.log(
    `${i.va === target ? '>' : ' '}${i.va.toString(16)} ${t}${notes.length ? `   ; ${notes.join(' ')}` : ''}`,
  );
}
