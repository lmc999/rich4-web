import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ExitCode, type ExitCodeValue, type ExtractContext, ExtractError } from '../context';
import { type FingerprintReport, type KnownFiles, loadKnownFiles } from '../fingerprint/identify';
import { sha256Hex } from '../io/hash';
import { isFile } from '../io/readOnly';
import { canonicalJson, safeWriteFile, writeCanonicalJson } from '../io/writeCanonicalJson';
import { type BuildResult, buildMapDef } from '../map/build';
import {
  emptyOverrides,
  loadOverrides,
  type MapOverrides,
  OVERRIDES_SCHEMA_FILE,
  overridesJsonSchema,
} from '../map/overrides';
import { buildManifest, type ManifestMapEntry, manifestEntry, resolveMapKey } from '../map/pack';
import { diffRaw } from '../map/rawDiff';
import type { MapDataRaw } from '../map/rawTypes';
import { loadRawSource, RAW_SOURCES, type RawSourceDef, selectSources, sourceDef } from '../map/sources';
import { renderPreviewSvg } from '../report/previewSvg';
import { renderProvenance } from '../report/provenance';
import { ICON } from '../report/table';
import { runTaiwanSamples, type SampleResult, samplesFailed } from '../verify/samples';

/** map build 与 pack 子命令（data-pipeline.md §3）。 */

export interface BuildArgs {
  map?: string | undefined;
  overrides?: string | undefined;
  strict4?: boolean | undefined;
  strict?: boolean | undefined;
  preview?: boolean | undefined;
  json?: boolean | undefined;
  verbose?: boolean | undefined;
  out?: string | undefined;
}

export const BUILD_COMMAND = 'npm run extract -- map build --map taiwan --strict4 --preview';

async function loadKnown(ctx: ExtractContext): Promise<KnownFiles | null> {
  try {
    return await loadKnownFiles(ctx.packageDir);
  } catch {
    return null;
  }
}

/** 先读 original/；没有原版文件时退回 .cache 中 map raw 的结果。 */
async function loadRaw(
  ctx: ExtractContext,
  def: RawSourceDef,
  gm: number,
  known: KnownFiles | null,
): Promise<{ raw: MapDataRaw; from: 'original' | 'cache' }> {
  try {
    return { raw: (await loadRawSource(ctx, def, gm, known)).raw, from: 'original' };
  } catch (e) {
    if (!(e instanceof ExtractError) || e.exitCode !== ExitCode.MISSING_INPUT) throw e;
    const p = ctx.cachePath('raw', def.id, `map${gm}.raw.json`);
    if (!(await isFile(p))) {
      throw new ExtractError(
        'E_MISSING_INPUT',
        `找不到来源 ${def.id}（original/ 下没有 ${def.relPath}，缓存里也没有 ${ctx.displayPath(p)}）`,
        ExitCode.MISSING_INPUT,
      );
    }
    const raw = JSON.parse(await readFile(p, 'utf8')) as MapDataRaw;
    if (raw.schema !== 'rich4.map-raw/1' || raw.source?.id !== def.id || raw.globalMapId !== gm) {
      throw new ExtractError('E_RAW_CACHE', `${ctx.displayPath(p)} 不是有效的 MapDataRaw`);
    }
    return { raw, from: 'cache' };
  }
}

async function readFingerprint(ctx: ExtractContext): Promise<FingerprintReport | null> {
  const p = ctx.cachePath('manifest.json');
  if (!(await isFile(p))) return null;
  try {
    const j = JSON.parse(await readFile(p, 'utf8')) as FingerprintReport;
    return j.schema === 'rich4.fingerprint/1' ? j : null;
  } catch {
    return null;
  }
}

function summarize(r: BuildResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of r.classified) out[`${i.class}:${i.code}`] = (out[`${i.class}:${i.code}`] ?? 0) + 1;
  return out;
}

export async function cmdMapBuild(ctx: ExtractContext, v: BuildArgs): Promise<number> {
  const { key, gm } = resolveMapKey(v.map);
  const defaultOv = path.join(ctx.packageDir, 'maps', `${key}.overrides.json`);
  const ovPath = v.overrides !== undefined ? ctx.resolveUserPath(v.overrides) : defaultOv;
  let ov: MapOverrides;
  if (v.overrides === undefined && !(await isFile(defaultOv))) {
    const first = (await selectSources(ctx, 'auto').catch(() => ({ selected: [RAW_SOURCES[0]!] }))).selected[0]!;
    ctx.log.out(`${ICON.warn} 没有 ${ctx.displayPath(defaultOv)}，使用空 overrides（来源 ${first.id}）`);
    ov = emptyOverrides(key, first.id);
  } else ov = await loadOverrides(ovPath, ctx.displayPath(ovPath));

  const known = await loadKnown(ctx);
  const main = await loadRaw(ctx, sourceDef(ov.source.id), gm, known);
  if (main.from === 'cache') ctx.log.out(`（original/ 不可用，使用缓存的 raw：${ov.source.id}）`);

  // 样本与多来源比较（台湾）
  const raws: MapDataRaw[] = [main.raw];
  for (const def of RAW_SOURCES) {
    if (def.id === ov.source.id) continue;
    try {
      raws.push((await loadRaw(ctx, def, gm, known)).raw);
    } catch (e) {
      if (!(e instanceof ExtractError) || e.exitCode !== ExitCode.MISSING_INPUT) throw e;
    }
  }
  const samples: { id: string; results: SampleResult[] }[] =
    key === 'taiwan' ? raws.map((r) => ({ id: r.source.id, results: runTaiwanSamples(r) })) : [];
  const diff = raws.length >= 2 ? diffRaw(raws) : null;

  const strict4 = v.strict4 === true;
  const build = buildMapDef(main.raw, ov, { mapKey: key, strict4 });
  const geo = build.geometry.report;

  const mapsDir = ctx.cachePath('maps');
  const mapText = canonicalJson(build.def);
  const mapSha = sha256Hex(new TextEncoder().encode(mapText));
  const geoFatal = geo.issues.some((i) => i.severity === 'error');
  const mapFile = path.join(mapsDir, `${key}.map.json`);
  if (!geoFatal) await safeWriteFile(ctx, mapFile, mapText);
  await writeCanonicalJson(ctx, path.join(mapsDir, `${key}.semantic.json`), build.semantic);
  await writeCanonicalJson(ctx, path.join(mapsDir, `${key}.build.json`), {
    schema: 'rich4.map-build/1',
    mapKey: key,
    dataHash: build.def.meta.dataHash,
    mapSha256: geoFatal ? null : mapSha,
    exitCode: build.exitCode,
    strict4,
    pending: build.semantic.pending,
    validation: { ok: build.validation.ok, issues: build.classified },
    semanticIssues: build.semantic.issues,
    geometry: geo,
    samples,
  });
  let previewPath: string | null = null;
  if (v.preview) {
    previewPath = await safeWriteFile(
      ctx,
      ctx.cachePath('preview', `${key}.svg`),
      renderPreviewSvg({
        def: build.def,
        semantic: build.semantic,
        geometry: build.geometry,
        classified: build.classified,
      }),
    );
  }
  const baseSamplesFailed = samples.length > 0 && samplesFailed(samples[0]!.results);
  let provPath: string | null = null;
  if (key === 'taiwan' && !geoFatal) {
    provPath = await safeWriteFile(
      ctx,
      path.join(ctx.root, 'docs', 'research', 'provenance-summary.md'),
      renderProvenance({
        mapKey: key,
        command: BUILD_COMMAND,
        overridesPath: ctx.displayPath(ovPath),
        fingerprint: await readFingerprint(ctx),
        samples,
        diff: diff
          ? { rule: diff.counts.rule, presentation: diff.counts.presentation, identicalGroups: diff.identicalGroups }
          : null,
        build,
        mapFileSha256: mapSha,
        strict4,
      }),
    );
  }

  let exit: ExitCodeValue = build.exitCode;
  if (exit === ExitCode.OK && baseSamplesFailed) exit = ExitCode.STRUCTURE;
  if (exit === ExitCode.OK && v.strict && !build.validation.ok) exit = ExitCode.STRUCTURE;

  const byClass = summarize(build);
  if (v.json) {
    ctx.log.out(
      JSON.stringify(
        {
          exit,
          dataHash: build.def.meta.dataHash,
          mapSha256: mapSha,
          grid: build.def.grid,
          issues: byClass,
          geometry: geo,
        },
        null,
        2,
      ),
    );
    return exit;
  }
  const lat = geo.lattice;
  ctx.log.out(
    `来源 ${main.raw.source.id}（${main.from === 'original' ? 'original/' : '缓存'}） overrides ${ctx.displayPath(ovPath)}（${geo.overrides} 条）`,
  );
  if (samples.length > 0) {
    ctx.log.out(
      `样本：${samples.map((s) => `${s.id} ${samplesFailed(s.results) ? ICON.fail : ICON.pass}`).join('  ')}` +
        (diff ? `；多来源规则差异 ${diff.counts.rule}、表现差异 ${diff.counts.presentation}` : ''),
    );
  }
  ctx.log.out(
    `格点：${lat.mode} T=${lat.tile} 原点 (${lat.origin.join(',')}) transform ${lat.transform}；` +
      `T=32 覆盖率 ${(lat.probe32.coverage * 100).toFixed(1)}%`,
  );
  ctx.log.out(
    `边 ${geo.routes.edges}：直连 ${geo.edgeKinds.unit}、长直 ${geo.edgeKinds.straight}、L 形 ${geo.edgeKinds.L}、` +
      `绕行 ${geo.edgeKinds.detour}、override ${geo.edgeKinds.override}；量化后对角边 ${geo.routes.diagonal}；` +
      `via 连接格 ${geo.routes.viaCells}（${geo.routes.viaEdges} 条边）`,
  );
  ctx.log.out(
    `网格 ${build.def.grid.w}×${build.def.grid.h}；拐角翻转 ${geo.cornerFlips.length}；` +
      `住宅地偏侧 ${geo.landsOffSide.length}（${geo.landsOffSide.join(',') || '无'}）；地形 ${JSON.stringify(geo.terrain)}`,
  );
  for (const i of geo.issues) {
    if (i.severity === 'info' && !v.verbose) continue;
    ctx.log.out(`  ${i.severity === 'error' ? ICON.fail : i.severity === 'warn' ? ICON.warn : 'ℹ️'} ${i.code} ${i.msg}`);
  }
  for (const i of build.semantic.issues) {
    ctx.log.out(`  ${i.severity === 'error' ? ICON.fail : ICON.warn} ${i.code} ${i.msg}`);
  }
  ctx.log.out(`validateMap（strict4=${strict4}）：ok=${build.validation.ok}  ${JSON.stringify(byClass)}`);
  for (const i of build.classified) {
    if (i.class === 'warn' && !v.verbose) continue;
    const icon = i.class === 'error' ? ICON.fail : ICON.warn;
    ctx.log.out(`  ${icon} [${i.class}] ${i.code} ${i.path}: ${i.msg}`);
  }
  ctx.log.out(`dataHash ${build.def.meta.dataHash}`);
  if (!geoFatal) ctx.log.out(`→ ${ctx.displayPath(mapFile)}  sha256 ${mapSha}`);
  else
    ctx.log.out(
      `${ICON.fail} 几何有 error，未写出 MapDef（见 ${ctx.displayPath(path.join(mapsDir, `${key}.build.json`))}）`,
    );
  if (previewPath) ctx.log.out(`→ ${ctx.displayPath(previewPath)}`);
  if (provPath) ctx.log.out(`→ ${ctx.displayPath(provPath)}`);
  ctx.log.out(`结果：exit ${exit}`);
  return exit;
}

export async function cmdPack(ctx: ExtractContext, v: BuildArgs): Promise<number> {
  const outDir = path.resolve(ctx.cwd, v.out ?? 'rich4-data');
  const mapsDir = ctx.cachePath('maps');
  let keys: string[];
  if (v.map !== undefined) keys = [resolveMapKey(v.map).key];
  else {
    let names: string[] = [];
    try {
      names = await readdir(mapsDir);
    } catch {
      names = [];
    }
    keys = names
      .filter((n) => n.endsWith('.map.json'))
      .map((n) => n.slice(0, -'.map.json'.length))
      .sort();
  }
  if (keys.length === 0) {
    throw new ExtractError(
      'E_MISSING_INPUT',
      `${ctx.displayPath(mapsDir)} 下没有已构建的地图，请先运行 map build`,
      ExitCode.MISSING_INPUT,
    );
  }
  const entries: ManifestMapEntry[] = [];
  for (const key of keys) {
    const file = path.join(mapsDir, `${key}.map.json`);
    if (!(await isFile(file))) {
      throw new ExtractError(
        'E_MISSING_INPUT',
        `缺少 ${ctx.displayPath(file)}，请先运行 map build`,
        ExitCode.MISSING_INPUT,
      );
    }
    const text = await readFile(file, 'utf8');
    let pending: string[] = [];
    const buildInfo = path.join(mapsDir, `${key}.build.json`);
    if (await isFile(buildInfo)) {
      const b = JSON.parse(await readFile(buildInfo, 'utf8')) as { pending?: unknown };
      if (Array.isArray(b.pending)) pending = b.pending.filter((x): x is string => typeof x === 'string');
    }
    const { entry } = manifestEntry(text, pending);
    if (entry.id !== key)
      throw new ExtractError('E_PACK_ID', `${ctx.displayPath(file)} 的 id 是 ${entry.id}，与文件名不符`);
    await safeWriteFile(ctx, path.join(outDir, entry.file), text);
    entries.push(entry);
    ctx.log.out(
      `${ICON.pass} ${entry.id}  mapHash ${entry.mapHash}  sha256 ${entry.sha256}  ${entry.bytes} 字节` +
        (entry.pending.length > 0 ? `  待补：${entry.pending.join(',')}` : '') +
        `  validateMap ${JSON.stringify(entry.validation.issues)}`,
    );
  }
  const manifestPath = await writeCanonicalJson(ctx, path.join(outDir, 'manifest.json'), buildManifest(entries));
  ctx.log.out(`→ ${ctx.displayPath(manifestPath)}`);
  return ExitCode.OK;
}

export async function cmdOverridesSchema(ctx: ExtractContext): Promise<number> {
  const p = await writeCanonicalJson(
    ctx,
    path.join(ctx.packageDir, 'maps', OVERRIDES_SCHEMA_FILE),
    overridesJsonSchema(),
  );
  ctx.log.out(`→ ${ctx.displayPath(p)}`);
  return ExitCode.OK;
}
