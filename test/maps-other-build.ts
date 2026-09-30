/**
 * 调研脚本（不入库流程）：对原版 gm 1/2/3 跑 map build 同款流程（语义层 + 几何归一化 + validateMap + exe 股票/节日），
 * 不走 CLI（CLI 的 MAP_KEYS 只认 taiwan），输出全部写到 .cache/maps/<key>.*，不写 rich4-data/、不写 docs/。
 *
 * 用法（仓库根）：npx tsx test/maps-other-build.ts [--gm 1,2,3] [--source v206-mapdat] [--ov <dir>]
 *   --ov <dir>：从 <dir>/<key>.overrides.json 读 overrides（缺省为空 overrides → 自动格点）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateMap } from '@rich4/shared/data';
import { ExtractContext } from '../tools/extract/src/context';
import { companyStockChecks, holidaysForMap, stocksForMap } from '../tools/extract/src/exe/mapData';
import type { ExtractedTables } from '../tools/extract/src/exe/types';
import { loadKnownFiles } from '../tools/extract/src/fingerprint/identify';
import { canonicalJson } from '../tools/extract/src/io/writeCanonicalJson';
import { buildMapDef } from '../tools/extract/src/map/build';
import { emptyOverrides, parseOverrides } from '../tools/extract/src/map/overrides';
import { loadRawSource, sourceDef } from '../tools/extract/src/map/sources';
import { renderPreviewSvg } from '../tools/extract/src/report/previewSvg';

const KEYS: Record<number, string> = { 0: 'taiwan', 1: 'china', 2: 'japan', 3: 'usa' };
const { values: v } = parseArgs({
  options: { gm: { type: 'string' }, source: { type: 'string' }, ov: { type: 'string' }, out: { type: 'string' } },
});
const gms = (v.gm ?? '1,2,3').split(',').map(Number);
const sourceId = (v.source ?? 'v206-mapdat') as 'v206-mapdat';
const ctx = new ExtractContext({ logger: { out: () => {}, err: () => {} } });
const outDir = path.resolve(ctx.root, v.out ?? '.cache/maps');
mkdirSync(path.join(outDir, 'preview'), { recursive: true });

const tables = JSON.parse(readFileSync(path.join(ctx.root, '.cache/extract/tables.v206.json'), 'utf8')) as ExtractedTables;
const known = await loadKnownFiles(ctx.packageDir);

for (const gm of gms) {
  const key = KEYS[gm]!;
  const ovFile = v.ov ? path.resolve(ctx.root, v.ov, `${key}.overrides.json`) : null;
  const ov =
    ovFile && existsSync(ovFile)
      ? parseOverrides(JSON.parse(readFileSync(ovFile, 'utf8')), ovFile)
      : emptyOverrides(key, sourceId);
  const { raw } = await loadRawSource(ctx, sourceDef(ov.source.id), gm, known);
  const stocks = stocksForMap(tables, gm);
  const hol = holidaysForMap(tables, gm);
  let r: ReturnType<typeof buildMapDef>;
  try {
    r = buildMapDef(raw, ov, { mapKey: key, strict4: true, stocks, holidays: hol.holidays });
  } catch (e) {
    console.log(`=== gm ${gm} ${key}: 构建抛错 ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const geo = r.geometry.report;
  const nonStrict = validateMap(r.def, {});
  const byCode = (list: { code: string; severity: string }[]) => {
    const m: Record<string, number> = {};
    for (const i of list) m[`${i.severity}:${i.code}`] = (m[`${i.severity}:${i.code}`] ?? 0) + 1;
    return m;
  };
  console.log(`=== gm ${gm} ${key}  source ${raw.source.id} resourceSha256 ${raw.source.resourceSha256}`);
  console.log(`  exit ${r.exitCode}  grid ${r.def.grid.w}x${r.def.grid.h}  counts ${JSON.stringify(r.def.meta.counts)}`);
  const lat = geo.lattice;
  console.log(
    `  lattice ${lat.mode} T=${lat.tile} origin (${lat.origin.join(',')}) probe32 cov ${(lat.probe32.coverage * 100).toFixed(1)}% score ${JSON.stringify(lat.score)}`,
  );
  console.log(`  axialLengths ${JSON.stringify(lat.axialLengths)}`);
  console.log(`  edgeDirections ${JSON.stringify(lat.edgeDirections)} steps ${JSON.stringify(lat.steps)}`);
  console.log(`  edges ${JSON.stringify(geo.edgeKinds)} routes ${JSON.stringify(geo.routes)}`);
  console.log(
    `  facing ${JSON.stringify(geo.facing)}\n  landsRelaxed ${geo.landsRelaxed.join(',') || '-'}  offSide ${geo.landsOffSide.join(',') || '-'}  cornerFlips ${geo.cornerFlips.join(',') || '-'}  unlinkedAdj ${JSON.stringify(geo.unlinkedAdjacent)}`,
  );
  console.log(`  terrain ${JSON.stringify(geo.terrain)} hiddenLandmarks ${geo.hiddenLandmarks.join(',') || '-'}`);
  const gi: Record<string, number> = {};
  for (const i of geo.issues) gi[`${i.severity}:${i.code}`] = (gi[`${i.severity}:${i.code}`] ?? 0) + 1;
  console.log(`  geo issues ${JSON.stringify(gi)}`);
  for (const i of geo.issues.filter((x) => x.severity !== 'info')) console.log(`    [${i.severity}] ${i.code} ${i.msg}`);
  console.log(`  semantic issues:`);
  for (const i of r.semantic.issues) console.log(`    [${i.severity}] ${i.code} ${i.msg}`);
  console.log(`  validateMap strict4 ok=${r.validation.ok} ${JSON.stringify(byCode(r.validation.issues))}`);
  console.log(`  validateMap 非 strict ok=${nonStrict.ok} ${JSON.stringify(byCode(nonStrict.issues))}`);
  for (const i of r.classified) console.log(`    [${i.class}] ${i.code} ${i.path}: ${i.msg}`);
  console.log(`  stocks ${r.def.stocks.length}  holidays ${r.def.holidays.length}（停用 ${hol.dropped.map((d) => d.slot).join(',') || '-'}，空 ${hol.empty}）`);
  for (const c of companyStockChecks(r.def)) console.log(`    ${c.ok ? 'OK ' : 'BAD'} 企业↔股票 ${c.company} ${c.detail}`);
  // 住宅地离世界坐标期望格的距离（placeLands 的 relaxAll 会把所有地块都记成「放宽」，这里找出真正 >2 的）
  const far: string[] = [];
  for (const l of r.semantic.lands) {
    const v = r.geometry.toLattice(l.world);
    const want = r.geometry.toGrid({ x: Math.round(v.x), y: Math.round(v.y) });
    const rect = r.def.lots.find((x) => x.id === l.id)!.rect;
    const dist = Math.abs(rect.x - want.x) + Math.abs(rect.y - want.y);
    const offSide = geo.landsOffSide.includes(l.id);
    if (dist > 2 || offSide) {
      const fc = r.def.tiles.find((t) => t.id === l.frontTiles[0])!.cell;
      far.push(
        `${l.id}(d=${dist}${offSide ? ',偏侧' : ''} front ${l.frontTiles[0]}@${fc.x},${fc.y} want ${want.x},${want.y} got ${rect.x},${rect.y} facing ${l.facing})`,
      );
    }
  }
  console.log(`  住宅地距期望格 >2：${far.join(',') || '无'}`);
  console.log(`  dataHash ${r.def.meta.dataHash}`);
  const base = path.join(outDir, key);
  writeFileSync(`${base}.map.json`, canonicalJson(r.def));
  writeFileSync(`${base}.semantic.json`, canonicalJson(r.semantic));
  writeFileSync(
    `${base}.build.json`,
    canonicalJson({
      mapKey: key,
      exitCode: r.exitCode,
      pending: r.semantic.pending,
      validation: { ok: r.validation.ok, issues: r.classified },
      nonStrict: nonStrict.issues,
      semanticIssues: r.semantic.issues,
      geometry: geo,
    }),
  );
  writeFileSync(
    path.join(outDir, 'preview', `${key}.svg`),
    renderPreviewSvg({ def: r.def, semantic: r.semantic, geometry: r.geometry, classified: r.classified }),
  );
}
