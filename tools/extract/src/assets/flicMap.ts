/**
 * 原版皮肤 A3：FLIC 映射表（Data / Panel / jump 的 FLIC → 用途、尺寸、帧数、原版时长、同步音效、置信度）。
 * 供 A8 生成 original 节奏预算（durationMs = frames × frameMs），也供 AudioEngine 在 FLIC 首帧播放同步音效。
 *
 * - loadFlicMap()：纯数据（data/flic.ts），不读原版文件。
 * - verifyFlicMap()：按本机 MKF 逐项核对 FLC 头（magic、宽高、帧数、帧间隔），并列出未收录的 FLIC 资源。
 *   压缩资源只解出头部（lzhufDecompress 的 limit）。
 * - buildFlicMap()：写 data/flic-map.<h8>.json（默认先 verify，不符则抛错）。
 */
import path from 'node:path';
import { ExitCode, ExtractContext, ExtractError, type Logger } from '../context';
import { sha256Hex } from '../io/hash';
import { findCaseInsensitive, readFileRO } from '../io/readOnly';
import { MKF_ENTRY_HEADER_SIZE, MkfArchive } from '../mkf/container';
import { lzhufDecompress } from '../mkf/lzhuf';
import { type BuiltFile, DEFAULT_STAGING_DIR, pruneStale, type SourceRecord, writeJsonFile } from './audio';
import { FLIC_COUNTS, FLIC_DEFS, FLIC_MKFS, type FlicDef, type FlicMkf } from './data/flic';
import { claimOutputDir, resolveOutputDir } from './outputDir';

export const FLC_MAGIC = 0xaf12;
/** FLC 头里用到的字段都在前 20 字节内 */
const FLC_HEAD_BYTES = 20;

export interface FlicMapEntry extends FlicDef {
  /** 'Data#499' 形式的资源键 */
  key: string;
  /** 原版时长（ms）= frames × frameMs */
  durationMs: number;
}

export interface FlicMapJson {
  schema: 'rich4.flic-map/1';
  edition: 'v206';
  /** 透明色键：调色板索引 0（opaque 的三段除外） */
  transparentIndex: 0;
  /** 素材包内 FLC 文件的逻辑键模板（A2 输出 flic/<mkf>/<res>.<h8>.flc） */
  keyPattern: 'flic/{mkf}/{res}.flc';
  counts: Record<FlicMkf, number>;
  entries: FlicMapEntry[];
}

const MKF_FILES: Readonly<Record<FlicMkf, string>> = {
  Data: 'Game/Data.mkf',
  Panel: 'Game/Panel.mkf',
  jump: 'Game/jump.mkf',
};

export function flicKey(mkf: FlicMkf, res: number): string {
  return `${mkf}#${res}`;
}

/** 静态 FLIC 映射表（按 mkf、资源号排序） */
export function loadFlicMap(): FlicMapJson {
  const order = (m: FlicMkf) => FLIC_MKFS.indexOf(m);
  const entries = FLIC_DEFS.map((d) => ({ ...d, key: flicKey(d.mkf, d.res), durationMs: d.frames * d.frameMs })).sort(
    (a, b) => order(a.mkf) - order(b.mkf) || a.res - b.res,
  );
  return {
    schema: 'rich4.flic-map/1',
    edition: 'v206',
    transparentIndex: 0,
    keyPattern: 'flic/{mkf}/{res}.flc',
    counts: { ...FLIC_COUNTS },
    entries,
  };
}

/** 按资源查表；没有收录返回 undefined */
export function findFlic(map: FlicMapJson, mkf: FlicMkf, res: number): FlicMapEntry | undefined {
  return map.entries.find((e) => e.mkf === mkf && e.res === res);
}

/** 结构检查：键唯一、数量与调研一致、时长为正、按角色 / 神明的组齐全。返回问题列表 */
export function validateFlicMap(map: FlicMapJson): string[] {
  const issues: string[] = [];
  const keys = new Set<string>();
  for (const e of map.entries) {
    if (keys.has(e.key)) issues.push(`重复：${e.key}`);
    keys.add(e.key);
    if (!(e.w > 0 && e.h > 0 && e.frames > 0 && e.frameMs > 0)) issues.push(`${e.key}: 尺寸 / 帧数 / 帧间隔非法`);
    if (e.durationMs !== e.frames * e.frameMs) issues.push(`${e.key}: durationMs 不等于 frames × frameMs`);
    if (e.sfx !== null && (e.sfx < 0 || e.sfx > 114 || (e.sfx >= 64 && e.sfx <= 79)))
      issues.push(`${e.key}: 音效号 ${e.sfx} 非法`);
  }
  for (const m of FLIC_MKFS) {
    const n = map.entries.filter((e) => e.mkf === m).length;
    if (n !== map.counts[m]) issues.push(`${m}: 收录 ${n} 段，调研实测 ${map.counts[m]} 段`);
  }
  for (const use of ['char.emoteA', 'char.emoteB', 'char.parachuteBoard', 'char.freefall', 'char.parachuteOpen']) {
    const chars = map.entries
      .filter((e) => e.use === use)
      .map((e) => e.char)
      .sort((a, b) => (a ?? -1) - (b ?? -1));
    if (chars.join(',') !== Array.from({ length: 12 }, (_, i) => i).join(',')) issues.push(`${use}: 12 名角色不齐`);
  }
  const gods = map.entries.filter((e) => e.use === 'god.arrive').map((e) => e.god);
  if (gods.length !== 12 || new Set(gods).size !== 12) issues.push('god.arrive: 应有 12 位附身神明');
  return issues;
}

// ───────────────────────── 按本机文件核对 ─────────────────────────

export interface FlcHeader {
  size: number;
  magic: number;
  frames: number;
  w: number;
  h: number;
  depth: number;
  frameMs: number;
}

export function parseFlcHeader(b: Uint8Array): FlcHeader | null {
  if (b.length < FLC_HEAD_BYTES) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    size: dv.getUint32(0, true),
    magic: dv.getUint16(4, true),
    frames: dv.getUint16(6, true),
    w: dv.getUint16(8, true),
    h: dv.getUint16(10, true),
    depth: dv.getUint16(12, true),
    frameMs: dv.getUint32(16, true),
  };
}

export interface FlicVerifyIssue {
  key: string;
  field: string;
  expected: number | string;
  actual: number | string;
}

export interface FlicVerifyReport {
  checked: number;
  issues: FlicVerifyIssue[];
  /** 源文件里是 FLC、但映射表没收录的资源 */
  unlisted: string[];
  sources: SourceRecord[];
}

/** 资源体的前 n 字节（压缩资源只解出这么多） */
function headOf(bytes: Uint8Array, archive: MkfArchive, i: number, n: number): Uint8Array {
  const e = archive.entry(i);
  const start = e.offset + MKF_ENTRY_HEADER_SIZE;
  const stored = bytes.subarray(start, start + e.storedSize);
  if (!e.compressed) return stored.subarray(0, Math.min(n, stored.length));
  return lzhufDecompress(stored, e.rawSize, { limit: Math.min(n, e.rawSize) });
}

export async function verifyFlicMap(opts: { ctx?: ExtractContext; srcDir?: string } = {}): Promise<FlicVerifyReport> {
  const ctx = opts.ctx ?? new ExtractContext();
  const srcDir = opts.srcDir ? path.resolve(ctx.root, opts.srcDir) : ctx.srcDir;
  const map = loadFlicMap();
  const issues: FlicVerifyIssue[] = [];
  const unlisted: string[] = [];
  const sources: SourceRecord[] = [];
  let checked = 0;
  for (const mkf of FLIC_MKFS) {
    const rel = MKF_FILES[mkf];
    const file = await findCaseInsensitive(srcDir, rel);
    if (!file) throw new ExtractError('E_ASSETS_SOURCE_MISSING', `缺少原版文件：${rel}`, ExitCode.MISSING_INPUT);
    const bytes = await readFileRO(file);
    sources.push({ file: rel, sha256: sha256Hex(bytes), bytes: bytes.length });
    const archive = MkfArchive.open(bytes, rel);
    const listed = new Set(map.entries.filter((e) => e.mkf === mkf).map((e) => e.res));
    for (const e of archive.entries()) {
      if (e.rawSize < FLC_HEAD_BYTES) continue;
      const h = parseFlcHeader(headOf(bytes, archive, e.index, FLC_HEAD_BYTES));
      if (h?.magic === FLC_MAGIC && !listed.has(e.index)) unlisted.push(flicKey(mkf, e.index));
    }
    for (const d of map.entries.filter((x) => x.mkf === mkf)) {
      checked++;
      if (d.res >= archive.count) {
        issues.push({ key: d.key, field: 'res', expected: `< ${archive.count}`, actual: d.res });
        continue;
      }
      const e = archive.entry(d.res);
      const h = parseFlcHeader(headOf(bytes, archive, d.res, FLC_HEAD_BYTES));
      if (!h || h.magic !== FLC_MAGIC) {
        issues.push({ key: d.key, field: 'magic', expected: FLC_MAGIC, actual: h?.magic ?? 'none' });
        continue;
      }
      const cmp: [string, number, number][] = [
        ['w', d.w, h.w],
        ['h', d.h, h.h],
        ['frames', d.frames, h.frames],
        ['frameMs', d.frameMs, h.frameMs],
        ['depth', 8, h.depth],
        ['size', e.rawSize, h.size],
      ];
      for (const [field, expected, actual] of cmp)
        if (expected !== actual) issues.push({ key: d.key, field, expected, actual });
    }
  }
  return { checked, issues, unlisted, sources };
}

export interface FlicMapBuildOptions {
  ctx?: ExtractContext;
  srcDir?: string;
  /** 默认 <root>/.cache/assets-staging（守卫见 ./outputDir） */
  outDir?: string;
  /** 允许输出到仓库外；默认 false */
  allowOutsideRepo?: boolean;
  /** 默认 true：先按本机文件核对，不符抛 E_FLIC_MAP_MISMATCH */
  verify?: boolean;
  prune?: boolean;
  log?: Logger;
}

export interface FlicMapBuildResult {
  outDir: string;
  files: BuiltFile[];
  map: FlicMapJson;
  verify: FlicVerifyReport | null;
}

export async function buildFlicMap(opts: FlicMapBuildOptions = {}): Promise<FlicMapBuildResult> {
  const ctx = opts.ctx ?? new ExtractContext();
  const log = opts.log ?? ctx.log;
  const outDir = resolveOutputDir(ctx, opts.outDir ?? DEFAULT_STAGING_DIR, {
    allowOutsideRepo: opts.allowOutsideRepo === true,
  });
  const map = loadFlicMap();
  const problems = validateFlicMap(map);
  if (problems.length > 0) throw new ExtractError('E_FLIC_MAP', problems.join('；'));
  let verify: FlicVerifyReport | null = null;
  if (opts.verify ?? true) {
    verify = await verifyFlicMap({ ctx, ...(opts.srcDir ? { srcDir: opts.srcDir } : {}) });
    if (verify.issues.length > 0) {
      const head = verify.issues
        .slice(0, 8)
        .map((i) => `${i.key}.${i.field}: 表 ${i.expected} / 源 ${i.actual}`)
        .join('；');
      throw new ExtractError('E_FLIC_MAP_MISMATCH', `FLIC 映射表与本机文件不符（${verify.issues.length} 处）：${head}`);
    }
    if (verify.unlisted.length > 0) log.err(`警告：未收录的 FLIC：${verify.unlisted.join(', ')}`);
  }
  await claimOutputDir(ctx, outDir);
  const file = await writeJsonFile(ctx, outDir, 'data/flic-map.json', map);
  if (opts.prune ?? true) await pruneStale(ctx, outDir, 'data', /^flic-map\.[0-9a-f]{8}\.json$/, new Set([file.path]));
  log.out(`FLIC 映射表：${map.entries.length} 段 → ${file.path}`);
  return { outDir, files: [file], map, verify };
}
