// 调试（卡片插画不透明修复）：统计 PNG 里 alpha=0 的像素数。
// 用法：npx tsx test/card-impl-alpha.ts <png>...；不带参数时统计 rich4-assets 里 card.1–30 与调研样图 Data#530。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPng } from '../tools/extract/src/assets/pngRead';

function count(path: string): string {
  const p = readPng(new Uint8Array(readFileSync(path)));
  let z = 0;
  for (let i = 0; i < p.w * p.h; i++) if (p.rgba[i * 4 + 3] === 0) z++;
  return `${p.w}×${p.h} alpha0=${z}`;
}

const args = process.argv.slice(2);
if (args.length > 0) {
  for (const a of args) console.log(a, count(a));
} else {
  const pack = 'rich4-assets';
  const m = JSON.parse(readFileSync(join(pack, 'manifest.json'), 'utf8')) as {
    entries: Record<string, { file: string; transparency?: string; confidence: string }>;
    files: Record<string, { path: string }>;
  };
  for (let k = 1; k <= 30; k++) {
    const e = m.entries[`card.${k}`]!;
    console.log(`card.${k}`, e.transparency, e.confidence, m.files[e.file]!.path, count(join(pack, m.files[e.file]!.path)));
  }
  console.log('sample Data#530', count('.cache/assets-research/samples/Data/530_0.png'));
}
