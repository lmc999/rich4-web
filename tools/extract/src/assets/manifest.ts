/**
 * 原版皮肤 A2：素材包写入器与 manifest（schema 'rich4.assets/1'，契约见 @rich4/shared/assets pack.ts）。
 *
 * - 文件名带内容哈希前 8 位（hashedPath：最后一个扩展名前插入 `.<h8>`），manifest.json 本身不带哈希；
 * - JSON 一律规范化（键按码点排序、紧凑、末尾换行），同输入同字节；
 * - .flc 与较大的 .json 另写 .br / .gz 预压缩变体（brotli q11/q9、gzip 9；只在比原文件小时保留）；
 * - 输出目录守卫见 ./outputDir：只允许已被 git 忽略的 rich4-assets/ 与 .cache/（仓库外须显式 allowOutsideRepo，
 *   且不得落在其他 git 工作树的未忽略路径），拒绝任何位置的 apps/*\/public/**；
 * - 构建成功写出 manifest 后，删除受管子目录里不再被引用的旧产物（只删带哈希命名的文件，且只在带归属标记的目录里删）。
 */
import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import {
  type AssetEntry,
  type ContentType,
  contentTypeForPath,
  type FileKind,
  hashedPath,
  type PackFile,
  type PackGroup,
  type PackManifestV1,
  type PackMap,
  type Provenance,
  parsePackManifest,
  withPackId,
} from '@rich4/shared/assets';
import { type ExtractContext, ExtractError } from '../context';
import { sha256Hex } from '../io/hash';
import { canonicalize, safeWriteFile } from '../io/writeCanonicalJson';
import { categoryOfGroup } from './catalog.v206';
import { assertOwnedOutputDir, type OutputDirOptions, resolveOutputDir } from './outputDir';

/** 生成器标识（manifest.generator） */
export const PACK_GENERATOR = 'rich4-extract/assets@1';
/** 默认输出目录（相对仓库根；已被 .gitignore / .dockerignore 忽略） */
export const DEFAULT_PACK_DIR = 'rich4-assets';
export const MANIFEST_FILE = 'manifest.json';
/** 受管的顶层子目录：prune 只在这些目录里删除旧产物 */
export const MANAGED_DIRS: readonly string[] = [
  'audio',
  'data',
  'flic',
  'ground',
  'images',
  'maps',
  'masks',
  'sprites',
  'video',
];
/** JSON 超过这个字节数时写预压缩变体 */
export const PRECOMPRESS_JSON_MIN = 1024;

const HASHED_NAME_RE = /\.[0-9a-f]{8}\.[A-Za-z0-9]+(?:\.(?:br|gz))?$/;

/** 规范化紧凑 JSON（键按码点排序，末尾换行） */
export function compactJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

export function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(compactJson(value));
}

/**
 * 素材包输出目录守卫（审查修正 5）：与 A3 等所有派生物共用 ./outputDir 的 resolveOutputDir
 * （只读守卫、拒绝 apps/*\/public/**、仓库内必须已被 git 忽略且位于 rich4-assets/ 或 .cache/ 下、仓库外须显式放行）。
 */
export function resolvePackOutputDir(ctx: ExtractContext, dir: string, opts: OutputDirOptions = {}): string {
  return resolveOutputDir(ctx, dir, opts);
}

/** brotli 档位：1 MiB 以内用 q11；更大的（整屏 FLC）用 q9 + 16 MiB 窗口（q11 慢 25 倍、只小约 10%） */
export const BROTLI_Q11_MAX = 1 << 20;

function precompress(bytes: Uint8Array): { br: Uint8Array; gz: Uint8Array } {
  const small = bytes.length <= BROTLI_Q11_MAX;
  const br = new Uint8Array(
    brotliCompressSync(bytes, {
      params: {
        [zc.BROTLI_PARAM_QUALITY]: small ? 11 : 9,
        [zc.BROTLI_PARAM_LGWIN]: small ? 22 : 24,
        [zc.BROTLI_PARAM_MODE]: zc.BROTLI_MODE_GENERIC,
        [zc.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }),
  );
  const gz = new Uint8Array(gzipSync(bytes, { level: 9 }));
  return { br, gz };
}

export interface WriteFileOptions {
  /** 写 .br / .gz 预压缩变体（默认：.flc 总是写，.json 超过阈值时写） */
  precompress?: boolean;
}

interface GroupState {
  category: PackGroup['category'];
  provenance: Provenance;
  files: Set<string>;
}

export interface ManifestMeta {
  edition: PackManifestV1['edition'];
  source: PackManifestV1['source'];
  tools: PackManifestV1['tools'];
  features: PackManifestV1['features'];
  generator?: string;
}

/** 收集文件、分组、条目与地图，最后写出 manifest。所有写入都经 ExtractContext 的只读守卫。 */
export class PackWriter {
  private readonly files = new Map<string, PackFile>();
  private readonly groups = new Map<string, GroupState>();
  private readonly entries = new Map<string, AssetEntry>();
  private readonly maps = new Map<string, PackMap>();

  constructor(
    readonly ctx: ExtractContext,
    readonly outDir: string,
    readonly provenance: Provenance,
  ) {}

  /** 确保分组存在（类别由分组名推出） */
  group(name: string): void {
    if (!this.groups.has(name)) {
      this.groups.set(name, { category: categoryOfGroup(name), provenance: this.provenance, files: new Set() });
    }
  }

  private register(logical: string, file: PackFile, group: string): PackFile {
    const prev = this.files.get(logical);
    if (prev && prev.sha256 !== file.sha256) {
      throw new ExtractError('E_PACK_DUP_FILE', `逻辑路径 ${logical} 被写入了两份不同内容`);
    }
    this.files.set(logical, prev ?? file);
    this.group(group);
    this.groups.get(group)!.files.add(logical);
    return prev ?? file;
  }

  private contentType(p: string): ContentType {
    const ct = contentTypeForPath(p);
    if (ct === null) throw new ExtractError('E_PACK_EXT', `扩展名不在白名单内：${p}`);
    return ct;
  }

  /** 写一个文件（带哈希名）并登记到分组；同一逻辑路径重复写入相同内容时只算一次 */
  async writeFile(
    logical: string,
    bytes: Uint8Array,
    kind: FileKind,
    group: string,
    opts: WriteFileOptions = {},
  ): Promise<PackFile> {
    const sha = sha256Hex(bytes);
    const rel = hashedPath(logical, sha);
    const file: PackFile = { path: rel, bytes: bytes.length, sha256: sha, kind, contentType: this.contentType(rel) };
    const ext = path.extname(logical).toLowerCase();
    const wantVariants =
      opts.precompress ?? (ext === '.flc' || (ext === '.json' && bytes.length >= PRECOMPRESS_JSON_MIN));
    await safeWriteFile(this.ctx, path.join(this.outDir, ...rel.split('/')), bytes);
    if (wantVariants) {
      const { br, gz } = precompress(bytes);
      const variants: NonNullable<PackFile['variants']> = {};
      if (br.length < bytes.length) {
        await safeWriteFile(this.ctx, path.join(this.outDir, ...`${rel}.br`.split('/')), br);
        variants.br = { bytes: br.length, sha256: sha256Hex(br) };
      }
      if (gz.length < bytes.length) {
        await safeWriteFile(this.ctx, path.join(this.outDir, ...`${rel}.gz`.split('/')), gz);
        variants.gzip = { bytes: gz.length, sha256: sha256Hex(gz) };
      }
      if (variants.br || variants.gzip) file.variants = variants;
    }
    return this.register(logical, file, group);
  }

  async writeJson(logical: string, value: unknown, kind: FileKind, group: string): Promise<PackFile> {
    return this.writeFile(logical, jsonBytes(value), kind, group);
  }

  /** 登记一个已由其他模块写好的文件（A3 音视频）；path 必须等于 hashedPath(logical, sha256) */
  adoptFile(
    logical: string,
    written: { path: string; sha256: string; bytes: number },
    kind: FileKind,
    group: string,
  ): PackFile {
    const expected = hashedPath(logical, written.sha256);
    if (written.path !== expected) {
      throw new ExtractError('E_PACK_ADOPT', `${logical}: 实际路径 ${written.path} ≠ ${expected}`);
    }
    return this.register(
      logical,
      {
        path: written.path,
        bytes: written.bytes,
        sha256: written.sha256,
        kind,
        contentType: this.contentType(written.path),
      },
      group,
    );
  }

  hasFile(logical: string): boolean {
    return this.files.has(logical);
  }

  hasEntry(key: string): boolean {
    return this.entries.has(key);
  }

  entry(key: string): AssetEntry | undefined {
    return this.entries.get(key);
  }

  addEntry(key: string, entry: AssetEntry): void {
    if (this.entries.has(key)) throw new ExtractError('E_PACK_DUP_ENTRY', `条目 ${key} 重复`);
    this.group(entry.group);
    this.entries.set(key, entry);
  }

  addMap(mapId: string, m: PackMap): void {
    if (this.maps.has(mapId)) throw new ExtractError('E_PACK_DUP_MAP', `地图 ${mapId} 重复`);
    this.maps.set(mapId, m);
  }

  /** 组装并校验 manifest（结构 + 一致性；失败抛 AssetContractError） */
  manifest(meta: ManifestMeta): PackManifestV1 {
    const byCp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const groups: Record<string, PackGroup> = {};
    for (const name of [...this.groups.keys()].sort(byCp)) {
      const g = this.groups.get(name)!;
      const files = [...g.files].sort(byCp);
      if (files.length === 0 && ![...this.entries.values()].some((e) => e.group === name)) continue;
      groups[name] = {
        category: g.category,
        provenance: g.provenance,
        files,
        bytes: files.reduce((s, lp) => s + this.files.get(lp)!.bytes, 0),
      };
    }
    const files: Record<string, PackFile> = {};
    for (const lp of [...this.files.keys()].sort(byCp)) files[lp] = this.files.get(lp)!;
    const entries: Record<string, AssetEntry> = {};
    for (const k of [...this.entries.keys()].sort(byCp)) entries[k] = this.entries.get(k)!;
    const maps: Record<string, PackMap> = {};
    for (const k of [...this.maps.keys()].sort(byCp)) maps[k] = this.maps.get(k)!;
    const draft: Omit<PackManifestV1, 'packId'> = {
      schema: 'rich4.assets/1',
      generator: meta.generator ?? PACK_GENERATOR,
      edition: meta.edition,
      license: 'private-personal-use',
      source: meta.source,
      tools: meta.tools,
      features: meta.features,
      groups,
      files,
      entries,
      maps,
    };
    return parsePackManifest(withPackId(draft));
  }

  /** 写 manifest.json（不带哈希），返回绝对路径与内容 sha256 */
  async writeManifest(m: PackManifestV1): Promise<{ file: string; sha256: string; bytes: number }> {
    const bytes = jsonBytes(m);
    const file = await safeWriteFile(this.ctx, path.join(this.outDir, MANIFEST_FILE), bytes);
    return { file, sha256: sha256Hex(bytes), bytes: bytes.length };
  }
}

/** manifest 引用的全部实际路径（含预压缩变体） */
export function referencedPaths(m: PackManifestV1): Set<string> {
  const keep = new Set<string>();
  for (const f of Object.values(m.files)) {
    keep.add(f.path);
    if (f.variants?.br) keep.add(`${f.path}.br`);
    if (f.variants?.gzip) keep.add(`${f.path}.gz`);
  }
  return keep;
}

async function walkFiles(dir: string, rel: string, out: string[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names.sort()) {
    const abs = path.join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    const st = await stat(abs);
    if (st.isDirectory()) await walkFiles(abs, r, out);
    else if (st.isFile()) out.push(r);
  }
}

/** 受管子目录下的全部文件（相对 outDir 的 posix 路径，升序） */
export async function listPackFiles(outDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of MANAGED_DIRS) await walkFiles(path.join(outDir, d), d, out);
  return out.sort();
}

/** 删除受管子目录里未被 manifest 引用、且符合带哈希命名规则的文件；随后删除空目录。返回删掉的相对路径。
 * 目录必须带 rich4-extract 的归属标记（claimOutputDir 认领过），否则抛 E_ASSETS_OUT_NOT_OWNED */
export async function pruneStalePack(ctx: ExtractContext, outDir: string, m: PackManifestV1): Promise<string[]> {
  assertOwnedOutputDir(ctx, outDir);
  const keep = referencedPaths(m);
  const removed: string[] = [];
  for (const rel of await listPackFiles(outDir)) {
    if (keep.has(rel) || !HASHED_NAME_RE.test(rel)) continue;
    const abs = ctx.assertWritable(path.join(outDir, ...rel.split('/')));
    await rm(abs, { force: true });
    removed.push(rel);
  }
  const dropEmpty = async (dir: string): Promise<boolean> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return false;
    }
    let empty = true;
    for (const n of names) {
      const abs = path.join(dir, n);
      if ((await stat(abs)).isDirectory()) {
        if (!(await dropEmpty(abs))) empty = false;
      } else empty = false;
    }
    if (empty) {
      await rmdir(ctx.assertWritable(dir));
      return true;
    }
    return false;
  };
  for (const d of MANAGED_DIRS) await dropEmpty(path.join(outDir, d));
  return removed;
}
