import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ExitCode, type ExitCodeValue, type ExtractContext, ExtractError } from '../context';
import { companyStockChecks, holidaysForMap, type MapHolidays, type MapStockInput, stocksForMap } from '../exe/mapData';
import type { ExeEdition } from '../exe/types';
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
import {
  allMapKeys,
  buildManifest,
  type ManifestMapEntry,
  type MapKeyRef,
  manifestEntry,
  mergeManifestEntries,
  parseExistingManifest,
  resolveMapKeys,
} from '../map/pack';
import { diffRaw } from '../map/rawDiff';
import type { MapDataRaw } from '../map/rawTypes';
import { loadRawSource, RAW_SOURCES, type RawSourceDef, selectSources, sourceDef } from '../map/sources';
import { renderPreviewSvg } from '../report/previewSvg';
import { type ExeDataInfo, renderProvenance } from '../report/provenance';
import { ICON } from '../report/table';
import { compareRules, loadManualTables, type RulesReport } from '../verify/rulesAgainstExe';
import { MAP_SAMPLES, runMapSamples, type SampleResult, samplesFailed } from '../verify/samples';
import { loadBothTables } from './exe';

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
  /** pack：manifest 整份按本次打包的图重写（允许去掉已有的图） */
  replace?: boolean | undefined;
}

/** 写进 provenance 的生成命令（台湾的字符串与泛化前相同，provenance-summary.md 逐字节不变）。 */
export function buildCommand(key: string): string {
  return `npm run extract -- map build --map ${key} --strict4 --preview`;
}

/** provenance 文档路径：台湾沿用 provenance-summary.md，其他图各写 provenance-<key>.md（相对仓库根）。 */
export function provenanceRelPath(key: string): string {
  return key === 'taiwan' ? 'docs/research/provenance-summary.md' : `docs/research/provenance-${key}.md`;
}

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

interface ExeMapData {
  info: ExeDataInfo;
  stocks: MapStockInput[];
  holidays: MapHolidays;
  rules: RulesReport | null;
}

/**
 * 按地图的股票与节日（architecture §16.5）：取与基线来源同版本的 exe（v206-* → Game/RICH4.EXE），
 * 另一版本可用时核对两版该图的数据是否一致；exe 与缓存都没有时返回 null（stocks/holidays 保持待补）。
 */
async function loadExeMapData(ctx: ExtractContext, edition: string, gm: number): Promise<ExeMapData | null> {
  const ed: ExeEdition = edition === 'v311' ? 'v311' : 'v206';
  const all = await loadBothTables(ctx);
  const t = all[ed];
  if (!t) return null;
  const stocks = stocksForMap(t, gm);
  const holidays = holidaysForMap(t, gm);
  const other = all[ed === 'v206' ? 'v311' : 'v206'];
  let crossEdition: ExeDataInfo['crossEdition'] = 'n/a';
  if (other && gm < other.stocks.maps && gm < other.holidays.maps) {
    const same =
      canonicalJson(stocksForMap(other, gm)) === canonicalJson(stocks) &&
      canonicalJson(holidaysForMap(other, gm)) === canonicalJson(holidays);
    crossEdition = same ? 'same' : 'diff';
  }
  let rules: RulesReport | null = null;
  try {
    rules = compareRules(await loadManualTables(ctx.root), all);
  } catch {
    rules = null;
  }
  return {
    info: {
      edition: ed,
      exeFile: t.exe.file,
      exeSha256: t.exe.sha256,
      stocksVa: t.locate.stocks.va,
      holidaysVa: t.locate.holidays.va,
      stocks: stocks.length,
      holidays: holidays.holidays.length,
      dropped: holidays.dropped.map((d) => d.slot),
      empty: holidays.empty,
      crossEdition,
    },
    stocks,
    holidays,
    rules,
  };
}

function summarize(r: BuildResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of r.classified) out[`${i.class}:${i.code}`] = (out[`${i.class}:${i.code}`] ?? 0) + 1;
  return out;
}

export async function cmdMapBuild(ctx: ExtractContext, v: BuildArgs): Promise<number> {
  const maps = resolveMapKeys(v.map);
  if (maps.length > 1 && v.overrides !== undefined) {
    throw new ExtractError(
      'E_ARGS',
      '--map all 时不能指定 --overrides（每张图读 tools/extract/maps/<key>.overrides.json）',
    );
  }
  if (maps.length === 1) return buildOne(ctx, v, maps[0]!);
  // 多张图：一张出错（例如 overrides 与输入不符）不影响其余各图，退出码取最大值
  let exit: number = ExitCode.OK;
  const summary: string[] = [];
  for (const m of maps) {
    ctx.log.out(`── map build ${m.key}（gm ${m.gm}）`);
    let code: number;
    try {
      code = await buildOne(ctx, v, m);
    } catch (e) {
      if (!(e instanceof ExtractError)) throw e;
      ctx.log.err(`${ICON.fail} ${m.key}：${e.message}`);
      code = e.exitCode;
    }
    summary.push(`${m.key} ${code === ExitCode.OK ? ICON.pass : ICON.fail} exit ${code}`);
    exit = Math.max(exit, code);
  }
  ctx.log.out(`全部地图：${summary.join('  ')}；exit ${exit}`);
  return exit;
}

/**
 * 构建一张图。中途抛出的错误（overrides 不符、缺少来源等）也写进 <key>.build.json（只有 exit 与错误信息），
 * 这样「最近一次 build」确实失败时，pack 不会把上一次留下的 map.json 当成可用的图打包。
 */
async function buildOne(ctx: ExtractContext, v: BuildArgs, ref: MapKeyRef): Promise<number> {
  try {
    return await buildOneInner(ctx, v, ref);
  } catch (e) {
    if (e instanceof ExtractError) {
      try {
        await writeCanonicalJson(ctx, ctx.cachePath('maps', `${ref.key}.build.json`), {
          schema: 'rich4.map-build/1',
          mapKey: ref.key,
          exit: e.exitCode,
          error: e.message,
        });
      } catch {
        // 报告写不出来时只保留原错误
      }
    }
    throw e;
  }
}

async function buildOneInner(ctx: ExtractContext, v: BuildArgs, { key, gm }: MapKeyRef): Promise<number> {
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

  // 样本（MAP_SAMPLES 按图的规格）与多来源比较
  const raws: MapDataRaw[] = [main.raw];
  for (const def of RAW_SOURCES) {
    if (def.id === ov.source.id) continue;
    try {
      raws.push((await loadRaw(ctx, def, gm, known)).raw);
    } catch (e) {
      if (!(e instanceof ExtractError) || e.exitCode !== ExitCode.MISSING_INPUT) throw e;
    }
  }
  const spec = MAP_SAMPLES[key];
  const samples: { id: string; results: SampleResult[] }[] = spec
    ? raws.map((r) => ({ id: r.source.id, results: runMapSamples(r, spec) }))
    : [];
  const diff = raws.length >= 2 ? diffRaw(raws) : null;

  const strict4 = v.strict4 === true;
  const exeData = await loadExeMapData(ctx, main.raw.source.edition, gm);
  if (!exeData)
    ctx.log.out(
      `${ICON.warn} 没有 exe 表（original/ 下无 RICH4.EXE，缓存也没有 tables.*.json）：stocks/holidays 保持待补`,
    );
  const build = buildMapDef(main.raw, ov, {
    mapKey: key,
    strict4,
    ...(exeData ? { stocks: exeData.stocks, holidays: exeData.holidays.holidays } : {}),
  });
  const geo = build.geometry.report;

  const mapsDir = ctx.cachePath('maps');
  const mapText = canonicalJson(build.def);
  const mapSha = sha256Hex(new TextEncoder().encode(mapText));
  const geoFatal = geo.issues.some((i) => i.severity === 'error');
  const companyStocks = exeData ? companyStockChecks(build.def) : [];
  const baseSamplesFailed = samples.length > 0 && samplesFailed(samples[0]!.results);
  const companyBad = companyStocks.some((c) => c.status === 'BAD');

  let exit: ExitCodeValue = build.exitCode;
  if (exit === ExitCode.OK && baseSamplesFailed) exit = ExitCode.STRUCTURE;
  if (exit === ExitCode.OK && companyBad) exit = ExitCode.STRUCTURE;
  if (exit === ExitCode.OK && v.strict && !build.validation.ok) exit = ExitCode.STRUCTURE;

  const mapFile = path.join(mapsDir, `${key}.map.json`);
  if (!geoFatal) await safeWriteFile(ctx, mapFile, mapText);
  await writeCanonicalJson(ctx, path.join(mapsDir, `${key}.semantic.json`), build.semantic);
  await writeCanonicalJson(ctx, path.join(mapsDir, `${key}.build.json`), {
    schema: 'rich4.map-build/1',
    mapKey: key,
    dataHash: build.def.meta.dataHash,
    mapSha256: geoFatal ? null : mapSha,
    exitCode: build.exitCode,
    /** 本次 map build 的最终退出码（含样本、企业↔股票与 --strict）；pack 只打包为 0 的图 */
    exit,
    strict4,
    pending: build.semantic.pending,
    validation: { ok: build.validation.ok, issues: build.classified },
    semanticIssues: build.semantic.issues,
    geometry: geo,
    samples,
    companyStocks,
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
  let provPath: string | null = null;
  if (!geoFatal) {
    provPath = await safeWriteFile(
      ctx,
      path.join(ctx.root, ...provenanceRelPath(key).split('/')),
      renderProvenance({
        mapKey: key,
        command: buildCommand(key),
        overridesPath: ctx.displayPath(ovPath),
        fingerprint: await readFingerprint(ctx),
        samples,
        diff: diff
          ? { rule: diff.counts.rule, presentation: diff.counts.presentation, identicalGroups: diff.identicalGroups }
          : null,
        build,
        mapFileSha256: mapSha,
        strict4,
        exeData: exeData?.info ?? null,
        rules: exeData?.rules ?? null,
        companyStocks,
      }),
    );
  }

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
  if (exeData) {
    const x = exeData.info;
    ctx.log.out(
      `exe 表（${x.edition} ${x.exeFile}）：股票 ${x.stocks} 支、节日 ${x.holidays} 条` +
        (x.dropped.length > 0 ? `（停用槽 ${x.dropped.join(',')} 不输出）` : '') +
        `；两版该图数据${x.crossEdition === 'same' ? '一致' : x.crossEdition === 'diff' ? '不一致' : '未比较'}`,
    );
    for (const c of companyStocks)
      ctx.log.out(
        `  ${c.status === 'OK' ? ICON.pass : c.status === 'KNOWN' ? ICON.warn : ICON.fail} 企业↔股票 ${c.detail}`,
      );
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

interface BuildReportInfo {
  /** 最近一次 map build 的最终退出码；没有报告时为 null */
  exit: number | null;
  pending: string[];
}

async function readBuildReport(file: string): Promise<BuildReportInfo> {
  if (!(await isFile(file))) return { exit: null, pending: [] };
  const b = JSON.parse(await readFile(file, 'utf8')) as { pending?: unknown; exit?: unknown; exitCode?: unknown };
  const pending = Array.isArray(b.pending) ? b.pending.filter((x): x is string => typeof x === 'string') : [];
  // 旧报告没有 exit 字段时退回 exitCode（几何/validateMap 的退出码）
  const exit = typeof b.exit === 'number' ? b.exit : typeof b.exitCode === 'number' ? b.exitCode : null;
  return { exit, pending };
}

/**
 * pack：把已构建的地图打进部署数据包。
 * - 与 <out>/manifest.json 已有的条目合并：只替换 / 新增本次打包的图，其余图的条目与地图文件原样保留
 *   （保留的图要核对 <out> 里的地图文件仍在、sha256 与条目相符）；--replace 才整份按本次的图重写；
 * - 不带 --map：只打 MAP_KEYS 里、并且最近一次 map build 报告为 exit 0 的图，其余打警告后跳过（免得半成品图进 rich4-data）；
 *   但要跳过的图已在 <out>/manifest.json 里时报错（E_PACK_DROP，exit 1）——否则照旧写会把已部署的图从 manifest 去掉，
 *   已部署的房间与存档会 MAP_UNAVAILABLE；确实要去掉加 --replace；
 * - 带 --map <key|gm|all>：指定的图必须都已构建且报告为 exit 0，否则报错。
 * 所有核对都在写任何文件之前做完：失败时 <out> 不变。
 */
export async function cmdPack(ctx: ExtractContext, v: BuildArgs): Promise<number> {
  const outDir = path.resolve(ctx.cwd, v.out ?? 'rich4-data');
  const mapsDir = ctx.cachePath('maps');
  const manifestFile = path.join(outDir, 'manifest.json');
  const explicit = v.map !== undefined;
  const replace = v.replace === true;
  const wanted = explicit ? resolveMapKeys(v.map) : allMapKeys();
  const existing = await readExistingManifest(ctx, manifestFile, replace);
  const ready: { key: string; text: string; pending: string[] }[] = [];
  /** quiet：根本没构建过的图（与之前一样不打警告，除非它已在 manifest 里、要报 E_PACK_DROP） */
  const skipped: { key: string; why: string; quiet?: boolean }[] = [];
  for (const { key } of wanted) {
    const file = path.join(mapsDir, `${key}.map.json`);
    const reportFile = path.join(mapsDir, `${key}.build.json`);
    if (!(await isFile(file))) {
      if (explicit) {
        throw new ExtractError(
          'E_MISSING_INPUT',
          `缺少 ${ctx.displayPath(file)}，请先运行 map build --map ${key}`,
          ExitCode.MISSING_INPUT,
        );
      }
      skipped.push({ key, why: `没有构建产物 ${ctx.displayPath(file)}`, quiet: true });
      continue;
    }
    const report = await readBuildReport(reportFile);
    if (report.exit !== ExitCode.OK) {
      const why =
        report.exit === null
          ? `没有构建报告 ${ctx.displayPath(reportFile)}`
          : `最近一次 map build 为 exit ${report.exit}`;
      if (explicit) {
        throw new ExtractError('E_PACK_BUILD', `${key}：${why}，请先修好并重新运行 map build --map ${key}`);
      }
      skipped.push({ key, why });
      continue;
    }
    ready.push({ key, text: await readFile(file, 'utf8'), pending: report.pending });
  }
  // 不带 --map 时要跳过、但已部署（在现有 manifest 里）的图：不能悄悄去掉
  const dropping = skipped.filter((sk) => existing?.some((e) => e.id === sk.key));
  if (dropping.length > 0 && !replace) {
    throw new ExtractError(
      'E_PACK_DROP',
      `${ctx.displayPath(manifestFile)} 里已有 ${dropping.map((d) => `${d.key}（${d.why}）`).join('、')}，` +
        '这次打包要跳过它，照写会把它从数据包里去掉（已部署的房间与存档会 MAP_UNAVAILABLE）。' +
        '请先修好并重新运行 map build；只更新其他图用 --map <key>（与已有 manifest 合并）；确实要去掉再加 --replace',
    );
  }
  for (const sk of skipped) {
    if (!sk.quiet || dropping.includes(sk)) ctx.log.out(`${ICON.warn} 跳过 ${sk.key}：${sk.why}`);
  }
  if (ready.length === 0) {
    throw new ExtractError(
      'E_MISSING_INPUT',
      `${ctx.displayPath(mapsDir)} 下没有可打包的地图（需要 exit 0 的 map build），请先运行 map build`,
      ExitCode.MISSING_INPUT,
    );
  }
  // 先逐图核对（validateMap、dataHash、id 与文件名），再写
  const fresh: { entry: ManifestMapEntry; text: string }[] = [];
  for (const { key, text, pending } of ready) {
    const file = path.join(mapsDir, `${key}.map.json`);
    const { entry } = manifestEntry(text, pending);
    if (entry.id !== key)
      throw new ExtractError('E_PACK_ID', `${ctx.displayPath(file)} 的 id 是 ${entry.id}，与文件名不符`);
    fresh.push({ entry, text });
  }
  const freshEntries = fresh.map((f) => f.entry);
  let entries: ManifestMapEntry[] = freshEntries;
  if (existing && !replace) {
    const merged = mergeManifestEntries(existing, freshEntries);
    for (const e of merged.kept) await assertPackedFile(ctx, outDir, e);
    entries = merged.entries;
    for (const e of merged.kept)
      ctx.log.out(`${ICON.pass} ${e.id}  保留 ${ctx.displayPath(manifestFile)} 已有的条目（本次未重新打包）`);
  } else if (existing && replace) {
    const ids = new Set(freshEntries.map((e) => e.id));
    const dropped = existing.filter((e) => !ids.has(e.id)).map((e) => e.id);
    if (dropped.length > 0)
      ctx.log.out(`${ICON.warn} --replace：manifest 去掉 ${dropped.join('、')}（地图文件留在原处，不删除）`);
  }
  for (const { entry, text } of fresh) {
    await safeWriteFile(ctx, path.join(outDir, entry.file), text);
    ctx.log.out(
      `${ICON.pass} ${entry.id}  mapHash ${entry.mapHash}  sha256 ${entry.sha256}  ${entry.bytes} 字节` +
        (entry.pending.length > 0 ? `  待补：${entry.pending.join(',')}` : '') +
        `  validateMap ${JSON.stringify(entry.validation.issues)}`,
    );
  }
  const manifest = buildManifest(entries);
  const manifestPath = await writeCanonicalJson(ctx, manifestFile, manifest);
  ctx.log.out(`→ ${ctx.displayPath(manifestPath)}（${manifest.maps.map((e) => e.id).join('、')}）`);
  return ExitCode.OK;
}

/** <out>/manifest.json 已有的条目；没有这个文件时为 null。--replace 时读不懂也不报错（反正整份重写）。 */
async function readExistingManifest(
  ctx: ExtractContext,
  file: string,
  replace: boolean,
): Promise<ManifestMapEntry[] | null> {
  if (!(await isFile(file))) return null;
  try {
    return parseExistingManifest(JSON.parse(await readFile(file, 'utf8')), ctx.displayPath(file));
  } catch (e) {
    if (replace) {
      ctx.log.out(`${ICON.warn} 读不懂 ${ctx.displayPath(file)}，--replace 整份重写`);
      return null;
    }
    if (e instanceof ExtractError) throw e;
    throw new ExtractError(
      'E_PACK_MERGE',
      `${ctx.displayPath(file)} 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）；确认无误后可加 --replace 整份重写`,
    );
  }
}

/** 合并时保留的条目：<out> 里的地图文件必须还在、sha256 与条目相符，否则 manifest 会指向不存在或不一致的文件。 */
async function assertPackedFile(ctx: ExtractContext, outDir: string, e: ManifestMapEntry): Promise<void> {
  const file = path.resolve(outDir, e.file);
  const rel = path.relative(outDir, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ExtractError('E_PACK_MERGE', `已有条目 ${e.id} 的 file ${e.file} 不在 ${ctx.displayPath(outDir)} 之内`);
  }
  if (!(await isFile(file))) {
    throw new ExtractError(
      'E_PACK_MERGE',
      `已有条目 ${e.id} 的地图文件 ${ctx.displayPath(file)} 不见了；请重新 map build --map ${e.id} 后打包，或加 --replace`,
    );
  }
  const got = sha256Hex(new Uint8Array(await readFile(file)));
  if (got !== e.sha256) {
    throw new ExtractError(
      'E_PACK_MERGE',
      `已有条目 ${e.id} 的地图文件 ${ctx.displayPath(file)} sha256 ${got} 与 manifest 的 ${e.sha256} 不符；` +
        `请重新 map build --map ${e.id} 后打包，或加 --replace`,
    );
  }
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
