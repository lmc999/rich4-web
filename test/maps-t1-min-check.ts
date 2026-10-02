/**
 * T1 调试脚本：去掉 overrides 里的某条 lot / nodeCell 后，比较几何（地块、企业矩形、路格、连接格）是否与原来相同，
 * 用来判断一条 override 是否只是把自动结果钉住。只读，不写文件。用法（仓库根）：npx tsx test/maps-t1-min-check.ts
 */
import { readFileSync } from 'node:fs';
import { ExtractContext } from '../tools/extract/src/context';
import { loadKnownFiles } from '../tools/extract/src/fingerprint/identify';
import { buildMapDef } from '../tools/extract/src/map/build';
import { parseOverrides } from '../tools/extract/src/map/overrides';
import { MAP_KEYS } from '../tools/extract/src/map/pack';
import { loadRawSource, sourceDef } from '../tools/extract/src/map/sources';
const ctx = new ExtractContext({ logger: { out: () => {}, err: () => {} } });
const known = await loadKnownFiles(ctx.packageDir);
async function run(key: string, edit: (o: any) => void) {
  const base = JSON.parse(readFileSync(`tools/extract/maps/${key}.overrides.json`, 'utf8'));
  const { raw } = await loadRawSource(ctx, sourceDef(base.source.id), MAP_KEYS[key]!, known);
  const h0 = buildMapDef(raw, parseOverrides(base), { mapKey: key, strict4: true });
  const n = structuredClone(base); edit(n);
  const h1 = buildMapDef(raw, parseOverrides(n), { mapKey: key, strict4: true });
  const pick = (r: any) => JSON.stringify({ lots: r.def.lots.map((l: any) => [l.id, l.rect]), c: r.def.companies.map((l: any) => [l.id, l.rect]), t: r.def.tiles.map((t: any) => [t.id, t.cell]), rc: r.def.roadCells });
  console.log(key, 'same geometry:', pick(h0) === pick(h1), 'disp101/103');
}
await run('china', (o) => { delete o.lot.C1; });
await run('china', (o) => { delete o.lot.C2; });
await run('china', (o) => { delete o.lot.F7; });
await run('usa', (o) => { delete o.lot.L16; });
await run('usa', (o) => { delete o.lot.C2; });
await run('japan', (o) => { delete o.lot.C2; });
await run('japan', (o) => { delete o.nodeCell['103']; });
await run('japan', (o) => { delete o.nodeCell['101']; });
