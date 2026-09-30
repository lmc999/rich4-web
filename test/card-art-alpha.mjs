// 调研（出卡插画，只读）：逐张统计素材包 card.1..30（Data#530–559）的透明像素分布——
// 外缘 0–2px（装饰线外的黑边 / 圆角）、卡框带 3–11px、内部 ≥12px（插画里被泛洪掏空的洞），以及仍不透明的纯黑像素数。
// 输出 .cache/card/current/card-art-alpha.json 并打印表格。用法：node test/card-art-alpha.mjs [素材包目录=rich4-assets]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const DIR = process.argv[2] ?? 'rich4-assets';
const m = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const rows = [];
for (let k = 1; k <= 30; k++) {
  const e = m.entries[`card.${k}`];
  const png = PNG.sync.read(readFileSync(join(DIR, m.files[e.file].path)));
  const { width: w, height: h, data } = png;
  let edge = 0;
  let band = 0;
  let bandTotal = 0;
  let inner = 0;
  let opaqueBlack = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.min(x, y, w - 1 - x, h - 1 - y);
      const clear = data[i + 3] === 0;
      if (d >= 3 && d < 12) bandTotal++;
      if (clear) {
        if (d < 3) edge++;
        else if (d < 12) band++;
        else inner++;
      } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) opaqueBlack++;
    }
  const bandPct = Math.round((band / bandTotal) * 100);
  const verdict = inner > 50 ? '插画内部被掏洞 + 卡框透明' : bandPct > 30 ? '卡框透明（黑框被当底色）' : '仅外缘细环透明';
  rows.push({ card: k, key: `card.${k}`, src: e.src[0], transparency: e.transparency, edge, band, bandPct, inner, opaqueBlack, verdict });
}
writeFileSync('.cache/card/current/card-art-alpha.json', JSON.stringify(rows, null, 1));
for (const r of rows)
  console.log(
    [r.card, r.src, `edge=${r.edge}`, `band=${r.band}(${r.bandPct}%)`, `inner=${r.inner}`, `opaqueBlack=${r.opaqueBlack}`, r.verdict].join('\t'),
  );
