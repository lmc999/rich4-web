// 原版文件扫描：任意目录或 tar 包（M11；docs/architecture.md §9.3、docs/design/original-skin.md §3 修正 5）。
// deploy/scan-image.sh 用它逐层扫描镜像（docker save 的每一层 tar），deploy/Dockerfile 用它检查构建上下文与构建产物。
// 规则与仓库守卫 check-no-original.ts 是同一套（直接调用那里的纯函数，不另抄一份）：
//   - 路径：checkPath（*.mkf、RICH4.EXE、SAVE*.DAT、*.avi、*.mid、*.flc/*.fli 及其 .br/.gz 变体、*.map.json、rich4-data/ 等）；
//   - 内容：checkContent（MKF / PE / FLIC / SPR 魔数、tEXt rich4:derived 的 PNG、元数据带 RICH4_DERIVED 的音视频（不分大小写）、
//     全部素材包 schema（含 rich4.video-map 这类带连字符的 id）、gzip / brotli 预压缩变体解压后再判）；
//   - sha256 禁单：公开的原版指纹、tools/extract 的指纹文件、本机素材包 manifest 里的全部哈希，外加 --banned-dir 目录里
//     每个文件的哈希（本机有 original/ 时 scan-image.sh 把它传进来：原版 track*.ogg、*.wav 改了名也认得出）。
// 镜像与构建产物（--profile image / artifact）另加路径规则：任何一级目录名为 original / rich4-data / rich4-assets、
// 素材包生成标记 .rich4-extract.json、素材包的文件命名（<名字>.<8 位十六进制>.<扩展名>[.br|.gz]）、一切音视频文件
// （镜像里本来就不该有：前端的声音与美术都是程序化生成的）。压缩包：tar（含 .tar.gz / .tar.br）与 zip 展开后逐条目
// 按同样规则再查；xz、bzip2、zstd、7z、rar 之类展不开的压缩包在 artifact 档直接判命中，image 档只在 app/ 下判命中
// （镜像的基础层里有 apt 日志之类的 .xz），其余位置告警。
//
// 只用 Node 内置模块与可擦除的 TS 语法：node:24-slim 里直接 `node scripts/scan-tree.ts …` 运行（Node 自带类型剥离），
// 不需要 npm 依赖——服务器上没有 Node 时，scan-image.sh 在官方 node:24-slim 容器里跑它。
//
// 用法：node scripts/scan-tree.ts [--profile repo|artifact|image] [--skip-dir <目录名>]... [--banned-json <文件>]...
//        [--banned-dir <目录>]... [--root <仓库根>] [--paths-stdin] <目录或 tar 文件>...
//   repo      路径按仓库根解释（与 check-no-original 完全一致：fixtures 下的 *.map.json 放行，original/、.cache/ 只看顶层）
//   artifact  在 repo 之上加镜像与构建产物的规则（缺省）：Dockerfile 用它查构建上下文与构建产物
//   image     docker save 解出的层 tar（路径形如 app/public/…；overlay 删除标记 .wh.<名字> 按原名判定）
//   --paths-stdin 从标准输入读路径清单（每行一个，只按路径规则判定；scan-image.sh 用来查容器里 find 的输出）
// 退出码：0 干净；1 有命中；2 用法或读取错误。
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, inflateRawSync, constants as zc } from 'node:zlib';
import {
  type CheckOptions,
  type ContentProbe,
  checkContent,
  checkPath,
  compressionKind,
  contentWarnings,
  inflateVariant,
  loadBannedHashes,
  probeFromBytes,
} from './check-no-original.ts';
import { isMainModule, REPO_ROOT } from './lib/cli.ts';

export type Profile = 'repo' | 'artifact' | 'image';

export interface TreeEntry {
  path: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  /** 符号链接的目标（原样） */
  linkTarget?: string;
  content: ContentProbe | null;
}

export interface Finding {
  path: string;
  reason: string;
}

export interface ScanOutcome {
  entries: number;
  hits: Finding[];
  warnings: Finding[];
}

export interface TreeScanOptions {
  profile: Profile;
  bannedHashes?: ReadonlySet<string>;
}

/** 这些目录名出现在任何层级都算命中（镜像与构建产物里） */
const PROTECTED_DIR_NAMES = new Set(['original', 'rich4-data', 'rich4-assets']);
/** 素材包生成标记（tools/extract assets build 写在素材包根目录） */
const EXTRACT_MARKER = '.rich4-extract.json';
/** 素材包的文件命名：<名字>.<8 位十六进制内容哈希>.<扩展名>，预压缩变体再加 .br / .gz */
const PACK_FILE_RE = /\.[0-9a-f]{8}\.(?:png|webp|json|opus|ogg|oga|m4a|mp3|mp4|webm|wav|flc|fli)(?:\.(?:br|gz))?$/;
/** 音视频与 MIDI（镜像里不该有任何这类文件：前端的声音与美术都是程序化生成的） */
const MEDIA_RE = /\.(?:opus|ogg|oga|m4a|mp3|mp4|m4v|webm|wav|flac|aac|avi|mov|mkv|mid|midi|flc|fli)(?:\.(?:br|gz))?$/;
/** 压缩包展开检查的最大嵌套深度 */
const ARCHIVE_MAX_DEPTH = 2;
/** zip 条目解压后最多检查的字节数 */
const ZIP_INFLATE_LIMIT = 64 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 100_000;

const lower = (s: string): string => s.toLowerCase();
const latin1 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');

/** 规整路径：posix 分隔、去掉开头的 ./ 与 /、末尾的 / */
export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/|\/)+/, '')
    .replace(/\/+$/, '');
}

/** 镜像与构建产物的额外路径规则（checkPath 之外） */
export function artifactPathReasons(path: string): string[] {
  const reasons: string[] = [];
  const segs = path.split('/');
  const base = lower(segs[segs.length - 1] ?? '');
  const dir = segs.map(lower).find((s) => PROTECTED_DIR_NAMES.has(s));
  if (dir) reasons.push(`${dir}/ 目录（原版文件或派生数据只能运行时只读挂载）`);
  if (base === EXTRACT_MARKER) reasons.push('素材包生成标记 .rich4-extract.json');
  if (PACK_FILE_RE.test(base)) reasons.push('素材包命名的文件（<名字>.<8 位十六进制>.<扩展名>）');
  else if (MEDIA_RE.test(base)) reasons.push('音视频 / MIDI / FLIC 文件（镜像与构建产物里不应有）');
  return reasons;
}

/** 按 profile 的路径规则；image 档的 overlay 删除标记 .wh.<名字> 按原名判定 */
export function pathReasons(path: string, profile: Profile): string[] {
  let p = normalizePath(path);
  if (profile === 'image') {
    const segs = p.split('/');
    const last = segs[segs.length - 1] ?? '';
    if (last === '.wh..wh..opq') segs.pop();
    else if (last.startsWith('.wh.')) segs[segs.length - 1] = last.slice(4);
    p = segs.join('/');
  }
  if (p === '') return [];
  const reasons = checkPath(p, { allowExtracted: false });
  if (profile !== 'repo') {
    for (const r of artifactPathReasons(p)) if (!reasons.includes(r)) reasons.push(r);
  }
  return [...new Set(reasons)];
}

// ───────────── 压缩包 ─────────────

/** 展不开的压缩包格式（魔数） */
export function opaqueArchiveKind(p: ContentProbe): string | null {
  if (p.size < 6) return null;
  const h = p.read(0, 8);
  const s = latin1(h);
  const b = (...xs: number[]) => xs.every((x, i) => h[i] === x);
  if (b(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return 'xz';
  if (s.startsWith('BZh')) return 'bzip2';
  if (b(0x28, 0xb5, 0x2f, 0xfd)) return 'zstd';
  if (b(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '7z';
  if (s.startsWith('Rar!\x1a\x07')) return 'rar';
  if (b(0x04, 0x22, 0x4d, 0x18)) return 'lz4';
  if (s.startsWith('LZIP')) return 'lzip';
  if (s.startsWith('MSCF')) return 'cab';
  if (s.startsWith('!<arch>\n')) return 'ar';
  return null;
}

const readOctal = (h: Uint8Array, off: number, len: number): number => {
  if ((h[off]! & 0x80) !== 0) {
    // GNU base-256：最高位是标志位
    let n = h[off]! & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + h[off + i]!;
    return n;
  }
  const s = latin1(h.subarray(off, off + len))
    .replace(/[\0 ]+$/, '')
    .trim();
  return s === '' ? 0 : Number.parseInt(s, 8);
};

const cstr = (h: Uint8Array, off: number, len: number): string => {
  const sub = h.subarray(off, off + len);
  const z = sub.indexOf(0);
  return Buffer.from(z >= 0 ? sub.subarray(0, z) : sub).toString('utf8');
};

/** 空 tar：第一个块全是 0（只有结束标记，例如什么文件都没改的层） */
export function isEmptyTar(p: ContentProbe): boolean {
  return p.size >= 512 && p.read(0, 512).every((x) => x === 0);
}

/** 是否像 tar：ustar 魔数，或者头部校验和正确 */
export function looksLikeTar(p: ContentProbe): boolean {
  if (p.size < 512) return false;
  const h = p.read(0, 512);
  if (h.length < 512) return false;
  if (latin1(h.subarray(257, 262)) === 'ustar') return true;
  if (h[0] === 0) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === readOctal(h, 148, 8);
}

const sliceProbe = (p: ContentProbe, start: number, size: number): ContentProbe => {
  const n = Math.max(0, Math.min(size, p.size - start));
  return { size: n, read: (off, len) => p.read(start + off, Math.max(0, Math.min(len, n - off))) };
};

/** 逐条列出 tar 条目（ustar / GNU 长文件名 / pax 扩展头）；内容以 ContentProbe 形式按需读取 */
export function* tarEntries(p: ContentProbe): Generator<TreeEntry> {
  let off = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  while (off + 512 <= p.size) {
    const h = p.read(off, 512);
    if (h.length < 512 || h.every((x) => x === 0)) return;
    const type = String.fromCharCode(h[156]!);
    let size = readOctal(h, 124, 12);
    if (pax.size !== undefined) size = Number(pax.size);
    const data = off + 512;
    const next = data + Math.ceil(size / 512) * 512;
    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      const text = Buffer.from(p.read(data, Math.min(size, 1 << 20))).toString('utf8');
      if (type === 'L') longName = text.replace(/\0+$/, '');
      else if (type === 'K') longLink = text.replace(/\0+$/, '');
      else if (type === 'x') {
        pax = {};
        for (const rec of text.split('\n')) {
          const m = /^\d+ ([^=]+)=(.*)$/s.exec(rec);
          if (m) pax[m[1]!] = m[2]!;
        }
      }
      off = next;
      continue;
    }
    const magic = latin1(h.subarray(257, 263));
    let name = cstr(h, 0, 100);
    if (magic === 'ustar\0') {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const path = pax.path ?? longName ?? name;
    const link = pax.linkpath ?? longLink ?? cstr(h, 157, 100);
    longName = null;
    longLink = null;
    pax = {};
    if (type === '0' || type === '\0' || type === '7') {
      yield { path, kind: 'file', content: sliceProbe(p, data, size) };
    } else if (type === '2') {
      yield { path, kind: 'symlink', linkTarget: link, content: null };
    } else if (type === '5') {
      yield { path, kind: 'dir', content: null };
    } else {
      // 硬链接（内容在它指向的条目里查过）、设备文件、FIFO 等只看路径
      yield { path, kind: 'other', content: null };
    }
    off = next;
  }
}

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

export function looksLikeZip(p: ContentProbe): boolean {
  return p.size >= 22 && latin1(p.read(0, 4)) === 'PK\x03\x04';
}

/**
 * 逐条列出 zip 条目（按中央目录；stored 与 deflate 的条目解压后给出内容，其他压缩方式、加密条目与 ZIP64 只给路径，
 * 并在 opaque 里记下原因）
 */
export function zipEntries(p: ContentProbe): { entries: TreeEntry[]; opaque: string[] } {
  const entries: TreeEntry[] = [];
  const opaque: string[] = [];
  const tailLen = Math.min(p.size, 65_557);
  const tail = p.read(p.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { entries, opaque: ['找不到 zip 中央目录'] };
  const count = u16(tail, eocd + 10);
  let off = u32(tail, eocd + 16);
  if (count === 0xffff || off === 0xffffffff) return { entries, opaque: ['ZIP64'] };
  for (let n = 0; n < Math.min(count, ZIP_MAX_ENTRIES) && off + 46 <= p.size; n++) {
    const c = p.read(off, 46);
    if (u32(c, 0) !== 0x02014b50) break;
    const flags = u16(c, 8);
    const method = u16(c, 10);
    const comp = u32(c, 20);
    const nameLen = u16(c, 28);
    const extraLen = u16(c, 30);
    const commentLen = u16(c, 32);
    const local = u32(c, 42);
    const path = Buffer.from(p.read(off + 46, nameLen)).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith('/')) {
      entries.push({ path, kind: 'dir', content: null });
      continue;
    }
    const lh = p.read(local, 30);
    if (lh.length < 30 || u32(lh, 0) !== 0x04034b50) {
      entries.push({ path, kind: 'file', content: null });
      opaque.push(`${path}：本地文件头损坏`);
      continue;
    }
    const start = local + 30 + u16(lh, 26) + u16(lh, 28);
    if ((flags & 1) !== 0) {
      entries.push({ path, kind: 'file', content: null });
      opaque.push(`${path}：加密条目`);
    } else if (method === 0) {
      entries.push({ path, kind: 'file', content: sliceProbe(p, start, comp) });
    } else if (method === 8) {
      let bytes: Uint8Array | null = null;
      try {
        const raw = p.read(start, Math.min(comp, ZIP_INFLATE_LIMIT));
        bytes = new Uint8Array(
          inflateRawSync(raw, { finishFlush: zc.Z_SYNC_FLUSH, maxOutputLength: ZIP_INFLATE_LIMIT }),
        );
      } catch {
        bytes = null;
      }
      entries.push({ path, kind: 'file', content: bytes ? probeFromBytes(bytes) : null });
      if (!bytes) opaque.push(`${path}：deflate 数据解不开`);
    } else {
      entries.push({ path, kind: 'file', content: null });
      opaque.push(`${path}：压缩方式 ${method}`);
    }
  }
  return { entries, opaque };
}

// ───────────── 扫描 ─────────────

/** 展不开的压缩包按命中处理的位置：artifact 档处处如此；image 档只在 app/（镜像的应用目录）下，其余告警 */
function opaqueIsHit(path: string, profile: Profile): boolean {
  return profile !== 'image' || normalizePath(path).startsWith('app/');
}

/**
 * 检查一批条目（纯函数：内容只经 ContentProbe 读取）。depth > 0 表示压缩包里的条目：路径规则只看包内路径
 * （包内没有「仓库根」可言，一律按构建产物的规则），报告时写成「压缩包路径!包内路径」（prefix）。
 */
export function scanEntries(entries: Iterable<TreeEntry>, o: TreeScanOptions, depth = 0, prefix = ''): ScanOutcome {
  const out: ScanOutcome = { entries: 0, hits: [], warnings: [] };
  const opts: CheckOptions = { allowExtracted: false, ...(o.bannedHashes ? { bannedHashes: o.bannedHashes } : {}) };
  const profile: Profile = depth > 0 ? 'artifact' : o.profile;
  for (const e of entries) {
    out.entries++;
    const shown = `${prefix}${e.path}`;
    const hit = (reason: string): void => {
      out.hits.push({ path: shown, reason });
    };
    for (const r of pathReasons(e.path, profile)) hit(r);
    if (e.kind === 'symlink' && e.linkTarget) {
      const target = e.linkTarget.startsWith('/')
        ? normalizePath(e.linkTarget)
        : posix.normalize(posix.join(posix.dirname(normalizePath(e.path)), e.linkTarget));
      for (const r of pathReasons(target, 'artifact')) hit(`符号链接指向 ${e.linkTarget}：${r}`);
      continue;
    }
    if (!e.content) continue;
    for (const r of checkContent(e.path, e.content, opts)) hit(r);
    for (const w of contentWarnings(e.content)) out.warnings.push({ path: shown, reason: w });
    const nested = inspectArchive(e.path, shown, e.content, o, depth);
    out.hits.push(...nested.hits);
    out.warnings.push(...nested.warnings);
  }
  return out;
}

/** 压缩包：tar、zip 展开后逐条目再查；gzip / brotli 解出来是 tar 的同样展开；展不开的格式按 opaqueIsHit 处理 */
function inspectArchive(path: string, shown: string, p: ContentProbe, o: TreeScanOptions, depth: number): ScanOutcome {
  const out: ScanOutcome = { entries: 0, hits: [], warnings: [] };
  const opaque = (reason: string): void => {
    const f = { path: shown, reason: `无法展开检查的压缩包（${reason}）` };
    if (depth > 0 || opaqueIsHit(path, o.profile)) out.hits.push(f);
    else out.warnings.push(f);
  };
  let inner: ContentProbe | null = p;
  if (!looksLikeTar(p) && !looksLikeZip(p)) {
    const kind = opaqueArchiveKind(p);
    if (kind) {
      opaque(kind);
      return out;
    }
    const c = compressionKind(path, p);
    const bytes = c ? inflateVariant(c, p) : null;
    inner = bytes ? probeFromBytes(bytes) : null;
    if (!inner || (!looksLikeTar(inner) && !looksLikeZip(inner))) return out;
  }
  if (depth >= ARCHIVE_MAX_DEPTH) {
    opaque(`嵌套超过 ${ARCHIVE_MAX_DEPTH} 层`);
    return out;
  }
  let list: TreeEntry[];
  if (looksLikeZip(inner)) {
    const z = zipEntries(inner);
    list = z.entries;
    for (const r of z.opaque) opaque(`zip ${r}`);
  } else {
    list = [...tarEntries(inner)];
  }
  const r = scanEntries(list, o, depth + 1, `${shown}!`);
  out.hits.push(...r.hits);
  out.warnings.push(...r.warnings);
  return out;
}

// ───────────── 输入：目录、tar 文件、路径清单 ─────────────

/** 打开一个文件作随机读取（整个扫描期间保持打开） */
function fileProbe(abs: string, size: number): { probe: ContentProbe; close: () => void } {
  const fd = openSync(abs, 'r');
  return {
    probe: {
      size,
      read(offset, length) {
        const len = Math.max(0, Math.min(length, size - offset));
        const buf = Buffer.alloc(len);
        if (len > 0) readSync(fd, buf, 0, len, offset);
        return buf;
      },
    },
    close: () => closeSync(fd),
  };
}

/** 递归列出目录里的条目（不跟随符号链接；跳过 skipDirs 里的目录名），路径相对 root */
export function* dirEntries(root: string, skipDirs: ReadonlySet<string> = new Set()): Generator<TreeEntry> {
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const names = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const d of names) {
      const path = rel ? `${rel}/${d.name}` : d.name;
      const abs = join(root, path);
      if (d.isSymbolicLink()) {
        yield { path, kind: 'symlink', linkTarget: readlinkSync(abs), content: null };
      } else if (d.isDirectory()) {
        yield { path, kind: 'dir', content: null };
        if (!skipDirs.has(d.name)) stack.push(path);
      } else if (d.isFile()) {
        const f = fileProbe(abs, lstatSync(abs).size);
        try {
          yield { path, kind: 'file', content: f.probe };
        } finally {
          f.close();
        }
      } else {
        yield { path, kind: 'other', content: null };
      }
    }
  }
}

/** --banned-dir：目录里每个文件的 sha256 */
export function hashDir(root: string): Set<string> {
  const set = new Set<string>();
  for (const e of dirEntries(root)) {
    if (e.kind !== 'file' || !e.content) continue;
    const h = createHash('sha256');
    for (let off = 0; off < e.content.size; off += 1 << 20) h.update(e.content.read(off, 1 << 20));
    set.add(h.digest('hex'));
  }
  return set;
}

interface Args {
  profile: Profile;
  skipDirs: Set<string>;
  bannedJson: string[];
  bannedDirs: string[];
  root: string;
  pathsStdin: boolean;
  inputs: string[];
}

class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    profile: 'artifact',
    skipDirs: new Set(),
    bannedJson: [],
    bannedDirs: [],
    root: REPO_ROOT,
    pathsStdin: false,
    inputs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = (): string => {
      const x = argv[++i];
      if (x === undefined) throw new UsageError(`${k} 缺少参数`);
      return x;
    };
    if (k === '--profile') {
      const p = v();
      if (p !== 'repo' && p !== 'artifact' && p !== 'image') throw new UsageError(`未知的 --profile ${p}`);
      a.profile = p;
    } else if (k === '--skip-dir') a.skipDirs.add(v());
    else if (k === '--banned-json') a.bannedJson.push(v());
    else if (k === '--banned-dir') a.bannedDirs.push(v());
    else if (k === '--root') a.root = resolve(v());
    else if (k === '--paths-stdin') a.pathsStdin = true;
    else if (k.startsWith('--')) throw new UsageError(`未知选项 ${k}`);
    else a.inputs.push(k);
  }
  if (!a.pathsStdin && a.inputs.length === 0) throw new UsageError('至少给出一个目录或 tar 文件（或 --paths-stdin）');
  return a;
}

/** 禁单：check-no-original 的 loadBannedHashes(root)，加上 --banned-json 文件里的全部 64 位十六进制串与 --banned-dir */
function bannedFrom(a: Args): Set<string> {
  const set = loadBannedHashes(a.root);
  for (const f of a.bannedJson) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\b[0-9a-f]{64}\b/gi)) set.add(m[0].toLowerCase());
  }
  for (const d of a.bannedDirs) for (const h of hashDir(d)) set.add(h);
  return set;
}

/** gzip 压缩的层 tar 先解到临时文件再随机读取 */
async function openTar(abs: string): Promise<{ probe: ContentProbe; close: () => void }> {
  const size = lstatSync(abs).size;
  const head = fileProbe(abs, size);
  const h = head.probe.read(0, 3);
  if (!(h[0] === 0x1f && h[1] === 0x8b && h[2] === 0x08)) return head;
  head.close();
  const dir = mkdtempSync(join(tmpdir(), 'rich4-scan-'));
  const out = join(dir, 'layer.tar');
  await pipeline(createReadStream(abs), createGunzip(), createWriteStream(out));
  const f = fileProbe(out, lstatSync(out).size);
  return {
    probe: f.probe,
    close: () => {
      f.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function report(label: string, r: ScanOutcome): void {
  for (const f of r.hits) console.log(`  命中 ${label}：${f.path}  ${f.reason}`);
  for (const f of r.warnings) console.log(`  告警 ${label}：${f.path}  ${f.reason}`);
}

async function main(): Promise<number> {
  let a: Args;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`scan-tree: ${(err as Error).message}`);
    return 2;
  }
  const bannedHashes = bannedFrom(a);
  const o: TreeScanOptions = { profile: a.profile, bannedHashes };
  let hits = 0;
  let total = 0;
  if (a.pathsStdin) {
    const paths = (await readStdin()).split(/[\n\0]/).filter((s) => s.length > 0);
    const r = scanEntries(
      paths.map((path) => ({ path, kind: 'other' as const, content: null })),
      o,
    );
    report('路径清单', r);
    hits += r.hits.length;
    total += r.entries;
    console.log(`  路径清单：${r.entries} 条，命中 ${r.hits.length}`);
  }
  for (const input of a.inputs) {
    const abs = resolve(input);
    const st = lstatSync(abs);
    // 目录照原样显示；层 tar（blobs/sha256/<摘要>）只显示文件名
    const label = st.isDirectory() ? input : basename(abs);
    let r: ScanOutcome;
    if (st.isDirectory()) {
      r = scanEntries(dirEntries(abs, a.skipDirs), o);
    } else {
      const t = await openTar(abs);
      try {
        if (!looksLikeTar(t.probe) && !isEmptyTar(t.probe)) throw new Error(`${input} 不是目录也不是 tar`);
        r = scanEntries(tarEntries(t.probe), o);
      } finally {
        t.close();
      }
    }
    report(label, r);
    console.log(`  ${label}：${r.entries} 个条目，命中 ${r.hits.length}，告警 ${r.warnings.length}`);
    hits += r.hits.length;
    total += r.entries;
  }
  console.log(`scan-tree（${a.profile}，禁单 ${bannedHashes.size} 个哈希）：共 ${total} 个条目，命中 ${hits}`);
  return hits > 0 ? 1 : 0;
}

if (isMainModule(import.meta)) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`scan-tree: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
