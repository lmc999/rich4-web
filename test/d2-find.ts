// 临时调试：按文本找 Big5 串的 VA，并列出代码中对该 VA 的 imm32 引用
// 用法：npx tsx test/d2-find.ts <v206|v311> <文本片段…>
import { readFileSync } from 'node:fs';
import { Big5StringIndex, hexVa, PeFile } from '../tools/extract/src/pe/scan';

const [ed, ...needles] = process.argv.slice(2);
const exe = ed === 'v206' ? 'original/Game/rich4.exe' : 'original/MultiverseJourney/rich4.exe';
const file = new PeFile(new Uint8Array(readFileSync(exe)), ed);
const idx = Big5StringIndex.build(file);
for (const n of needles) {
  for (const e of idx.entries()) {
    if (!e.text.includes(n)) continue;
    const refs = file.findU32InRange(e.va, e.va + 1, 'code').map((r) => hexVa(r.at));
    const drefs = file.findU32(e.va, 'data').map(hexVa);
    console.log(hexVa(e.va), JSON.stringify(e.text), 'code:', refs.join(','), 'data:', drefs.join(','));
  }
}
