/**
 * 原版皮肤素材包的只读注册表（docs/design/original-skin.md §2、§3 修正 4；design-draft §5.1–5.2）。
 *
 * - RICH4_ASSETS_DIR 里有**合法**的 manifest.json（safeParsePackManifest 通过）才启用；否则 disabled，/pack/* 一律 404 JSON。
 * - 白名单：只提供 packServablePaths(manifest)（带哈希的实际路径与 .br/.gz 预压缩变体）与 manifest.json 本身。
 * - 校验：quick 检查每个文件是普通文件（不跟随符号链接）且字节数一致；full 另外逐个复算 sha256。
 *   任何一处不符都不启用整个素材包（前端回退程序化美术），并在日志里列出前几处问题。
 * - manifest 在内存里保存原文与 br/gzip 压缩版（ETag = packId）；其余文件按请求从磁盘流式读取。
 * - 服务器不解码任何素材，也不需要 ffmpeg。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants as zc } from 'node:zlib';
import {
  type ContentType,
  type FileKind,
  type PackManifestV1,
  safeParsePackManifest,
  sortedKeys,
} from '@rich4/shared/assets';
import type { Logger } from '../infra/logger';

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export type PackVerifyMode = 'quick' | 'full';

export interface PackVariant {
  abs: string;
  bytes: number;
  sha256: string;
}

/** 一个可提供的路径（相对 /pack/） */
export interface PackServed {
  path: string;
  abs: string;
  bytes: number;
  sha256: string;
  contentType: string;
  /** manifest 里的文件种类；直接请求预压缩变体本身时为 null */
  kind: FileKind | null;
  /** 可按 Accept-Encoding 协商的预压缩变体 */
  variants: { br?: PackVariant; gzip?: PackVariant };
  /** 强 ETag（带引号） */
  etag: string;
}

export interface PackManifestBody {
  raw: Buffer;
  br: Buffer;
  gzip: Buffer;
  etag: string;
}

export interface PackRegistry {
  readonly enabled: boolean;
  /** 配置的目录（未配置为 null） */
  readonly dir: string | null;
  readonly packId: string | null;
  /** 未启用的原因（未配置、没有 manifest、校验失败） */
  readonly reason: string | null;
  readonly manifest: PackManifestBody | null;
  /** 白名单查找（路径相对 /pack/，不含前导斜杠）；manifest.json 不在这里 */
  lookup(path: string): PackServed | null;
  readonly stats: { files: number; bytes: number };
}

export const PACK_MANIFEST_NAME = 'manifest.json';
/** 单个 manifest 的大小上限（真实包约 1.6 MB） */
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
const PROBLEMS_SHOWN = 5;

export function disabledPack(dir: string | null, reason: string): PackRegistry {
  return {
    enabled: false,
    dir,
    packId: null,
    reason,
    manifest: null,
    lookup: () => null,
    stats: { files: 0, bytes: 0 },
  };
}

async function sha256File(abs: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** 限制并发地对每个元素执行 fn */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < items.length) await fn(items[i++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

interface Check {
  path: string;
  abs: string;
  bytes: number;
  sha256: string;
}

function buildIndex(root: string, m: PackManifestV1): { index: Map<string, PackServed>; checks: Check[] } {
  const index = new Map<string, PackServed>();
  const checks: Check[] = [];
  for (const lp of sortedKeys(m.files)) {
    const f = m.files[lp]!;
    const abs = join(root, ...f.path.split('/'));
    const variants: PackServed['variants'] = {};
    checks.push({ path: f.path, abs, bytes: f.bytes, sha256: f.sha256 });
    for (const enc of ['br', 'gzip'] as const) {
      const v = f.variants?.[enc];
      if (!v) continue;
      const vp = `${f.path}.${enc === 'br' ? 'br' : 'gz'}`;
      const vabs = join(root, ...vp.split('/'));
      variants[enc] = { abs: vabs, bytes: v.bytes, sha256: v.sha256 };
      checks.push({ path: vp, abs: vabs, bytes: v.bytes, sha256: v.sha256 });
      // 直接请求变体本身：按不透明字节提供，不协商
      index.set(vp, {
        path: vp,
        abs: vabs,
        bytes: v.bytes,
        sha256: v.sha256,
        contentType: 'application/octet-stream',
        kind: null,
        variants: {},
        etag: `"${v.sha256.slice(0, 32)}"`,
      });
    }
    index.set(f.path, {
      path: f.path,
      abs,
      bytes: f.bytes,
      sha256: f.sha256,
      contentType: contentTypeHeader(f.contentType),
      kind: f.kind,
      variants,
      etag: `"${f.sha256.slice(0, 32)}"`,
    });
  }
  return { index, checks };
}

function contentTypeHeader(ct: ContentType): string {
  return ct === 'application/json' ? 'application/json; charset=utf-8' : ct;
}

export interface LoadPackOptions {
  dir: string | null;
  verify?: PackVerifyMode;
  log: Logger;
}

/** 读取并校验素材包；任何问题都返回 disabled（不抛异常） */
export async function loadPackRegistry(o: LoadPackOptions): Promise<PackRegistry> {
  const { log } = o;
  if (!o.dir) return disabledPack(null, 'RICH4_ASSETS_DIR 未设置');
  const t0 = Date.now();
  let root: string;
  try {
    root = await realpath(resolve(o.dir));
  } catch {
    log.warn({ dir: o.dir }, 'asset pack: directory not found; original skin disabled');
    return disabledPack(o.dir, '目录不存在');
  }
  const manifestAbs = join(root, PACK_MANIFEST_NAME);
  let raw: Buffer;
  try {
    const st = await lstat(manifestAbs);
    if (!st.isFile()) throw new Error('manifest.json 不是普通文件');
    if (st.size > MANIFEST_MAX_BYTES) throw new Error(`manifest.json 超过 ${MANIFEST_MAX_BYTES} 字节`);
    raw = await readFile(manifestAbs);
  } catch (err) {
    log.warn({ dir: root, err: String(err) }, 'asset pack: no readable manifest.json; original skin disabled');
    return disabledPack(root, '没有可读的 manifest.json');
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    log.error({ dir: root }, 'asset pack: manifest.json is not valid JSON; original skin disabled');
    return disabledPack(root, 'manifest.json 不是合法 JSON');
  }
  const parsed = safeParsePackManifest(json);
  if (!parsed.ok) {
    log.error(
      { dir: root, issues: parsed.issues.slice(0, PROBLEMS_SHOWN), total: parsed.issues.length },
      'asset pack: manifest.json failed contract validation; original skin disabled',
    );
    return disabledPack(root, 'manifest.json 未通过契约校验');
  }
  const m = parsed.value;
  const { index, checks } = buildIndex(root, m);

  const problems: string[] = [];
  const verify = o.verify ?? 'quick';
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  await eachLimited(checks, 16, async (c) => {
    try {
      const st = await lstat(c.abs);
      if (!st.isFile()) problems.push(`${c.path}: 不是普通文件`);
      else if (st.size !== c.bytes) problems.push(`${c.path}: 字节数 ${st.size} ≠ ${c.bytes}`);
      // 中间目录是指向包外的符号链接时拒绝（lstat 只看最后一段）
      else if (!(await realpath(c.abs)).startsWith(rootPrefix)) problems.push(`${c.path}: 位于素材包目录之外`);
      else if (verify === 'full' && (await sha256File(c.abs)) !== c.sha256) problems.push(`${c.path}: sha256 不符`);
    } catch {
      problems.push(`${c.path}: 缺失`);
    }
  });
  if (problems.length > 0) {
    problems.sort();
    log.error(
      { dir: root, verify, problems: problems.slice(0, PROBLEMS_SHOWN), total: problems.length },
      'asset pack: files do not match manifest (run `npm run extract -- assets verify`); original skin disabled',
    );
    return disabledPack(root, `${problems.length} 个文件与 manifest 不符`);
  }

  const [br, gz] = await Promise.all([
    brotliAsync(raw, {
      params: {
        [zc.BROTLI_PARAM_MODE]: zc.BROTLI_MODE_TEXT,
        [zc.BROTLI_PARAM_QUALITY]: 11,
        [zc.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }),
    gzipAsync(raw, { level: 9 }),
  ]);
  let bytes = 0;
  for (const lp of sortedKeys(m.files)) bytes += m.files[lp]!.bytes;
  const stats = { files: index.size, bytes };
  log.info(
    { dir: root, packId: m.packId, edition: m.edition, files: stats.files, bytes, verify, ms: Date.now() - t0 },
    'asset pack enabled',
  );
  return {
    enabled: true,
    dir: root,
    packId: m.packId,
    reason: null,
    manifest: { raw, br, gzip: gz, etag: `"${m.packId}"` },
    lookup(path: string): PackServed | null {
      const hit = index.get(path) ?? null;
      // 白名单之外的双保险：绝对路径必须落在包目录内
      return hit?.abs.startsWith(rootPrefix) ? hit : null;
    },
    stats,
  };
}
