// 调试：打印本机素材包里若干精灵表每帧的尺寸与锚点（像素），只读 rich4-assets/，不输出任何像素
// 用法：node test/w3-atlas-geom.mjs panel/11 data/0 …
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.W3_PACK_DIR ?? 'rich4-assets';
for (const arg of process.argv.slice(2)) {
  const [dir, res] = arg.split('/');
  const d = join(root, 'sprites', dir);
  const file = readdirSync(d).find((f) => f.startsWith(`${res}.`) && f.endsWith('.json'));
  if (!file) {
    console.log('缺', arg);
    continue;
  }
  const atlas = JSON.parse(readFileSync(join(d, file), 'utf8'));
  const rows = Object.entries(atlas.frames)
    .map(([k, v]) => ({ i: Number(k.split('/')[1]), v }))
    .sort((a, b) => a.i - b.i);
  console.log(`== ${arg}（${rows.length} 帧）`);
  for (const { i, v } of rows) {
    const s = v.sourceSize;
    const ax = Math.round(v.anchor.x * s.w);
    const ay = Math.round(v.anchor.y * s.h);
    console.log(`  ${i}: ${s.w}×${s.h} 锚点 (${ax},${ay})`);
  }
}
