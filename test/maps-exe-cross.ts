/** 调研脚本：核对 exe 股票 / 节日两版（v2.06、v3.11）在 gm 0..3 上按 MapDef 口径是否一致（读 .cache/extract/tables.*.json）。 */
import { readFileSync } from 'node:fs';
import { holidaysForMap, stocksForMap } from '../tools/extract/src/exe/mapData';
import type { ExtractedTables } from '../tools/extract/src/exe/types';
import { canonicalJson } from '../tools/extract/src/io/writeCanonicalJson';

const load = (e: string) => JSON.parse(readFileSync(`.cache/extract/tables.${e}.json`, 'utf8')) as ExtractedTables;
const a = load('v206');
const b = load('v311');
for (const gm of [0, 1, 2, 3]) {
  const s = canonicalJson(stocksForMap(a, gm)) === canonicalJson(stocksForMap(b, gm));
  const ha = holidaysForMap(a, gm);
  const h = canonicalJson(ha) === canonicalJson(holidaysForMap(b, gm));
  const k2 = ha.holidays.filter((x) => x.kind === 2).map((x) => `${x.month}月第${x.day}个星期${x.weekday}`);
  console.log(`gm ${gm}: stocks ${s ? '一致' : '不同'}  holidays ${h ? '一致' : '不同'}  条数 ${ha.holidays.length} 停用 ${ha.dropped.length} 空 ${ha.empty}  农历 ${ha.holidays.filter((x) => x.lunar).length}  kind2 ${k2.join('、') || '-'}`);
}
