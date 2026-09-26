// 临时调试：线性扫描一段代码，把本项目 x86 解码器的指令边界/文本与 r2 pD 输出逐条比较
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { decodeAt, formatInsn } from '../tools/extract/src/exe/x86';
import { PeFile } from '../tools/extract/src/pe/scan';

const [ed, startS, lenS] = process.argv.slice(2);
const exe = ed === 'v206' ? 'original/Game/rich4.exe' : 'original/MultiverseJourney/rich4.exe';
const f = new PeFile(new Uint8Array(readFileSync(exe)), ed);
const start = Number.parseInt(startS!, 16);
const len = Number.parseInt(lenS!, 16);
const r2 = execFileSync(
  'r2',
  [
    '-q',
    '-e',
    'scr.color=0',
    '-e',
    'asm.bytes=false',
    '-e',
    'asm.comments=false',
    '-e',
    'asm.xrefs=false',
    '-e',
    'asm.lines=false',
    '-e',
    'asm.flags=false',
    '-e',
    'asm.functions=false',
    '-e',
    'asm.sub.names=false',
    '-c',
    `pD ${len} @ ${start}`,
    exe,
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 30 },
);
const r2map = new Map<number, string>();
for (const line of r2.split('\n')) {
  const m = line.match(/^\s*0x([0-9a-f]+)\s+(.*)$/);
  if (m) r2map.set(Number.parseInt(m[1]!, 16), m[2]!.trim());
}
let va = start;
let n = 0;
let bad = 0;
let textDiff = 0;
while (va < start + len) {
  const off = f.vaToOff(va);
  const i = decodeAt(f.bytes, off, va);
  const r = r2map.get(va);
  n++;
  if (r === undefined) {
    bad++;
    if (bad < 20) console.log('boundary mismatch at', va.toString(16), formatInsn(i));
  } else {
    const mine = formatInsn(i).replace(/0xffffffff/g, '-1');
    const norm = (s: string) =>
      s
        .replace(/\s+/g, ' ')
        .replace(/0xffffffffffffff([0-9a-f]{2})\b/g, (_, h) => String(Number.parseInt(h, 16) - 256))
        .replace(/-0x([0-9a-f]+)\b/g, (_, h) => String(-Number.parseInt(h, 16)))
        .replace(/0x([0-9a-f]+)\b/g, (_, h) => String(Number.parseInt(h, 16)))
        .replace(/\+ -/g, '- ');
    if (norm(mine) !== norm(r) && process.argv.includes('--text')) {
      textDiff++;
      if (textDiff < 60) console.log(va.toString(16), 'mine:', mine, '| r2:', r);
    }
  }
  va += i.len;
}
console.log(`insns ${n}, boundary mismatches ${bad}, text diffs ${textDiff}`);
