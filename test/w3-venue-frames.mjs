// 调试（A12）：把图集里的若干帧并排放大拼成一张图（带网格），输出到 .cache/w3-venues/（含原版像素，只在本机看）
// 用法：node test/w3-venue-frames.mjs <atlas.json> <atlas.png> <倍率> <输出名> <帧名...>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [, , atlasJson, pngFile, k, outName, ...names] = process.argv;
const atlas = JSON.parse(readFileSync(atlasJson, 'utf8'));
// 逐帧调用 w3-venue-crop（简单起见：每帧一个文件，名字加序号）
for (const [i, n] of names.entries()) {
  const f = atlas.frames[n].frame;
  execFileSync('node', ['test/w3-venue-crop.mjs', atlasJson, pngFile, n, '0', '0', String(f.w), String(f.h), k, `${outName}-${i}`], { stdio: 'inherit' });
}
