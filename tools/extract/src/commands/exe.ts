import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ExitCode, type ExtractContext, ExtractError } from '../context';
import { CodeIndex } from '../exe/code';
import { loadConstantAnchors, resolveConstants } from '../exe/constants';
import {
  EDITIONS,
  EXE_PATHS,
  extractEditions,
  parseEditions,
  readCachedTables,
  readExe,
  tablesCachePath,
} from '../exe/extract';
import { buildFuncSeeds, funcDiff } from '../exe/funcdiff';
import { stringMapping } from '../exe/insnTransfer';
import { LocateError } from '../exe/locate';
import { type R2Check, r2LinearCheck } from '../exe/r2';
import type { Check, ExeEdition, ExtractedTables } from '../exe/types';
import type { FingerprintReport } from '../fingerprint/identify';
import { sha256Hex } from '../io/hash';
import { findCaseInsensitive, isFile, readFileRO } from '../io/readOnly';
import { safeWriteFile, writeCanonicalJson } from '../io/writeCanonicalJson';
import { parseMapRaw } from '../map/parseRaw';
import { diffRaw } from '../map/rawDiff';
import type { MapDataRaw } from '../map/rawTypes';
import { RAW_SOURCES } from '../map/sources';
import { MkfArchive } from '../mkf/container';
import { Big5StringIndex, PeFile } from '../pe/scan';
import { renderEventsDoc } from '../report/eventsDoc';
import { ICON, renderTable } from '../report/table';
import { type ContainerInfo, type MapDiffInfo, renderVersionDiff, type StringDiffInfo } from '../report/versionDiff';
import { compareRules, loadManualTables, type RulesReport } from '../verify/rulesAgainstExe';

/** exe tables / exe diff / verify --tables（data-pipeline.md §3、§6） */

export interface ExeArgs {
  edition?: string | undefined;
  json?: boolean | undefined;
  verbose?: boolean | undefined;
  /** exe diff：另用 radare2 线性反汇编核对指令边界（可选） */
  r2?: boolean | undefined;
  'r2-timeout'?: string | undefined;
}

export const EXE_DIFF_COMMAND = 'npm run extract -- exe diff';

const checkIcon = (c: Check) =>
  c.ok ? ICON.pass : c.level === 'error' ? ICON.fail : c.level === 'warn' ? ICON.warn : 'ℹ️';

function printTables(ctx: ExtractContext, t: ExtractedTables, verbose: boolean): void {
  ctx.log.out(`== ${t.edition}  ${t.exe.file}  sha256 ${t.exe.sha256}  登记 ${t.exe.knownFileId ?? '（未登记）'}`);
  const rows = Object.entries(t.locate).map(([id, l]) => [
    id,
    l.va,
    l.fileOffset,
    l.method,
    l.candidates.map((c) => `${c.method}${c.accepted ? '✓' : c.va === null ? '∅' : '✗'}`).join(' '),
    l.checks.every((c) => c.ok || c.level !== 'error') ? ICON.pass : ICON.fail,
  ]);
  for (const l of renderTable(['表', 'VA', '文件偏移', '方法', '候选', '结构'], rows)) ctx.log.out(`  ${l}`);
  if (verbose) {
    for (const [id, l] of Object.entries(t.locate)) {
      for (const c of l.candidates) ctx.log.out(`  ${id} ${c.method} ${c.va ?? '-'}：${c.detail}`);
      for (const c of l.checks) ctx.log.out(`  ${id} ${checkIcon(c)} ${c.id} ${c.detail}`);
    }
  }
  ctx.log.out(
    `  股票 ${t.stocks.rows.length} 支（${t.stocks.maps} 张图）；节日 ${t.holidays.maps} 张图；设施上限 [${t.facilityLevels.max}]；` +
      `默认资金下标 ${t.setup.defaults.funds.index} → ${t.setup.defaults.funds.value}`,
  );
  for (const f of t.facts) ctx.log.out(`  ${checkIcon(f)} ${f.id}：${f.detail}`);
}

export function factsFailed(t: ExtractedTables): boolean {
  return t.facts.some((f) => !f.ok && f.level === 'error');
}

export async function cmdExeTables(ctx: ExtractContext, v: ExeArgs): Promise<number> {
  const eds = parseEditions(v.edition);
  let res: Partial<Record<ExeEdition, ExtractedTables>>;
  try {
    res = await extractEditions(ctx, eds);
  } catch (e) {
    if (e instanceof LocateError) {
      ctx.log.err(`${ICON.fail} ${e.message}`);
      for (const c of e.candidates) ctx.log.err(`   ${c.method} ${c.va ?? '-'}：${c.detail}`);
      return ExitCode.STRUCTURE;
    }
    throw e;
  }
  let exit: number = ExitCode.OK;
  for (const ed of eds) {
    const t = res[ed];
    if (!t) continue;
    const out = await writeCanonicalJson(ctx, tablesCachePath(ctx, ed), t);
    if (v.json) ctx.log.out(JSON.stringify({ edition: ed, locate: t.locate, facts: t.facts }, null, 2));
    else {
      printTables(ctx, t, v.verbose === true);
      ctx.log.out(`  → ${ctx.displayPath(out)}`);
    }
    if (factsFailed(t)) exit = ExitCode.STRUCTURE;
  }
  ctx.log.out(
    exit === ExitCode.OK ? `${ICON.pass} 全部表唯一定位且结构校验通过` : `${ICON.fail} 有事实核对失败，exit 1`,
  );
  return exit;
}

// ───────────────────────── exe diff → version-diff.md ─────────────────────────

const MAP_LABELS: readonly string[] = ['台灣', '大陸', '日本', '美國'];

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

/** 每个地图容器只读一次；比较 gm 0..3（MapDat 只有 4 张图） */
async function mapDiffs(ctx: ExtractContext): Promise<{ containers: ContainerInfo[]; maps: MapDiffInfo[] }> {
  const containers: ContainerInfo[] = [];
  const archives: { def: (typeof RAW_SOURCES)[number]; mkf: MkfArchive; rel: string; sha: string }[] = [];
  for (const def of RAW_SOURCES) {
    const p = await findCaseInsensitive(ctx.srcDir, def.relPath);
    if (p === null) continue;
    const bytes = await readFileRO(p);
    const rel = path.relative(ctx.srcDir, p).split(path.sep).join('/');
    const mkf = MkfArchive.open(bytes, rel);
    const sha = sha256Hex(bytes);
    archives.push({ def, mkf, rel, sha });
    containers.push({
      file: rel,
      bytes: bytes.length,
      sha256: sha,
      count: mkf.count,
      compressed: mkf.entries().filter((e) => e.compressed).length,
      hasSentinel: mkf.hasSentinel,
    });
  }
  const maps: MapDiffInfo[] = [];
  if (archives.length < 2) return { containers, maps };
  for (let gm = 0; gm < MAP_LABELS.length; gm++) {
    const raws: MapDataRaw[] = [];
    for (const a of archives) {
      const idx = a.def.resourceFor(gm);
      if (idx >= a.mkf.count) continue;
      const entry = a.mkf.entry(idx);
      raws.push(
        parseMapRaw(
          a.mkf.read(idx),
          {
            id: a.def.id,
            edition: a.def.edition,
            file: a.rel,
            fileSha256: a.sha,
            knownFileId: null,
            container: a.def.container,
            resource: idx,
            compressed: entry.compressed,
          },
          gm,
        ),
      );
    }
    if (raws.length < 2) continue;
    const d = diffRaw(raws);
    const fmt = (x: unknown) => JSON.stringify(x);
    maps.push({
      gm,
      label: MAP_LABELS[gm]!,
      sources: d.sources.map((s) => s.id),
      rule: d.counts.rule,
      presentation: d.counts.presentation,
      identicalGroups: d.identicalGroups,
      ruleItems: d.rule.slice(0, 12).map(
        (it) =>
          `${it.table}#${it.id ?? '-'} ${it.field}（+${it.offset}）：` +
          Object.entries(it.values)
            .map(([k, val]) => `${k}=${fmt(val)}`)
            .join(' / '),
      ),
      ruleOdd: d.rule.map((it) => {
        const vals = Object.entries(it.values).map(([k, val]) => [k, JSON.stringify(val)] as const);
        const odd = vals.filter(([, x]) => vals.filter(([, y]) => y === x).length === 1);
        return odd.length === 1 && vals.length >= 3 ? odd[0]![0] : null;
      }),
      presentationFields: d.summary
        .filter((r) => r.bucket === 'presentation')
        .map((r) => `${r.table}.${r.field}（+${r.offset}，${r.records} 条）`),
    });
  }
  return { containers, maps };
}

function stringDiff(a: Uint8Array, b: Uint8Array): StringDiffInfo {
  const sa = Big5StringIndex.build(new PeFile(a, 'v206'));
  const sb = Big5StringIndex.build(new PeFile(b, 'v311'));
  const ta = new Set(sa.entries().map((e) => e.text));
  const tb = new Set(sb.entries().map((e) => e.text));
  const onlyA = [...ta].filter((x) => !tb.has(x));
  const onlyB = [...tb].filter((x) => !ta.has(x));
  // 示例只取「全是中文/全角字符、数字与常见标点」的串，避开被 NUL 切碎的非文本字节
  const pick = (xs: string[]) =>
    xs
      .filter(
        (x) =>
          x.length <= 12 &&
          /^[\d.\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+$/u.test(x) &&
          (x.match(/[\u4e00-\u9fff]/gu)?.length ?? 0) >= 2,
      )
      .slice(0, 12);
  return {
    v206: ta.size,
    v311: tb.size,
    common: [...ta].filter((x) => tb.has(x)).length,
    onlyV206: onlyA.length,
    onlyV311: onlyB.length,
    examplesV206: pick(onlyA),
    examplesV311: pick(onlyB),
  };
}

export async function cmdExeDiff(ctx: ExtractContext, v: ExeArgs): Promise<number> {
  const res = await extractEditions(ctx, EDITIONS);
  const a = res.v206;
  const b = res.v311;
  if (!a || !b) {
    throw new ExtractError('E_MISSING_INPUT', 'exe diff 需要两个版本的 exe', ExitCode.MISSING_INPUT);
  }
  for (const t of [a, b]) await writeCanonicalJson(ctx, tablesCachePath(ctx, t.edition as ExeEdition), t);
  const { containers, maps } = await mapDiffs(ctx);
  const exeA = await readExe(ctx, 'v206');
  const exeB = await readExe(ctx, 'v311');
  const strings = exeA && exeB ? stringDiff(exeA.bytes, exeB.bytes) : null;
  // 代码级：常量锚点（两版）与函数级对比
  let constants: ReturnType<typeof resolveConstants> | null = null;
  let fdr: ReturnType<typeof funcDiff> | null = null;
  if (exeA && exeB) {
    const pa = new PeFile(exeB.bytes, exeB.rel);
    const pb = new PeFile(exeA.bytes, exeA.rel);
    const ca = CodeIndex.build(pa);
    const cb = CodeIndex.build(pb);
    const m = stringMapping(pa, pb);
    constants = resolveConstants(loadConstantAnchors(), ca, cb, { translate: m.translate });
    const seeds = buildFuncSeeds(
      ca,
      cb,
      b,
      a,
      constants.map((c) => ({ id: c.id, v311: c.v311.va, v206: c.v206?.va ?? null })),
    );
    fdr = funcDiff(ca, cb, seeds, { translate: m.translate, dstStrings: m.targets, depth: 1 });
  }
  let r2: { edition: ExeEdition; check: R2Check }[] | null = null;
  if (v.r2 && exeA && exeB) {
    const timeout = v['r2-timeout'] ? Number(v['r2-timeout']) * 1000 : 120_000;
    r2 = [];
    for (const x of [exeA, exeB]) {
      const check = await r2LinearCheck(path.join(ctx.srcDir, x.rel), new PeFile(x.bytes, x.rel), timeout);
      r2.push({ edition: x.edition, check });
      ctx.log.out(
        check.available && check.error === null
          ? `  r2 核对 ${x.edition}：${check.insns} 条指令，边界不一致 ${check.mismatches}`
          : `  ${ICON.warn} r2 不可用或失败（${check.error ?? '未知'}）`,
      );
    }
  }
  const md = renderVersionDiff({
    command: v.r2 ? `${EXE_DIFF_COMMAND} --r2` : EXE_DIFF_COMMAND,
    exes: res,
    fingerprint: await readFingerprint(ctx),
    containers,
    maps,
    strings,
    constants,
    funcdiff: fdr,
    r2,
  });
  const out = await safeWriteFile(ctx, path.join(ctx.root, 'docs', 'research', 'version-diff.md'), md);
  if (constants && fdr) {
    const ev = renderEventsDoc({ command: EXE_DIFF_COMMAND, v311: b, v206: a, constants, funcdiff: fdr.results });
    const evOut = await safeWriteFile(ctx, path.join(ctx.root, 'docs', 'research', 'events-from-exe.md'), ev);
    ctx.log.out(`→ ${ctx.displayPath(evOut)}`);
  }
  await writeCanonicalJson(ctx, ctx.cachePath('version-diff.json'), {
    schema: 'rich4.version-diff/1',
    containers,
    maps,
    strings,
    digests: { v206: a.digests, v311: b.digests },
    funcdiff: fdr,
  });
  if (v.json) ctx.log.out(JSON.stringify({ containers, maps, strings }, null, 2));
  for (const m of maps) {
    ctx.log.out(
      `  地图 gm ${m.gm} ${m.label}：规则差异 ${m.rule}、表现差异 ${m.presentation}；字节相同 ${m.identicalGroups.map((g) => `[${g.join(',')}]`).join(' ')}`,
    );
  }
  ctx.log.out(`→ ${ctx.displayPath(out)}`);
  const failed = factsFailed(a) || factsFailed(b);
  ctx.log.out(failed ? `${ICON.fail} 有事实核对失败，exit 1` : `${ICON.pass} 版本差异报告已生成`);
  return failed ? ExitCode.STRUCTURE : ExitCode.OK;
}

// ───────────────────────── verify --tables ─────────────────────────

/** 取两个版本的抽取结果：有原版 exe 就现场抽取（并刷新缓存），否则读缓存 */
export async function loadBothTables(ctx: ExtractContext): Promise<Partial<Record<ExeEdition, ExtractedTables>>> {
  const out: Partial<Record<ExeEdition, ExtractedTables>> = {};
  const avail = await Promise.all(
    EDITIONS.map(async (e) => (await findCaseInsensitive(ctx.srcDir, EXE_PATHS[e])) !== null),
  );
  const live = EDITIONS.filter((_, i) => avail[i]);
  if (live.length > 0) {
    Object.assign(out, await extractEditions(ctx, live));
    for (const e of live) if (out[e]) await writeCanonicalJson(ctx, tablesCachePath(ctx, e), out[e]);
  }
  for (const e of EDITIONS) {
    if (out[e]) continue;
    const c = await readCachedTables(ctx, e);
    if (c) out[e] = c;
  }
  return out;
}

export async function runVerifyTables(
  ctx: ExtractContext,
): Promise<RulesReport & { facts: Partial<Record<ExeEdition, Check[]>> }> {
  const exe = await loadBothTables(ctx);
  if (!exe.v206 && !exe.v311) {
    throw new ExtractError(
      'E_MISSING_INPUT',
      '没有 exe 抽取结果：original/ 下没有 RICH4.EXE，缓存里也没有 tables.*.json（先运行 exe tables）',
      ExitCode.MISSING_INPUT,
    );
  }
  const manual = await loadManualTables(ctx.root);
  const facts: Partial<Record<ExeEdition, Check[]>> = {};
  for (const e of EDITIONS) if (exe[e]) facts[e] = exe[e]!.facts;
  return { ...compareRules(manual, exe), facts };
}

export async function cmdVerifyTables(ctx: ExtractContext, v: ExeArgs): Promise<number> {
  const rep = await runVerifyTables(ctx);
  const out = await writeCanonicalJson(ctx, ctx.cachePath('verify', 'tables.json'), rep);
  if (v.json) ctx.log.out(JSON.stringify(rep, null, 2));
  const vrow = rep.verdicts.map((d) => [
    d.table,
    String(d.items),
    d.manual === 'ok' ? ICON.pass : d.manual === 'mismatch' ? ICON.fail : '（缺）',
    d.editions === 'same' ? '相同' : d.editions === 'diff' ? '不同' : '单版本',
    d.conclusion,
  ]);
  for (const l of renderTable(['表', '项', '手录', 'v2.06/v3.11', '结论'], vrow)) ctx.log.out(l);
  const bad = rep.rows.filter((r) => r.status === 'mismatch');
  for (const r of bad) {
    ctx.log.out(`  ${ICON.fail} ${r.table} ${r.key}：手录 ${r.manual}，v2.06 ${r.v206 ?? '-'}，v3.11 ${r.v311 ?? '-'}`);
  }
  if (v.verbose) {
    for (const r of rep.rows.filter((x) => x.status === 'exeOnly')) {
      ctx.log.out(`  ℹ️ ${r.table} ${r.key}：exe v2.06 ${r.v206 ?? '-'} / v3.11 ${r.v311 ?? '-'}（无手录字段）`);
    }
  }
  // exe 事实核对 = 校验样本（台湾股票、卡价、道具价、角色现金比例、开局表、设施上限；期望值来自调研文档）
  let factBad = 0;
  for (const e of EDITIONS) {
    const fs = rep.facts[e];
    if (!fs) continue;
    ctx.log.out(`校验样本（${e} exe）：`);
    for (const f of fs) {
      if (!f.ok && f.level === 'error') factBad++;
      ctx.log.out(`  ${checkIcon(f)} ${f.id}：${f.detail}`);
    }
  }
  const badRefs = rep.verifyRefs.filter((r) => !r.ok);
  ctx.log.out(`@verify 引用 ${rep.verifyRefs.length} 条，无法解析 ${badRefs.length} 条`);
  for (const r of badRefs) ctx.log.out(`  ${ICON.fail} ${r.table}: ${r.ref}（${r.detail}）`);
  if (rep.checklist.length > 0) {
    ctx.log.out('对照清单（手录表缺失或不完整，只输出了 exe 值）：');
    for (const c of rep.checklist) ctx.log.out(`  - ${c}`);
  }
  for (const n of rep.notes) ctx.log.out(`  （${n}）`);
  ctx.log.out(`→ ${ctx.displayPath(out)}`);
  const failed = bad.length > 0 || badRefs.length > 0 || factBad > 0;
  ctx.log.out(
    failed
      ? `${ICON.fail} 手录值或校验样本与 exe 不符，exit 1`
      : `${ICON.pass} 手录表与校验样本核对通过（缺失的表见对照清单）`,
  );
  return failed ? ExitCode.STRUCTURE : ExitCode.OK;
}
