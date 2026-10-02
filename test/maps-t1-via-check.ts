/**
 * T1 调试脚本：去掉某条 edgeRoute（与可选的 lot）后，打印自动选出的连接格（格点坐标），用来写 overrides 的 notes。
 * 用法（仓库根）：npx tsx test/maps-t1-via-check.ts <key> <a-b> <a> <b> [lotKey]
 */
import { readFileSync } from 'node:fs';
import { ExtractContext } from '../tools/extract/src/context';
import { loadKnownFiles } from '../tools/extract/src/fingerprint/identify';
import { buildMapDef } from '../tools/extract/src/map/build';
import { parseOverrides } from '../tools/extract/src/map/overrides';
import { MAP_KEYS } from '../tools/extract/src/map/pack';
import { loadRawSource, sourceDef } from '../tools/extract/src/map/sources';
const [key, route, a, b] = process.argv.slice(2);
const ctx = new ExtractContext({ logger: { out: () => {}, err: () => {} } });
const base = JSON.parse(readFileSync(`tools/extract/maps/${key}.overrides.json`, 'utf8'));
delete base.edgeRoute[route!];
const lotKey = process.argv[6];
if (lotKey) delete base.lot[lotKey];
const { raw } = await loadRawSource(ctx, sourceDef(base.source.id), MAP_KEYS[key!]!, await loadKnownFiles(ctx.packageDir));
const r = buildMapDef(raw, parseOverrides(base), { mapKey: key!, strict4: true });
const sh = r.geometry.report.bounds.shift;
const t = r.def.tiles.find((x) => x.id === Number(a))!;
const l = t.links.find((x) => x.to === Number(b))!;
console.log(key, route, 'default via (lattice):', (l.via ?? []).map((c) => `(${c.x - sh.x},${c.y - sh.y})`).join(' '));
