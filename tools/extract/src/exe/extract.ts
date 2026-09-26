import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ExitCode, type ExtractContext, ExtractError } from '../context';
import { type KnownFiles, loadKnownFiles } from '../fingerprint/identify';
import { sha256Hex } from '../io/hash';
import { findCaseInsensitive, isFile, readFileRO } from '../io/readOnly';
import { extractTables } from './locate';
import type { ExeEdition, ExtractedTables } from './types';

/** exe tables 的 IO 层：定位原版 exe、按版本抽取、读写 .cache/extract/tables.<edition>.json。 */

export const EXE_PATHS: Readonly<Record<ExeEdition, string>> = {
  v206: 'Game/RICH4.EXE',
  v311: 'MultiverseJourney/RICH4.EXE',
};

export const EDITIONS: readonly ExeEdition[] = ['v311', 'v206'];

export interface ExeInput {
  edition: ExeEdition;
  rel: string;
  bytes: Uint8Array;
  sha256: string;
  knownFileId: string | null;
}

export function tablesCachePath(ctx: ExtractContext, ed: ExeEdition): string {
  return ctx.cachePath(`tables.${ed}.json`);
}

async function known(ctx: ExtractContext): Promise<KnownFiles | null> {
  try {
    return await loadKnownFiles(ctx.packageDir);
  } catch {
    return null;
  }
}

export async function readExe(ctx: ExtractContext, ed: ExeEdition, k?: KnownFiles | null): Promise<ExeInput | null> {
  const p = await findCaseInsensitive(ctx.srcDir, EXE_PATHS[ed]);
  if (p === null) return null;
  const bytes = await readFileRO(p);
  const sha256 = sha256Hex(bytes);
  const kf = k === undefined ? await known(ctx) : k;
  const hit = kf?.files.find((f) => f.role === 'exe' && f.sha256 === sha256) ?? null;
  return {
    edition: ed,
    rel: path.relative(ctx.srcDir, p).split(path.sep).join('/'),
    bytes,
    sha256,
    knownFileId: hit?.id ?? null,
  };
}

export function parseEditions(v: string | undefined): ExeEdition[] {
  if (v === undefined || v === 'all') return [...EDITIONS];
  const out = v.split(',').map((s) => s.trim());
  for (const e of out) {
    if (e !== 'v206' && e !== 'v311') throw new ExtractError('E_ARGS', `--edition 只接受 v206、v311 或 all：${e}`);
  }
  return out as ExeEdition[];
}

/**
 * 抽取指定版本；v2.06 抽取时若有 v3.11 exe，先抽 v3.11 作为 xrefTransfer 的参考。
 * 缺少请求的 exe 时抛 MISSING_INPUT。
 */
export async function extractEditions(
  ctx: ExtractContext,
  editions: readonly ExeEdition[],
): Promise<Partial<Record<ExeEdition, ExtractedTables>>> {
  const kf = await known(ctx);
  const out: Partial<Record<ExeEdition, ExtractedTables>> = {};
  const ref = await readExe(ctx, 'v311', kf);
  let refTables: ExtractedTables | null = null;
  if (ref && (editions.includes('v311') || editions.includes('v206'))) {
    refTables = extractTables(ref.bytes, { label: ref.rel, edition: 'v311', knownFileId: ref.knownFileId });
    if (editions.includes('v311')) out.v311 = refTables;
  }
  for (const ed of editions) {
    if (ed === 'v311') {
      if (!ref) throw missing(ctx, ed);
      continue;
    }
    const exe = await readExe(ctx, ed, kf);
    if (!exe) throw missing(ctx, ed);
    out[ed] = extractTables(exe.bytes, {
      label: exe.rel,
      edition: ed,
      knownFileId: exe.knownFileId,
      ref: ref && refTables ? { bytes: ref.bytes, tables: refTables } : undefined,
    });
  }
  return out;
}

function missing(ctx: ExtractContext, ed: ExeEdition): ExtractError {
  return new ExtractError(
    'E_MISSING_INPUT',
    `找不到 ${ed} 的 exe（${ctx.displayPath(path.join(ctx.srcDir, EXE_PATHS[ed]))}）`,
    ExitCode.MISSING_INPUT,
  );
}

export async function readCachedTables(ctx: ExtractContext, ed: ExeEdition): Promise<ExtractedTables | null> {
  const p = tablesCachePath(ctx, ed);
  if (!(await isFile(p))) return null;
  const j = JSON.parse(await readFile(p, 'utf8')) as ExtractedTables;
  if (j.schema !== 'rich4.exe-tables/1' || j.edition !== ed) {
    throw new ExtractError('E_TABLES_CACHE', `${ctx.displayPath(p)} 不是有效的 exe 表抽取结果，请重新运行 exe tables`);
  }
  return j;
}
