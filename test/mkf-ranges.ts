// 生成每个 MKF 的“编号区段 × 类型 × 压缩”概览（调试脚本），读取 mkf-survey 的 JSON
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const D = './.cache/assets-research/mkf-index/';
const out: Record<string, unknown[]> = {};
for (const f of readdirSync(D).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
  const j = JSON.parse(readFileSync(D + f, 'utf8'));
  const runs: { from: number; to: number; kind: string; comp: string; note: string; bytesRaw: number; bytesStored: number }[] = [];
  for (const e of j.entries) {
    let note = '';
    if (e.kind === 'SPR' || e.kind === 'SMP') note = '';
    if (e.kind === 'FLIC') note = `${e.detail.w}x${e.detail.h}`;
    if (e.kind === 'RAW16') note = `${e.uncompressed}B`;
    if (e.kind === 'GND') note = `${e.detail.w}x${e.detail.h} tiles`;
    const comp = e.compressed ? 'C' : 'U';
    const last = runs[runs.length - 1];
    if (last && last.kind === e.kind && last.comp === comp && last.to === e.i - 1 && (e.kind !== 'RAW16' || last.note === note) && e.kind !== 'DATA' && e.kind !== 'GND') {
      last.to = e.i; last.bytesRaw += e.uncompressed; last.bytesStored += e.stored;
      if (e.kind === 'FLIC' && last.note !== note && !last.note.includes('…')) last.note += '…';
    } else runs.push({ from: e.i, to: e.i, kind: e.kind, comp, note, bytesRaw: e.uncompressed, bytesStored: e.stored });
  }
  out[f.replace('.json', '')] = runs;
  console.log(`\n## ${f.replace('.json', '')}`);
  console.log(runs.map((r) => `${r.from === r.to ? r.from : `${r.from}-${r.to}`} ${r.kind}${r.comp === 'C' ? '(压缩)' : ''}${r.note ? ` ${r.note}` : ''}`).join('; '));
}
writeFileSync(D + '_ranges.json', JSON.stringify(out, null, 1));
