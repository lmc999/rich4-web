// 临时调试：LZHUF 全量解压计时（只读 original/）
import { readFileSync } from 'node:fs';
import { lzhufDecompress } from '../tools/extract/src/mkf/lzhuf';
const files = ['Game/Data.mkf','Game/Panel.mkf','Game/jump.mkf','Game/map.mkf','MultiverseJourney/map.mkf'];
const jobs: [Uint8Array, number][] = [];
for (const f of files) {
  const b = new Uint8Array(readFileSync('original/' + f));
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const X = dv.getUint32(0, true); const N = (b.length - X) / 4;
  for (let i = 0; i < N; i++) { const o = dv.getUint32(X + 4 * i, true); const raw = dv.getUint32(o, true), st = dv.getUint32(o + 4, true); if (raw !== st) jobs.push([b.subarray(o + 16, o + 16 + st), raw]); }
}
for (let r = 0; r < 3; r++) { const t = Date.now(); for (const [s, n] of jobs) lzhufDecompress(s, n); console.log('run', r, Date.now() - t, 'ms'); }
