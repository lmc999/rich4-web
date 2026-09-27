// 调试脚本（A2）：在本机原版文件上跑 buildPack（默认只做图像部分），输出到 .cache/assets-a2/pack-*。
// 用法：npx tsx test/skin-a2-build.ts [parts=board,ui,fx,minigame] [out=.cache/assets-a2/pack-images]
import { buildPack, parseParts } from '../tools/extract/src/assets/build';
import { ExtractContext } from '../tools/extract/src/context';

const parts = parseParts(process.argv[2] ?? 'board,ui,fx,minigame');
const out = process.argv[3] ?? '.cache/assets-a2/pack-images';
const t0 = process.hrtime.bigint();
const ctx = new ExtractContext();
const r = await buildPack({ ctx, outDir: out, only: parts, jobs: 8 });
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(JSON.stringify({ ms, packId: r.manifest.packId, sha: r.manifestSha256, total: r.totalBytes, warnings: r.warnings.slice(0, 20), pruned: r.pruned.length, coverage: r.coverage.totals, pct: r.coverage.percent }, null, 1));
const groups = Object.entries(r.groupBytes).sort((a, b) => b[1] - a[1]);
for (const [g, b] of groups) console.log(`${g.padEnd(28)} ${(b / 1048576).toFixed(2)} MB`);
