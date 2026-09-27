// 汇总检查：压缩资源的结构自洽性 + v2.06/v3.11 map.mkf 同内容比对（调试脚本）
import { readFileSync } from 'node:fs';
const D = './.cache/assets-research/mkf-index';
const names = ['v206-Data.mkf','v206-Panel.mkf','v206-Speaking.mkf','v206-Effect.mkf','v206-jump.mkf','v206-help.mkf','v206-map.mkf','v206-MapDat.MKF','v311-map.mkf'];
const all: Record<string, any> = {};
for (const n of names) all[n] = JSON.parse(readFileSync(`${D}/${n}.json`, 'utf8'));
for (const n of names) {
  const j = all[n];
  const comp = j.entries.filter((e: any) => e.compressed);
  const byKind: Record<string, { n: number; stored: number; raw: number; structOk: number; structBad: number[] }> = {};
  for (const e of comp) {
    const k = (byKind[e.kind] ??= { n: 0, stored: 0, raw: 0, structOk: 0, structBad: [] });
    k.n++; k.stored += e.stored; k.raw += e.uncompressed;
    let ok: boolean | null = null;
    if (e.kind === 'SPR' || e.kind === 'SMP') ok = e.detail.layoutExact;
    else if (e.kind === 'FLIC') ok = e.detail.sizeEqRaw;
    if (ok === true) k.structOk++; else if (ok === false) k.structBad.push(e.i);
  }
  const idx = comp.map((e: any) => e.i);
  const ranges: string[] = [];
  for (let a = 0; a < idx.length; ) { let b = a; while (b + 1 < idx.length && idx[b + 1] === idx[b] + 1) b++; ranges.push(a === b ? `${idx[a]}` : `${idx[a]}-${idx[b]}`); a = b + 1; }
  console.log(`\n== ${n}: count=${j.count} compressed=${comp.length} ranges=[${ranges.join(',')}]`);
  for (const [k, v] of Object.entries(byKind)) console.log(`  ${k}: n=${v.n} stored=${v.stored} raw=${v.raw} ratio=${(v.stored / v.raw).toFixed(3)} structOk=${v.structOk} structBad=${JSON.stringify(v.structBad)}`);
  // all-kinds struct check (uncompressed too)
  const bad = j.entries.filter((e: any) => (e.kind === 'SPR' || e.kind === 'SMP') ? !e.detail.layoutExact : e.kind === 'FLIC' ? !e.detail.sizeEqRaw : false).map((e: any) => e.i);
  console.log(`  all-entries struct mismatch: ${JSON.stringify(bad)}`);
}
// map.mkf cross-version
const a = all['v206-map.mkf'].entries, b = all['v311-map.mkf'].entries;
const bSha = new Map<string, number[]>();
for (const e of b) { const l = bSha.get(e.payloadSha1) ?? []; l.push(e.i); bSha.set(e.payloadSha1, l); }
let same = 0, sameIdx = 0, compMatch: string[] = [];
for (const e of a) {
  const m = bSha.get(e.payloadSha1);
  if (m) { same++; if (m.includes(e.i)) sameIdx++;
    const eb = b[m[0]!];
    if (e.compressed || eb.compressed) compMatch.push(`v206#${e.i}(${e.compressed ? 'C' : 'U'} ${e.stored}/${e.uncompressed}) == v311#${m.join('/')}(${eb.compressed ? 'C' : 'U'} ${eb.stored}/${eb.uncompressed}) ${e.kind}`);
  }
}
console.log(`\nmap.mkf v206 ${a.length} 项中 ${same} 项在 v311 找到相同 payload（其中同号 ${sameIdx}）`);
console.log(compMatch.join('\n'));
// compressed in one version, uncompressed in the other (by sha)
