// 调试脚本（A2）：比较 brotli 质量档位在大 FLC 上的耗时与体积
import { readFileSync } from 'node:fs';
import { brotliCompressSync, constants as zc, gzipSync } from 'node:zlib';
import { MkfArchive } from '../tools/extract/src/mkf/container';
const a = MkfArchive.open(readFileSync('original/Game/Panel.mkf'), 'Panel');
const d = a.read(20);
for (const q of [5, 9, 10, 11]) {
  const t = performance.now();
  const b = brotliCompressSync(d, { params: { [zc.BROTLI_PARAM_QUALITY]: q, [zc.BROTLI_PARAM_LGWIN]: 22, [zc.BROTLI_PARAM_SIZE_HINT]: d.length } });
  console.log('q', q, d.length, b.length, (performance.now() - t).toFixed(0), 'ms');
}
const t = performance.now();
const g = gzipSync(d, { level: 9 });
console.log('gz9', g.length, (performance.now() - t).toFixed(0), 'ms');
