// 仓库卫生守卫（docs/architecture.md §9.3、docs/design/data-pipeline.md §12）：
// 原版正版文件及其派生数据永不入库。扫描 git 将要纳入版本控制的文件（已跟踪 + 未忽略的新文件）。
// 用法：tsx scripts/check-no-original.ts [--root <dir>]；环境变量 RICH4_ALLOW_EXTRACTED_COMMIT=1 放行派生地图（私有仓库开关）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync, readSync } from 'node:fs';
import { isAbsolute, join, posix, relative } from 'node:path';
import { isMainModule, parseRootArg, toPosix } from './lib/cli';

export const BINARY_SIZE_THRESHOLD = 64 * 1024;
const TEXT_SCAN_LIMIT = 8 * 1024 * 1024;
const HASH_LIMIT = 256 * 1024 * 1024;
const FIXTURE_MAP_DIR = 'packages/shared/src/data/maps/fixtures/';

/** 公开已知的原版可执行文件指纹（docs/design/data-pipeline.md §1），外加运行时从 tools/extract 的指纹文件读取的哈希 */
export const KNOWN_ORIGINAL_SHA256: readonly string[] = [
  '110b29f9d2fadcff3836eb69ec380aa264951859c90955da6e11158d2f956a13', // Steam Game/RICH4.EXE v2.06
  '50cb24bbbd86353e26127e8e89e891c437984655d338a32f1458a3b79596219f', // Steam MultiverseJourney/RICH4.EXE v3.11
  '5a90aee28ee5f7a5c3ba5cb935c9e55751a529c25fcd91208748a66293569550', // mytbk 参考版 v3.11
];

export interface CheckOptions {
  /** 放行 *.map.json 与 data/extracted/（私有仓库入库开关），原版文件本身永不放行 */
  allowExtracted?: boolean;
  bannedHashes?: ReadonlySet<string>;
}

/** 文件内容的随机读取接口，便于用内存数据测试 */
export interface ContentProbe {
  size: number;
  read(offset: number, length: number): Uint8Array;
}

export interface RepoEntry {
  path: string;
  /** null 表示文件已从工作区删除（仍在索引中）或不可读 */
  content: ContentProbe | null;
  /** 符号链接的目标（相对仓库根解析后的 posix 路径）；非链接为 undefined */
  symlinkTarget?: string;
}

export interface Violation {
  path: string;
  reason: string;
}

export function probeFromBytes(bytes: Uint8Array): ContentProbe {
  return {
    size: bytes.length,
    read: (offset, length) => bytes.subarray(offset, Math.min(offset + length, bytes.length)),
  };
}

const lower = (s: string): string => s.toLowerCase();

/** 只按路径判定（纯函数） */
export function checkPath(path: string, opts: CheckOptions = {}): string[] {
  const reasons: string[] = [];
  const segs = path.split('/');
  const base = lower(segs[segs.length - 1] ?? '');
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';

  if (ext === '.mkf') reasons.push('MKF 资源容器（原版文件）');
  if (base === 'rich4.exe') reasons.push('原版可执行文件 RICH4.EXE');
  else if (ext === '.exe' || ext === '.dll') reasons.push('Windows 可执行文件或动态库');
  if (/^save.*\.dat$/.test(base)) reasons.push('原版存档 SAVE*.DAT');
  if (ext === '.avi') reasons.push('原版视频 *.avi');
  if (ext === '.mid' || ext === '.midi') reasons.push('原版 MIDI 音乐 *.mid');
  if (segs[0] === 'original' && segs.length > 1) reasons.push('original/ 下的用户正版文件');
  if (segs[0] === '.cache' && segs.length > 1) reasons.push('.cache/ 下的派生缓存');
  if (segs.slice(0, -1).includes('rich4-data')) reasons.push('rich4-data/ 下的派生数据包');
  if (!opts.allowExtracted) {
    if (base.endsWith('.map.json') && !path.startsWith(FIXTURE_MAP_DIR))
      reasons.push('派生地图 *.map.json（只允许 fixtures/）');
    if (path.startsWith('packages/shared/src/data/extracted/')) reasons.push('派生数据目录 data/extracted/');
  }
  return reasons;
}

const readU32 = (p: ContentProbe, offset: number): number | null => {
  if (offset < 0 || offset + 4 > p.size) return null;
  const b = p.read(offset, 4);
  if (b.length < 4) return null;
  return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
};

/** 大富翁4 MKF：u32@0 为索引表偏移，索引表延伸到文件尾，首项为 4（第一个资源紧跟文件头） */
export function looksLikeMkf(p: ContentProbe): boolean {
  const t = readU32(p, 0);
  if (t === null || t < 8 || t > p.size - 4 || (p.size - t) % 4 !== 0) return false;
  if (readU32(p, t) !== 4) return false;
  const second = readU32(p, t + 4);
  return second === null || (second >= 4 && second <= t);
}

export function looksLikePe(p: ContentProbe): boolean {
  const b = p.read(0, 2);
  return b.length === 2 && b[0] === 0x4d && b[1] === 0x5a;
}

function sha256(p: ContentProbe): string {
  const h = createHash('sha256');
  const chunk = 1 << 20;
  for (let off = 0; off < p.size; off += chunk) h.update(p.read(off, chunk));
  return h.digest('hex');
}

function isTextLike(p: ContentProbe): boolean {
  return !p.read(0, Math.min(p.size, 8192)).includes(0);
}

/** 最长的 base64 字符连续段长度（线性扫描，避免超长量词正则的回溯开销） */
export function longestBase64Run(text: string): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61;
    run = ok ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** 按内容判定（纯函数） */
export function checkContent(path: string, p: ContentProbe, opts: CheckOptions = {}): string[] {
  const reasons: string[] = [];
  if (p.size > BINARY_SIZE_THRESHOLD) {
    if (looksLikePe(p)) reasons.push('内容为 PE/MZ 可执行文件且超过 64KB');
    else if (looksLikeMkf(p)) reasons.push('内容符合 MKF 容器特征且超过 64KB');
  }
  if (opts.bannedHashes && opts.bannedHashes.size > 0 && p.size <= HASH_LIMIT && opts.bannedHashes.has(sha256(p))) {
    reasons.push('sha256 与原版文件指纹一致');
  }
  if (p.size <= TEXT_SCAN_LIMIT && p.size > 0 && isTextLike(p)) {
    const text = Buffer.from(p.read(0, p.size)).toString('latin1');
    if (longestBase64Run(text) >= BINARY_SIZE_THRESHOLD) reasons.push('疑似内嵌二进制（超长 base64 串）');
    const inTestDir = path.split('/').some((s) => s === 'test' || s === 'tests' || s === '__tests__');
    if (path.endsWith('.json') && !inTestDir && /"(?:rawHex|hex)"\s*:\s*"[0-9a-fA-F\s]{128,}"/.test(text)) {
      reasons.push('JSON 中含原始字节 hex/rawHex 字段（只允许出现在 test/）');
    }
  }
  return reasons;
}

function isProtectedTarget(target: string, opts: CheckOptions): boolean {
  const segs = target.split('/');
  return (
    segs[0] === 'original' || segs[0] === '.cache' || segs.includes('rich4-data') || checkPath(target, opts).length > 0
  );
}

/** 检查一组条目（纯函数） */
export function check(entries: readonly RepoEntry[], opts: CheckOptions = {}): Violation[] {
  const out: Violation[] = [];
  for (const e of entries) {
    const reasons = checkPath(e.path, opts);
    if (e.symlinkTarget !== undefined) {
      if (isProtectedTarget(e.symlinkTarget, opts)) reasons.push(`符号链接指向受保护路径 ${e.symlinkTarget}`);
    } else if (e.content) {
      reasons.push(...checkContent(e.path, e.content, opts));
    }
    for (const reason of reasons) out.push({ path: e.path, reason });
  }
  return out;
}

/** git 将要纳入版本控制的文件：已跟踪 + 未被忽略的新文件 */
export function listRepoFiles(root: string): string[] {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`git ls-files 失败：${r.error?.message ?? r.stderr.trim()}`);
  }
  return [...new Set(r.stdout.split('\0').filter((s) => s.length > 0))].sort();
}

function diskProbe(abs: string, size: number): ContentProbe {
  return {
    size,
    read(offset, length) {
      const len = Math.max(0, Math.min(length, size - offset));
      const buf = Buffer.alloc(len);
      if (len === 0) return buf;
      const fd = openSync(abs, 'r');
      try {
        readSync(fd, buf, 0, len, offset);
      } finally {
        closeSync(fd);
      }
      return buf;
    },
  };
}

/** 从 tools/extract 的指纹文件收集原版文件哈希（文件不存在时忽略） */
export function loadBannedHashes(root: string): Set<string> {
  const set = new Set(KNOWN_ORIGINAL_SHA256);
  for (const f of ['tools/extract/fingerprints.lock.json', 'tools/extract/known-files.json']) {
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    for (const m of readFileSync(abs, 'utf8').matchAll(/\b[0-9a-f]{64}\b/gi)) set.add(m[0].toLowerCase());
  }
  return set;
}

export function scan(root: string, opts: CheckOptions = {}): { files: number; violations: Violation[] } {
  const paths = listRepoFiles(root);
  const entries: RepoEntry[] = paths.map((path) => {
    const abs = join(root, path);
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        const link = readlinkSync(abs);
        const target = isAbsolute(link)
          ? toPosix(relative(root, link))
          : posix.normalize(posix.join(posix.dirname(path), toPosix(link)));
        return { path, content: null, symlinkTarget: target };
      }
      if (!st.isFile()) return { path, content: null };
      return { path, content: diskProbe(abs, st.size) };
    } catch {
      return { path, content: null };
    }
  });
  return { files: entries.length, violations: check(entries, opts) };
}

function main(): void {
  const root = parseRootArg(process.argv.slice(2));
  const opts: CheckOptions = {
    allowExtracted: process.env.RICH4_ALLOW_EXTRACTED_COMMIT === '1',
    bannedHashes: loadBannedHashes(root),
  };
  let result: ReturnType<typeof scan>;
  try {
    result = scan(root, opts);
  } catch (err) {
    console.error(`check-no-original: ${(err as Error).message}`);
    process.exit(2);
  }
  if (result.violations.length > 0) {
    for (const v of result.violations) console.error(`${v.path}  ${v.reason}`);
    console.error(
      `\ncheck-no-original: 发现 ${result.violations.length} 处违规。原版文件与派生数据只能放在 original/、.cache/、rich4-data/（均已 gitignore）。`,
    );
    process.exit(1);
  }
  const note = opts.allowExtracted ? '（RICH4_ALLOW_EXTRACTED_COMMIT=1：已放行派生地图）' : '';
  console.log(`check-no-original: OK（检查 ${result.files} 个文件）${note}`);
}

if (isMainModule(import.meta)) main();
