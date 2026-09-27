// 临时调试：对比生产 LZHUF 与调研原型在全部压缩资源上的输出（只读 original/）
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lzhufDecompress, emptyLzhufStats } from '../tools/extract/src/mkf/lzhuf';
import { lzhufDecompress as proto } from './lzhuf-proto';
const files = ['Game/Data.mkf','Game/Panel.mkf','Game/Speaking.mkf','Game/Effect.mkf','Game/jump.mkf','Game/help.mkf','Game/map.mkf','Game/MapDat.MKF','MultiverseJourney/map.mkf'];
let n = 0, total = 0; const t0 = Date.now(); let tp = 0;
for (const f of files) {
  const b = new Uint8Array(readFileSync('original/' + f));
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const X = dv.getUint32(0, true); const N = (b.length - X) / 4; total += N;
  for (let i = 0; i < N; i++) {
    const o = dv.getUint32(X + 4 * i, true);
    const raw = dv.getUint32(o, true), st = dv.getUint32(o + 4, true);
    if (raw === st) continue;
    const src = b.subarray(o + 16, o + 16 + st);
    const s = emptyLzhufStats();
    const a = lzhufDecompress(src, raw, { stats: s });
    const t1 = Date.now(); const p = proto(src, raw); tp += Date.now() - t1;
    if (Buffer.compare(Buffer.from(a), Buffer.from(p)) !== 0) console.log('DIFF', f, i);
    n++;
  }
}
console.log('ok', n, 'of', total, 'ms', Date.now() - t0, 'proto ms', tp);
