// 调试脚本（A2）：列出 Data/Panel/jump/map/help 各资源的 kind、帧数、首帧尺寸与锚点、索引 255 像素数，用于编写 catalog.v206。
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { MkfArchive } from '../tools/extract/src/mkf/container';
import { parseSpr, countOwnerPixels } from '../tools/extract/src/gfx/spr';
import { parseSmp } from '../tools/extract/src/gfx/smp';
import { parseFlc } from '../tools/extract/src/gfx/flc';

const root = path.resolve(import.meta.dirname, '..');
const out: Record<string, unknown[]> = {};
for (const f of ['Data', 'Panel', 'jump', 'map', 'help']) {
  const bytes = readFileSync(path.join(root, 'original/Game', `${f}.mkf`));
  const a = MkfArchive.open(bytes, f);
  const rows: unknown[] = [];
  for (const e of a.entries()) {
    const row: Record<string, unknown> = { i: e.index, kind: e.kind, raw: e.rawSize, z: e.compressed };
    if (e.kind === 'SPR' || e.kind === 'SMP') {
      const d = a.read(e.index);
      const s = e.kind === 'SPR' ? parseSpr(d) : parseSmp(d);
      row.n = s.count;
      const sizes = new Map<string, number>();
      let zero = 0;
      for (const fr of s.frames) {
        if (fr.w === 0 || fr.h === 0) zero++;
        const k = `${fr.w}x${fr.h}@${fr.ax},${fr.ay}`;
        sizes.set(k, (sizes.get(k) ?? 0) + 1);
      }
      row.sizes = [...sizes.entries()].slice(0, 4).map(([k, v]) => `${k}×${v}`).join(' ') + (sizes.size > 4 ? ` …(${sizes.size})` : '');
      if (zero) row.zero = zero;
      if (e.kind === 'SPR') row.o255 = countOwnerPixels(s as ReturnType<typeof parseSpr>);
    } else if (e.kind === 'FLIC') {
      const fl = parseFlc(a.read(e.index));
      row.flc = `${fl.width}x${fl.height} n=${fl.frames} ms=${fl.speed}`;
    }
    rows.push(row);
  }
  out[f] = rows;
}
mkdirSync(path.join(root, '.cache/assets-a2'), { recursive: true });
writeFileSync(path.join(root, '.cache/assets-a2/survey.json'), JSON.stringify(out, null, 1));
for (const [f, rows] of Object.entries(out)) {
  console.log(`== ${f}`);
  for (const r of rows as Record<string, unknown>[]) console.log(JSON.stringify(r));
}
