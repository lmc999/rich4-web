// 调试（头像映射排查）：把真实素材包里按角色号取的 FLIC（棋盘伞 char.<c>.parachute、表情 char.<c>.emoteA/B、
// 开局自由落体 title.freefall.<c>、开伞 title.parachuteOpen.<c>）各抽一帧写成 PNG，行 = 角色号，目视核对是不是同一个人物。
// 输出 .cache/pc/portrait/flic/<键>.png 与 flics.html（含原版素材，不入库）。用法：npx tsx test/pc-char-flics.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { FlcDecoder, parseFlc } from '../apps/client/src/skin/flic/FlcDecoder';

const PACK = resolve('rich4-assets');
const OUT = resolve('.cache/pc/portrait/flic');
mkdirSync(OUT, { recursive: true });
const m = JSON.parse(readFileSync(join(PACK, 'manifest.json'), 'utf8'));
const KINDS: [string, (c: number) => string, number][] = [
  ['parachute', (c) => `char.${c}.parachute`, 0.6],
  ['emoteA', (c) => `char.${c}.emoteA`, 0.5],
  ['emoteB', (c) => `char.${c}.emoteB`, 0.5],
  ['freefall', (c) => `title.freefall.${c}`, 0.5],
  ['open', (c) => `title.parachuteOpen.${c}`, 0.8],
];
const rows: string[] = [];
for (let c = 0; c < 12; c++) {
  const cells: string[] = [];
  for (const [, keyOf, at] of KINDS) {
    const key = keyOf(c);
    const e = m.entries[key];
    if (!e || e.type !== 'flic') {
      cells.push('<td>—</td>');
      continue;
    }
    const f = m.files[e.file];
    const flc = parseFlc(new Uint8Array(readFileSync(join(PACK, f.path))), key);
    const d = new FlcDecoder(flc);
    d.seek(Math.floor((flc.chunks.length - 1) * at));
    const png = new PNG({ width: flc.width, height: flc.height });
    d.toRgba(png.data);
    const file = join(OUT, `${key}.png`);
    writeFileSync(file, PNG.sync.write(png));
    const s = Math.min(1, 160 / Math.max(flc.width, flc.height));
    cells.push(
      `<td style="border:1px solid #889"><img src="file://${file}" style="width:${flc.width * s}px;height:${flc.height * s}px"></td>`,
    );
  }
  rows.push(`<tr><td>${c}</td>${cells.join('')}</tr>`);
}
writeFileSync(
  join(OUT, 'flics.html'),
  `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#556;color:#fff;font:12px sans-serif"><table><tr><th>c</th>${KINDS.map(([k]) => `<th>${k}</th>`).join('')}</tr>${rows.join('')}</table></body>`,
);
console.log('ok', join(OUT, 'flics.html'));
