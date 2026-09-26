import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ExitCode, type ExitCodeValue } from '../context';
import type { EditionId } from '../map/rawTypes';
import { parsePe, suspiciousSections } from '../pe/pe';
import type { ScannedFile } from './scan';

const KnownFileSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['exe', 'mapdat', 'mapmkf', 'datamkf']),
  edition: z.enum(['v206', 'v311', 'unknown']),
  /** 期望的相对路径（大小写不敏感）；公开参考哈希为 null */
  path: z.string().nullable(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  sha1: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  size: z.number().int().nonnegative().nullable(),
  /** true = 公开资料里的参考哈希（非本项目 Steam 基线） */
  reference: z.boolean(),
  /** 已在用户文件上实测核实 */
  verified: z.boolean(),
  source: z.string(),
});

const KnownFilesSchema = z.object({
  schema: z.literal('rich4.known-files/1'),
  files: z.array(KnownFileSchema),
});

export type KnownFile = z.infer<typeof KnownFileSchema>;
export type KnownFiles = z.infer<typeof KnownFilesSchema>;

export async function loadKnownFiles(packageDir: string): Promise<KnownFiles> {
  const text = await readFile(path.join(packageDir, 'known-files.json'), 'utf8');
  return KnownFilesSchema.parse(JSON.parse(text));
}

export interface ExpectedFile {
  path: string;
  role: KnownFile['role'];
  required: boolean;
  note: string;
}

/** data-pipeline.md §1.2 的拷贝清单。 */
export const EXPECTED_FILES: readonly ExpectedFile[] = [
  { path: 'Game/RICH4.EXE', role: 'exe', required: true, note: 'v2.06 exe' },
  { path: 'Game/map.mkf', role: 'mapmkf', required: true, note: 'v2.06 回退地图' },
  { path: 'Game/MapDat.mkf', role: 'mapdat', required: false, note: 'v2.06 实际使用的地图结构（存在就必须拷）' },
  { path: 'MultiverseJourney/RICH4.EXE', role: 'exe', required: true, note: 'v3.11 exe' },
  { path: 'MultiverseJourney/map.mkf', role: 'mapmkf', required: true, note: 'v3.11 地图' },
  { path: 'MultiverseJourney/Data.mkf', role: 'datamkf', required: false, note: '可选：解码器自检' },
];

export interface PeSummary {
  machine: string;
  imageBase: string;
  sections: string[];
  suspicious: string[];
}

export function inspectExe(bytes: Uint8Array, label: string): PeSummary | { error: string } {
  try {
    const pe = parsePe(bytes, label);
    return {
      machine: `0x${pe.machine.toString(16)}`,
      imageBase: `0x${pe.imageBase.toString(16)}`,
      sections: pe.sections.map((s) => s.name),
      suspicious: suspiciousSections(pe),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export type FileStatus = 'known' | 'reference' | 'unknown' | 'misplaced';

export interface IdentifiedFile {
  path: string;
  size: number;
  sha256: string;
  sha1: string;
  status: FileStatus;
  knownId: string | null;
  edition: EditionId | null;
  role: KnownFile['role'] | null;
  note: string | null;
  pe: PeSummary | { error: string } | null;
}

export interface FingerprintReport {
  schema: 'rich4.fingerprint/1';
  files: IdentifiedFile[];
  /** 必需但缺失 */
  missing: string[];
  /** 可选且缺失 */
  optionalMissing: string[];
  warnings: string[];
  allowUnknown: boolean;
  exitCode: ExitCodeValue;
}

const lower = (s: string) => s.toLowerCase();

export function matchKnown(file: ScannedFile, known: KnownFiles): KnownFile | null {
  return (
    known.files.find(
      (k) => (k.sha256 !== null && k.sha256 === file.sha256) || (k.sha1 !== null && k.sha1 === file.sha1),
    ) ?? null
  );
}

export function identifyFile(file: ScannedFile, known: KnownFiles, pe: IdentifiedFile['pe'] = null): IdentifiedFile {
  const k = matchKnown(file, known);
  let status: FileStatus = 'unknown';
  let note: string | null = null;
  if (k) {
    if (k.reference) status = 'reference';
    else if (k.path !== null && lower(k.path) !== lower(file.path)) {
      status = 'misplaced';
      note = `哈希登记为 ${k.path}（${k.edition}），实际位于 ${file.path}，可能混淆了版本目录`;
    } else status = 'known';
  }
  return {
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    sha1: file.sha1,
    status,
    knownId: k?.id ?? null,
    edition: k?.edition ?? null,
    role: k?.role ?? null,
    note,
    pe,
  };
}

/** 汇总并判定退出码：缺必需文件 2 > 位置错乱 1 > 未知哈希 3（--allow-unknown 放行）> 0。 */
export function buildFingerprintReport(
  scanned: readonly ScannedFile[],
  known: KnownFiles,
  opts: { allowUnknown: boolean; pe?: Readonly<Record<string, IdentifiedFile['pe']>> },
): FingerprintReport {
  const files = scanned.map((f) => identifyFile(f, known, opts.pe?.[f.path] ?? null));
  const present = new Set(files.map((f) => lower(f.path)));
  const missing = EXPECTED_FILES.filter((e) => e.required && !present.has(lower(e.path))).map((e) => e.path);
  const optionalMissing = EXPECTED_FILES.filter((e) => !e.required && !present.has(lower(e.path))).map((e) => e.path);
  const warnings: string[] = [];
  for (const f of files) {
    if (f.status === 'unknown')
      warnings.push(`${f.path}: sha256 未登记${opts.allowUnknown ? '（已 --allow-unknown 放行）' : ''}`);
    if (f.status === 'reference') warnings.push(`${f.path}: 只匹配公开参考哈希 ${f.knownId}`);
    if (f.status === 'misplaced' && f.note) warnings.push(f.note);
    if (f.pe && 'suspicious' in f.pe && f.pe.suspicious.length > 0) {
      warnings.push(`${f.path}: 发现可疑节 ${f.pe.suspicious.join(', ')}（可能是 SteamStub 壳）`);
    }
    if (f.pe && 'error' in f.pe) warnings.push(`${f.path}: PE 解析失败：${f.pe.error}`);
  }
  let exitCode: ExitCodeValue = ExitCode.OK;
  if (missing.length > 0) exitCode = ExitCode.MISSING_INPUT;
  else if (files.some((f) => f.status === 'misplaced' || (f.pe !== null && 'error' in f.pe)))
    exitCode = ExitCode.STRUCTURE;
  else if (!opts.allowUnknown && files.some((f) => f.status === 'unknown')) exitCode = ExitCode.UNKNOWN_FINGERPRINT;
  return {
    schema: 'rich4.fingerprint/1',
    files,
    missing,
    optionalMissing,
    warnings,
    allowUnknown: opts.allowUnknown,
    exitCode,
  };
}

/** fingerprints.lock.json：只含路径与 sha256（入库）。 */
export function buildLock(report: FingerprintReport): {
  schema: 'rich4.fingerprints-lock/1';
  files: Record<string, string>;
} {
  const files: Record<string, string> = {};
  for (const f of report.files) files[f.path] = f.sha256;
  return { schema: 'rich4.fingerprints-lock/1', files };
}
