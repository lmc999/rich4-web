// 临时调试：列出代码中 imm32/disp32 落在 [lo, lo+span) 的位置（按指令解码核对）
import { readFileSync } from 'node:fs';
import { decodeAt, formatInsn } from '../tools/extract/src/exe/x86';
import { PeFile } from '../tools/extract/src/pe/scan';

const [ed, loS, spanS] = process.argv.slice(2);
const exe = ed === 'v206' ? 'original/Game/rich4.exe' : 'original/MultiverseJourney/rich4.exe';
const f = new PeFile(new Uint8Array(readFileSync(exe)), ed);
const lo = Number.parseInt(loS!, 16);
const span = Number(spanS ?? 1);
const sp = f.spans('code')[0]!;
for (let off = sp.off; off < sp.end; ) {
  const i = decodeAt(f.bytes, off, sp.va + (off - sp.off), sp.end);
  for (const o of i.ops) {
    const v = o.t === 'imm' ? o.value >>> 0 : o.t === 'mem' && o.dispSize === 4 ? o.dispU : null;
    if (v !== null && v >= lo && v < lo + span) console.log(i.va.toString(16), formatInsn(i));
  }
  off += i.len;
}
