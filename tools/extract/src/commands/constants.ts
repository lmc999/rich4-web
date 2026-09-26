import { readFile } from 'node:fs/promises';
import { ExitCode, type ExtractContext, ExtractError } from '../context';
import { CodeIndex } from '../exe/code';
import {
  CONSTANTS_FILE,
  type ConstantAnchors,
  type ConstantResult,
  type ConstValue,
  chainSourceChecks,
  parseConstantAnchors,
  resolveConstants,
} from '../exe/constants';
import { readExe } from '../exe/extract';
import { safeWriteFile, writeCanonicalJson } from '../io/writeCanonicalJson';
import { PeFile } from '../pe/scan';
import { ICON, renderTable } from '../report/table';

/**
 * exe constants [--write-anchors] / verify --constants（data-pipeline.md §6.4 第 7 条；architecture D2 验证 2）：
 * 在两版 exe 上逐项解析 anchors/constants.json。v2.06 的位置由 v3.11 指令迁移得到，
 * `--write-anchors` 把迁移结果写回 anchors（只改 v206 / ref206 字段）；verify 只读，要求：
 * v3.11 值 = 期望值、v2.06 值 = 期望值（或 v206Value）、迁移结果 = anchors 登记的 v2.06 VA、同源乘法链读同一地址。
 */

export interface ConstantsArgs {
  json?: boolean | undefined;
  verbose?: boolean | undefined;
  'write-anchors'?: boolean | undefined;
}

export interface ConstantsReport {
  schema: 'rich4.constants/1';
  editions: ('v206' | 'v311')[];
  results: ConstantResult[];
  chainSources: ReturnType<typeof chainSourceChecks>;
  /** anchors 登记的 v2.06 VA 与迁移结果不一致的项 */
  stale: string[];
  failed: string[];
  /** data 项：v2.06 中引用数据的指令（迁移得到） */
  refSites: Map<string, string>;
}

const fmt = (v: ConstValue | null): string =>
  v === null ? '—' : Array.isArray(v) ? `[${v.join(',')}]` : Number.isInteger(v) ? String(v) : String(v);

async function loadAnchorsFile(): Promise<{ text: string; anchors: ConstantAnchors }> {
  const text = await readFile(CONSTANTS_FILE, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ExtractError(
      'E_ANCHORS',
      `anchors/constants.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { text, anchors: parseConstantAnchors(json) };
}

export async function runConstants(ctx: ExtractContext, anchors: ConstantAnchors): Promise<ConstantsReport> {
  const a = await readExe(ctx, 'v311');
  const b = await readExe(ctx, 'v206');
  if (!a && !b) {
    throw new ExtractError('E_MISSING_INPUT', 'original/ 下没有 RICH4.EXE（两个版本都缺）', ExitCode.MISSING_INPUT);
  }
  const ref = a ? CodeIndex.build(new PeFile(a.bytes, a.rel)) : null;
  const dst = b ? CodeIndex.build(new PeFile(b.bytes, b.rel)) : null;
  const results = resolveConstants(anchors, ref, dst);
  const editions: ('v206' | 'v311')[] = [];
  if (b) editions.push('v206');
  if (a) editions.push('v311');
  const stale = results
    .filter((r) => r.v206 && r.v206.transferred !== null && r.v206.transferred !== r.v206.anchored)
    .map((r) => r.id);
  const chains = chainSourceChecks(anchors, results);
  const failed = results
    .filter((r) => (a !== null && !r.v311.ok) || (b !== null && (r.v206 === null || !r.v206.ok)))
    .map((r) => r.id);
  const refSites = new Map<string, string>();
  for (const r of results) if (r.v206?.refVa) refSites.set(r.id, r.v206.refVa);
  return { schema: 'rich4.constants/1', editions, results, chainSources: chains, stale, failed, refSites };
}

/**
 * 只改 anchors 各项的 v206 与 data 项的 loc.ref206（输出 2 空格缩进的 JSON，Biome 保持原样）。
 * 返回 null 表示没有任何字段需要改（调用方不写文件）。
 */
export function patchAnchorsText(
  text: string,
  results: readonly ConstantResult[],
  refSites: ReadonlyMap<string, string>,
): { text: string; changed: string[] } | null {
  const json = JSON.parse(text) as { constants: Record<string, unknown>[] };
  const byId = new Map(results.map((r) => [r.id, r]));
  const changed: string[] = [];
  for (const c of json.constants) {
    const r = byId.get(c.id as string);
    if (!r?.v206 || r.v206.transferred === null || !r.v206.ok) continue;
    const loc = c.loc as Record<string, unknown>;
    const site = refSites.get(c.id as string);
    const newRef = loc.kind === 'data' && site ? site : loc.ref206;
    if (c.v206 === r.v206.transferred && loc.ref206 === newRef) continue;
    c.v206 = r.v206.transferred;
    if (newRef !== undefined) loc.ref206 = newRef;
    changed.push(c.id as string);
  }
  return changed.length === 0 ? null : { text: `${JSON.stringify(json, null, 2)}\n`, changed };
}

function printReport(ctx: ExtractContext, rep: ConstantsReport, verbose: boolean): void {
  const rows = rep.results
    .filter((r) => verbose || !r.v311.ok || (r.v206 !== null && !r.v206.ok) || rep.stale.includes(r.id))
    .map((r) => [
      r.v311.ok && (r.v206 === null || r.v206.ok) ? ICON.pass : ICON.fail,
      r.id,
      fmt(r.expected),
      `${r.v311.va ?? '-'} ${fmt(r.v311.value)}`,
      r.v206 ? `${r.v206.va ?? '-'} ${fmt(r.v206.value)}` : '（缺）',
      r.confirmed ? '是' : '否',
      r.v311.error ?? r.v206?.error ?? '',
    ]);
  if (rows.length > 0) {
    for (const l of renderTable(['', 'id', '期望', 'v3.11', 'v2.06', '已确认', '备注'], rows)) ctx.log.out(l);
  }
  const bad = rep.chainSources.filter((c) => !c.ok);
  ctx.log.out(
    `常量 ${rep.results.length} 个（已确认语义 ${rep.results.filter((r) => r.confirmed).length}）；` +
      `两版值不同 ${rep.results.filter((r) => r.same === false).length}；不符/未解析 ${rep.failed.length}；` +
      `anchors 的 v2.06 VA 过期 ${rep.stale.length}；同源乘法链地址不一致 ${bad.length}`,
  );
  for (const c of rep.chainSources) {
    ctx.log.out(`  ${c.ok ? ICON.pass : ICON.fail} ${c.edition} 乘法链「${c.source}」读取 ${c.addrs.join(' / ')}`);
  }
}

export async function cmdExeConstants(ctx: ExtractContext, v: ConstantsArgs): Promise<number> {
  const { text, anchors } = await loadAnchorsFile();
  const rep = await runConstants(ctx, anchors);
  const out = await writeCanonicalJson(ctx, ctx.cachePath('constants.json'), {
    ...rep,
    refSites: Object.fromEntries(rep.refSites),
  });
  if (v.json) ctx.log.out(JSON.stringify({ ...rep, refSites: Object.fromEntries(rep.refSites) }, null, 2));
  printReport(ctx, rep, v.verbose === true);
  if (v['write-anchors']) {
    if (!rep.editions.includes('v311') || !rep.editions.includes('v206')) {
      throw new ExtractError('E_MISSING_INPUT', '--write-anchors 需要两个版本的 exe', ExitCode.MISSING_INPUT);
    }
    const patched = patchAnchorsText(text, rep.results, rep.refSites);
    if (patched) {
      await safeWriteFile(ctx, CONSTANTS_FILE, patched.text);
      ctx.log.out(`已更新 ${ctx.displayPath(CONSTANTS_FILE)} 中 ${patched.changed.length} 项的 v2.06 VA`);
    } else ctx.log.out('anchors 无需更新');
  }
  ctx.log.out(`→ ${ctx.displayPath(out)}`);
  return rep.failed.length > 0 ? ExitCode.STRUCTURE : ExitCode.OK;
}

export async function cmdVerifyConstants(ctx: ExtractContext, v: ConstantsArgs): Promise<number> {
  const { anchors } = await loadAnchorsFile();
  const rep = await runConstants(ctx, anchors);
  const out = await writeCanonicalJson(ctx, ctx.cachePath('verify', 'constants.json'), {
    ...rep,
    refSites: Object.fromEntries(rep.refSites),
  });
  if (v.json) ctx.log.out(JSON.stringify({ ...rep, refSites: Object.fromEntries(rep.refSites) }, null, 2));
  printReport(ctx, rep, v.verbose === true);
  const chainBad = rep.chainSources.some((c) => !c.ok);
  const failed = rep.failed.length > 0 || rep.stale.length > 0 || chainBad;
  for (const id of rep.stale)
    ctx.log.out(`  ${ICON.fail} ${id}：anchors 的 v2.06 VA 与迁移结果不同（运行 exe constants --write-anchors）`);
  ctx.log.out(`→ ${ctx.displayPath(out)}`);
  ctx.log.out(
    failed
      ? `${ICON.fail} 常量锚点核对失败，exit 1`
      : `${ICON.pass} ${rep.results.length} 个常量锚点在 ${rep.editions.join('、')} 上全部解析且等于期望值`,
  );
  return failed ? ExitCode.STRUCTURE : ExitCode.OK;
}
