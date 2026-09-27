#!/usr/bin/env tsx
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cmdAssetsBuild, cmdAssetsLs, cmdAssetsPreview, cmdAssetsSynth, cmdAssetsVerify } from './commands/assets';
import { cmdExeConstants, cmdVerifyConstants } from './commands/constants';
import { cmdExeDiff, cmdExeTables, cmdVerifyTables } from './commands/exe';
import { cmdMapBuild, cmdOverridesSchema, cmdPack } from './commands/mapBuild';
import { type ContextOptions, ExitCode, ExtractContext, ExtractError, type Logger } from './context';
import {
  buildFingerprintReport,
  buildLock,
  type IdentifiedFile,
  inspectExe,
  type KnownFiles,
  loadKnownFiles,
} from './fingerprint/identify';
import { scanOriginal } from './fingerprint/scan';
import { sha256Hex } from './io/hash';
import { isDirectory, isFile, readFileRO } from './io/readOnly';
import { safeWriteFile, writeCanonicalJson } from './io/writeCanonicalJson';
import { failedChecks } from './map/parseRaw';
import { diffExitCode, diffRaw } from './map/rawDiff';
import { computeRawStats, type RawStats } from './map/rawStats';
import type { MapDataRaw } from './map/rawTypes';
import { loadRawSource, RAW_SOURCES, selectSources } from './map/sources';
import { MkfArchive } from './mkf/container';
import { ICON, renderTable } from './report/table';
import { runTaiwanSamples, type SampleResult, samplesFailed } from './verify/samples';

const USAGE = `用法: rich4-extract <命令> [选项]
  fingerprint [--allow-unknown] [--json]            扫描 original/，比对 known-files.json
  mkf ls --file <path> [--json]                      列出 MKF 容器资源
  map raw --map <gm> [--sources auto|all|<id,…>] [--dump-bin]
                                                     解析地图结构 → .cache/extract/raw/<source>/map<gm>.raw.json
  map diff --map <gm>                                多来源逐字段比较 → .cache/extract/diff/map<gm>.json
  exe tables [--edition v206|v311|all] [--verbose]   定位并解析 exe 固定表、常量、新闻/命运/魔法屋 → .cache/extract/tables.<edition>.json
  exe constants [--write-anchors] [--verbose]        两版解析 anchors/constants.json → .cache/extract/constants.json
                                                     （--write-anchors 把迁移得到的 v2.06 VA 写回 anchors）
  exe diff [--r2] [--r2-timeout 120]                 两版表/地图/字符串/函数对比 → docs/research/version-diff.md、events-from-exe.md
                                                     （--r2 另用 radare2 线性反汇编核对指令边界，可选）
  verify [--samples] [--tables] [--constants] [--map 0] [--sources auto|all|<id,…>]
                                                     台湾样本；--tables 手录规则表与 exe 对照；--constants 常量锚点两版核对
                                                     （都不加 = 三者都跑）
  map build --map taiwan [--overrides <file>] [--strict4] [--preview] [--strict]
                                                     语义层 + 几何归一化 → .cache/extract/maps/taiwan.map.json，
                                                     并写 docs/research/provenance-summary.md（--preview 另写 .cache/extract/preview/taiwan.svg）
  pack [--out rich4-data/] [--map taiwan]            部署数据包 → <out>/manifest.json、<out>/maps/*.map.json
  overrides schema                                   由 zod 导出 tools/extract/maps/overrides.schema.json
  assets build [--out rich4-assets/] [--only board,ui,fx,minigame,audio,music,video] [--video]
               [--audio opus,m4a] [--media <Steam Media 目录>] [--map-data <taiwan.map.json>] [--jobs 4] [--allow-unknown]
                                                     原版皮肤素材包（仅供私人游玩；只写入已被 git 忽略的 rich4-assets/ 或 .cache/）
  assets verify [--out rich4-assets/] [--full]       逐文件复算 sha256、契约与交叉引用（--full 另解码 PNG/FLC）
  assets ls [--out rich4-assets/] [--group <分组>]   列出资源目录项及其构建结果
  assets preview [--pack rich4-assets/] [--out .cache/assets-preview/] [--group <分组>]
                                                     本机浏览用联系表、棋盘渲染与 index.html
  assets synth [--out .cache/synthetic-pack/]        fixture 地图的合成素材包（CI 用，不入库）
                                                     （build / preview / synth 输出到仓库外须加 --allow-outside-repo）
通用: --src <dir>（默认 original/） --cache <dir>（默认 .cache/extract） --lock <file> --json --verbose
退出码: 0 成功；1 结构/校验失败；2 缺少输入；3 指纹未知；4 规则字段差异需选基线；5 override 错误`;

const OPTIONS = {
  src: { type: 'string' },
  cache: { type: 'string' },
  root: { type: 'string' },
  lock: { type: 'string' },
  file: { type: 'string' },
  map: { type: 'string' },
  sources: { type: 'string' },
  json: { type: 'boolean' },
  'allow-unknown': { type: 'boolean' },
  'allow-outside-repo': { type: 'boolean' },
  'dump-bin': { type: 'boolean' },
  'write-anchors': { type: 'boolean' },
  r2: { type: 'boolean' },
  'r2-timeout': { type: 'string' },
  samples: { type: 'boolean' },
  tables: { type: 'boolean' },
  constants: { type: 'boolean' },
  edition: { type: 'string' },
  overrides: { type: 'string' },
  out: { type: 'string' },
  strict4: { type: 'boolean' },
  strict: { type: 'boolean' },
  preview: { type: 'boolean' },
  verbose: { type: 'boolean' },
  only: { type: 'string' },
  video: { type: 'boolean' },
  audio: { type: 'string' },
  media: { type: 'string' },
  'map-data': { type: 'string' },
  jobs: { type: 'string' },
  full: { type: 'boolean' },
  group: { type: 'string' },
  pack: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

function parseMapId(v: string | undefined): number {
  if (v === undefined) throw new ExtractError('E_ARGS', '缺少 --map <gm>', ExitCode.MISSING_INPUT);
  if (!/^\d+$/.test(v)) throw new ExtractError('E_ARGS', `--map 必须是非负整数：${v}`);
  return Number(v);
}

async function tryLoadKnown(ctx: ExtractContext): Promise<KnownFiles | null> {
  try {
    return await loadKnownFiles(ctx.packageDir);
  } catch (e) {
    ctx.log.err(`⚠️ 读取 known-files.json 失败：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

// ───────────────────────── fingerprint ─────────────────────────

async function cmdFingerprint(ctx: ExtractContext, v: Values): Promise<number> {
  if (!(await isDirectory(ctx.srcDir))) {
    throw new ExtractError('E_MISSING_INPUT', `原版目录不存在：${ctx.displayPath(ctx.srcDir)}`, ExitCode.MISSING_INPUT);
  }
  const known = await loadKnownFiles(ctx.packageDir);
  const scanned = await scanOriginal(ctx.srcDir);
  const pe: Record<string, IdentifiedFile['pe']> = {};
  for (const f of scanned) {
    if (f.path.toLowerCase().endsWith('.exe'))
      pe[f.path] = inspectExe(await readFileRO(path.join(ctx.srcDir, f.path)), f.path);
  }
  const report = buildFingerprintReport(scanned, known, { allowUnknown: v['allow-unknown'] === true, pe });
  await writeCanonicalJson(ctx, ctx.cachePath('manifest.json'), report);
  if (report.exitCode === ExitCode.OK) {
    await writeCanonicalJson(ctx, ctx.lockFile, buildLock(report));
  }
  if (v.json) {
    ctx.log.out(JSON.stringify(report, null, 2));
    return report.exitCode;
  }
  const icons: Record<IdentifiedFile['status'], string> = {
    known: ICON.pass,
    reference: ICON.warn,
    misplaced: ICON.fail,
    unknown: report.allowUnknown ? ICON.warn : ICON.fail,
  };
  const rows = report.files.map((f) => [
    icons[f.status],
    f.path,
    String(f.size),
    f.sha256,
    f.knownId ?? '(未登记)',
    f.edition ?? '-',
    f.pe && 'sections' in f.pe ? f.pe.sections.join(' ') : '',
  ]);
  ctx.log.out(`原版目录：${ctx.displayPath(ctx.srcDir)}`);
  for (const l of renderTable(['', '文件', '字节', 'sha256', '登记 id', '版本', 'PE 节'], rows, '  r')) ctx.log.out(l);
  for (const m of report.missing) ctx.log.out(`${ICON.fail} 缺少必需文件：${m}`);
  for (const m of report.optionalMissing) ctx.log.out(`   （可选，未提供：${m}）`);
  for (const w of report.warnings) ctx.log.out(`${ICON.warn} ${w}`);
  ctx.log.out(`清单：${ctx.displayPath(ctx.cachePath('manifest.json'))}`);
  if (report.exitCode === ExitCode.OK) ctx.log.out(`基线：${ctx.displayPath(ctx.lockFile)}`);
  ctx.log.out(`结果：exit ${report.exitCode}`);
  return report.exitCode;
}

// ───────────────────────── mkf ls ─────────────────────────

async function cmdMkfLs(ctx: ExtractContext, v: Values): Promise<number> {
  if (!v.file) throw new ExtractError('E_ARGS', '缺少 --file <path>', ExitCode.MISSING_INPUT);
  const file = ctx.resolveUserPath(v.file);
  if (!(await isFile(file))) throw new ExtractError('E_MISSING_INPUT', `找不到文件：${v.file}`, ExitCode.MISSING_INPUT);
  const bytes = await readFileRO(file);
  const name = ctx.displayPath(file);
  const mkf = MkfArchive.open(bytes, name);
  const entries = mkf.entries();
  const summary = {
    file: name,
    size: mkf.byteLength,
    sha256: sha256Hex(bytes),
    indexTableOffset: mkf.indexTableOffset,
    count: mkf.count,
    hasSentinel: mkf.hasSentinel,
    compressed: entries.filter((e) => e.compressed).length,
    kinds: entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    }, {}),
    warnings: mkf.warnings,
  };
  if (v.json) {
    ctx.log.out(JSON.stringify({ ...summary, entries }, null, 2));
    return ExitCode.OK;
  }
  ctx.log.out(
    `${name}  ${summary.size} 字节  sha256 ${summary.sha256}\n` +
      `indexTableOffset=${summary.indexTableOffset}  资源数=${summary.count}  哨兵=${summary.hasSentinel ? '有' : '无'}  ` +
      `压缩=${summary.compressed}  类型=${JSON.stringify(summary.kinds)}`,
  );
  const rows = entries.map((e) => [
    String(e.index),
    String(e.offset),
    String(e.rawSize),
    String(e.storedSize),
    String(e.imageOffset),
    String(e.imageSize),
    e.compressed ? 'Z' : '',
    e.kind,
  ]);
  for (const l of renderTable(['#', 'offset', 'rawSize', 'stored', 'imgOff', 'imgSize', 'Z', 'kind'], rows, 'rrrrrr')) {
    ctx.log.out(l);
  }
  for (const w of mkf.warnings) ctx.log.out(`${ICON.warn} ${w.code} ${w.detail}`);
  ctx.log.out(`${ICON.pass} 容器不变量全部通过`);
  return ExitCode.OK;
}

// ───────────────────────── map raw ─────────────────────────

function printStats(ctx: ExtractContext, s: RawStats): void {
  ctx.log.out(`  落点码分布（flags 低字节）：`);
  for (const [code, { count, names }] of Object.entries(s.landingCodes)) {
    ctx.log.out(`    ${code.padStart(2)}: ${String(count).padStart(3)}  ${names.join('、')}`);
  }
  ctx.log.out(`  type 归类：${JSON.stringify(s.nodeTypeKinds)}  度数：${JSON.stringify(s.degree)}`);
  ctx.log.out(`  bit31 禁放物件：${s.noItems.count} 个节点 [${s.noItems.nodes.join(',')}]`);
  ctx.log.out(
    `  静态封路 bit(30−k)：${s.blocked.length} 处 ` +
      s.blocked.map((b) => `节点${b.node}「${b.name ?? ''}」槽${b.slot}→${b.target}`).join('；'),
  );
  for (const t of ['nodes', 'lands', 'facilities', 'companies', 'landscapes'] as const) {
    const c = s.coords[t];
    ctx.log.out(`  ${t} 坐标 x∈[${c.x.min},${c.x.max}] y∈[${c.y.min},${c.y.max}]`);
    for (const m of ['32', '24']) {
      ctx.log.out(`    x mod ${m}：${JSON.stringify(c.x.mod[m])}`);
      ctx.log.out(`    y mod ${m}：${JSON.stringify(c.y.mod[m])}`);
    }
  }
  const top = (rec: Record<string, number>, n: number) =>
    Object.entries(rec)
      .slice(0, n)
      .map(([k, c]) => `(${k})×${c}`)
      .join(' ');
  ctx.log.out(`  边 ${s.edges.count} 条；世界坐标差 Top：${top(s.edges.worldDelta, 12)}`);
  ctx.log.out(`  32 格差：${top(s.edges.cellDelta, 20)}`);
  ctx.log.out(
    `  同一 32 格内的节点组：${s.sameCell32.length === 0 ? '无' : s.sameCell32.map((g) => g.join('/')).join(' ')}`,
  );
}

async function cmdMapRaw(ctx: ExtractContext, v: Values): Promise<number> {
  const gm = parseMapId(v.map);
  const { selected, skipped } = await selectSources(ctx, v.sources ?? 'auto');
  for (const s of skipped) ctx.log.out(`（跳过缺失来源 ${s.id}：${s.relPath}）`);
  const known = await tryLoadKnown(ctx);
  let exit: number = ExitCode.OK;
  let printedStats = false;
  for (const def of selected) {
    try {
      const { raw, resource } = await loadRawSource(ctx, def, gm, known);
      const dir = ctx.cachePath('raw', def.id);
      const out = await writeCanonicalJson(ctx, path.join(dir, `map${gm}.raw.json`), raw);
      const stats = computeRawStats(raw);
      await writeCanonicalJson(ctx, path.join(dir, `map${gm}.stats.json`), stats);
      if (v['dump-bin']) await safeWriteFile(ctx, path.join(dir, `map${gm}.bin`), resource);
      const errors = failedChecks(raw, 'error');
      const warns = failedChecks(raw, 'warn');
      const total = Object.keys(raw.checks).length;
      const h = raw.header;
      ctx.log.out(
        `${errors.length === 0 ? ICON.pass : ICON.fail} ${def.id}  ${raw.source.file}[${raw.source.resource}]  ` +
          `${raw.source.byteLength} 字节${raw.source.compressed ? '（压缩）' : '（未压缩）'}  sha256 ${short(raw.source.resourceSha256)}  ` +
          `已知文件=${raw.source.knownFileId ?? '否'}`,
      );
      ctx.log.out(
        `  计数 nodes/lands/facilities/companies/landscapes = ` +
          `${h.nodes.count}/${h.lands.count}/${h.facilities.count}/${h.companies.count}/${h.landscapes.count}  ` +
          `检查 ${total - errors.length - warns.length}/${total} 通过，${warns.length} 告警，${errors.length} 错误`,
      );
      for (const [k, c] of [...errors, ...warns]) {
        ctx.log.out(`  ${c.severity === 'error' ? ICON.fail : ICON.warn} ${k}: ${c.detail ?? ''}`);
      }
      ctx.log.out(`  → ${ctx.displayPath(out)}`);
      if (!printedStats || v.verbose) {
        printStats(ctx, stats);
        printedStats = true;
      }
      if (errors.length > 0) exit = Math.max(exit, ExitCode.STRUCTURE);
    } catch (e) {
      if (!(e instanceof ExtractError)) throw e;
      ctx.log.err(`${ICON.fail} ${def.id}: ${e.message}`);
      exit = Math.max(exit, e.exitCode);
    }
  }
  return exit;
}

// ───────────────────────── map diff ─────────────────────────

async function loadCachedRaw(ctx: ExtractContext, gm: number): Promise<MapDataRaw[]> {
  const raws: MapDataRaw[] = [];
  for (const def of RAW_SOURCES) {
    const p = ctx.cachePath('raw', def.id, `map${gm}.raw.json`);
    if (!(await isFile(p))) continue;
    const raw = JSON.parse(await readFile(p, 'utf8')) as MapDataRaw;
    if (raw.schema !== 'rich4.map-raw/1' || raw.globalMapId !== gm || raw.source?.id !== def.id) {
      throw new ExtractError('E_RAW_CACHE', `${ctx.displayPath(p)} 不是有效的 MapDataRaw，请重新运行 map raw`);
    }
    raws.push(raw);
  }
  return raws;
}

async function cmdMapDiff(ctx: ExtractContext, v: Values): Promise<number> {
  const gm = parseMapId(v.map);
  const raws = await loadCachedRaw(ctx, gm);
  if (raws.length < 2) {
    throw new ExtractError(
      'E_MISSING_INPUT',
      `只找到 ${raws.length} 个 raw 来源（需 ≥2），请先运行 map raw --map ${gm} --sources all`,
      ExitCode.MISSING_INPUT,
    );
  }
  const diff = diffRaw(raws);
  const out = await writeCanonicalJson(ctx, ctx.cachePath('diff', `map${gm}.json`), diff);
  const code = diffExitCode(diff);
  if (v.json) {
    ctx.log.out(JSON.stringify(diff, null, 2));
    return code;
  }
  ctx.log.out(
    `基线 ${diff.baseline}；来源：${diff.sources.map((s) => `${s.id}(${short(s.resourceSha256)})`).join('、')}`,
  );
  ctx.log.out(`字节完全相同的分组：${diff.identicalGroups.map((g) => `[${g.join(', ')}]`).join(' ')}`);
  if (diff.summary.length === 0) ctx.log.out(`${ICON.pass} 所有来源逐字节一致`);
  else {
    const rows = diff.summary.map((r) => [
      r.bucket === 'rule' ? '规则相关' : '表现相关',
      r.table,
      r.field,
      `+${r.offset}`,
      r.byteOffsets.join(','),
      String(r.records),
    ]);
    for (const l of renderTable(['类别', '表', '字段', '偏移', '差异字节', '记录数'], rows, '     r')) ctx.log.out(l);
  }
  if (v.verbose) {
    for (const it of diff.rule)
      ctx.log.out(`  规则 ${it.table}#${it.id ?? '-'} ${it.field} ${JSON.stringify(it.values)}`);
  }
  ctx.log.out(`规则相关 ${diff.counts.rule} 项，表现相关 ${diff.counts.presentation} 项 → ${ctx.displayPath(out)}`);
  if (code === ExitCode.RULE_DIFF) {
    ctx.log.out(`${ICON.fail} 存在规则相关差异：需要用户选定基线（写入 overrides 的 source.id），exit 4`);
  } else ctx.log.out(`${ICON.pass} 只有表现相关差异，exit 0`);
  return code;
}

// ───────────────────────── verify --samples ─────────────────────────

async function cmdVerify(ctx: ExtractContext, v: Values): Promise<number> {
  const all = !v.samples && !v.tables && !v.constants;
  let exit: number = ExitCode.OK;
  if (v.samples || all) exit = Math.max(exit, await cmdVerifySamples(ctx, v));
  if (v.tables || all) exit = Math.max(exit, await cmdVerifyTables(ctx, v));
  if (v.constants || all) exit = Math.max(exit, await cmdVerifyConstants(ctx, v));
  return exit;
}

async function cmdVerifySamples(ctx: ExtractContext, v: Values): Promise<number> {
  const gm = v.map === undefined ? 0 : parseMapId(v.map);
  if (gm !== 0) throw new ExtractError('E_ARGS', `只有台湾（--map 0）有样本，收到 --map ${gm}`);
  const { selected, skipped } = await selectSources(ctx, v.sources ?? 'auto');
  for (const s of skipped) ctx.log.out(`（跳过缺失来源 ${s.id}）`);
  const known = await tryLoadKnown(ctx);
  const perSource: { id: string; results: SampleResult[] }[] = [];
  for (const def of selected) {
    const { raw } = await loadRawSource(ctx, def, gm, known);
    perSource.push({ id: def.id, results: runTaiwanSamples(raw) });
  }
  await writeCanonicalJson(ctx, ctx.cachePath('verify', `samples.map${gm}.json`), {
    schema: 'rich4.samples/1',
    globalMapId: gm,
    sources: perSource,
  });
  if (v.json) ctx.log.out(JSON.stringify(perSource, null, 2));
  else {
    const base = perSource[0]!;
    const rows = base.results.map((r, i) => [
      r.label,
      r.expected,
      r.actual,
      ...perSource.map((s) => ICON[s.results[i]!.status]),
    ]);
    for (const l of renderTable(['样本', '期望', `实际（${base.id}）`, ...perSource.map((s) => s.id)], rows))
      ctx.log.out(l);
    for (const s of perSource) {
      for (const r of s.results) {
        const isBase = s === base;
        if (r.detail && (isBase || r.status !== 'pass')) ctx.log.out(`  [${s.id}] ${r.label}：${r.detail}`);
        if (!isBase && r.actual !== base.results.find((b) => b.id === r.id)?.actual) {
          ctx.log.out(`  [${s.id}] ${r.label} 实际 ${r.actual}`);
        }
      }
    }
  }
  const failed = perSource.some((s) => samplesFailed(s.results));
  ctx.log.out(failed ? `${ICON.fail} 有样本失败，exit 1` : `${ICON.pass} 样本全部通过`);
  return failed ? ExitCode.STRUCTURE : ExitCode.OK;
}

// ───────────────────────── 入口 ─────────────────────────

export interface MainOptions {
  logger?: Logger;
  cwd?: string;
}

export async function main(argv: readonly string[], opts: MainOptions = {}): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    (opts.logger ?? { err: (l: string) => process.stderr.write(`${l}\n`) }).err(
      `${e instanceof Error ? e.message : String(e)}\n${USAGE}`,
    );
    return ExitCode.STRUCTURE;
  }
  const { values: v, positionals: pos } = parsed;
  const ctxOpts: ContextOptions = {};
  if (v.root !== undefined) ctxOpts.root = v.root;
  if (v.src !== undefined) ctxOpts.src = v.src;
  if (v.cache !== undefined) ctxOpts.cache = v.cache;
  if (v.lock !== undefined) ctxOpts.lockFile = v.lock;
  if (opts.cwd !== undefined) ctxOpts.cwd = opts.cwd;
  if (opts.logger !== undefined) ctxOpts.logger = opts.logger;
  const ctx = new ExtractContext(ctxOpts);
  if (v.help || pos.length === 0) {
    ctx.log.out(USAGE);
    return v.help ? ExitCode.OK : ExitCode.STRUCTURE;
  }
  const cmd = pos.slice(0, 2).join(' ');
  try {
    if (pos[0] === 'fingerprint') return await cmdFingerprint(ctx, v);
    if (cmd === 'mkf ls') return await cmdMkfLs(ctx, v);
    if (cmd === 'map raw') return await cmdMapRaw(ctx, v);
    if (cmd === 'map diff') return await cmdMapDiff(ctx, v);
    if (pos[0] === 'verify') return await cmdVerify(ctx, v);
    if (cmd === 'exe tables') return await cmdExeTables(ctx, v);
    if (cmd === 'exe diff') return await cmdExeDiff(ctx, v);
    if (cmd === 'exe constants') return await cmdExeConstants(ctx, v);
    if (cmd === 'map build') return await cmdMapBuild(ctx, v);
    if (pos[0] === 'pack') return await cmdPack(ctx, v);
    if (cmd === 'overrides schema') return await cmdOverridesSchema(ctx);
    if (cmd === 'assets build') return await cmdAssetsBuild(ctx, v);
    if (cmd === 'assets verify') return await cmdAssetsVerify(ctx, v);
    if (cmd === 'assets ls') return await cmdAssetsLs(ctx, v);
    if (cmd === 'assets preview') return await cmdAssetsPreview(ctx, v);
    if (cmd === 'assets synth') return await cmdAssetsSynth(ctx, v);
    ctx.log.err(`未知命令：${pos.join(' ')}\n${USAGE}`);
    return ExitCode.STRUCTURE;
  } catch (e) {
    if (e instanceof ExtractError) {
      ctx.log.err(`${ICON.fail} ${e.message}`);
      return e.exitCode;
    }
    ctx.log.err(`${ICON.fail} 未预期的错误：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return ExitCode.STRUCTURE;
  }
}

async function isDirectRun(): Promise<boolean> {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (await realpath(entry)) === (await realpath(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (await isDirectRun()) {
  process.exitCode = await main(process.argv.slice(2));
}
