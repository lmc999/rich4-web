// 仓库卫生守卫（docs/architecture.md §9.3、docs/design/data-pipeline.md §12、docs/design/original-skin.md §3 修正 5）：
// 原版正版文件及其派生数据（含原版皮肤素材包 rich4-assets/）永不入库。扫描 git 将要纳入版本控制的文件（已跟踪 + 未忽略的新文件）。
// 用法：tsx scripts/check-no-original.ts [--root <dir>]；环境变量 RICH4_ALLOW_EXTRACTED_COMMIT=1 放行派生地图（私有仓库开关），
// RICH4_ASSETS_DIR 指向额外的素材包目录（其 manifest.json 里的 sha256 并入禁单；.cache/** 下的素材包 manifest 自动并入）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { brotliDecompressSync, gunzipSync, constants as zc } from 'node:zlib';
// 带 .ts 后缀：scan-tree.ts 经它在 node:24-slim 里用 Node 自带的类型剥离直接运行（不经 tsx）
import { isMainModule, parseRootArg, toPosix } from './lib/cli.ts';

export const BINARY_SIZE_THRESHOLD = 64 * 1024;
const TEXT_SCAN_LIMIT = 8 * 1024 * 1024;
const HASH_LIMIT = 256 * 1024 * 1024;
const FIXTURE_MAP_DIR = 'packages/shared/src/data/maps/fixtures/';
/** 媒体文件的派生标记扫描窗口：文件头、文件尾各 1 MiB（MP4 未 faststart 时 moov 在文件尾） */
const MEDIA_SCAN_WINDOW = 1024 * 1024;
const PNG_MAX_CHUNKS = 1_000_000;
const RIFF_MAX_CHUNKS = 10_000;

/** 原版皮肤素材包目录名（任何层级出现都拦截） */
export const ASSET_PACK_DIR = 'rich4-assets';
/** 本机素材包 manifest 的候选位置（相对仓库根）；存在时把其中全部 sha256 并入禁单 */
export const ASSET_MANIFEST_CANDIDATES: readonly string[] = [
  'rich4-assets/manifest.json',
  '.cache/rich4-assets/manifest.json',
];
/** 另在 .cache/ 下按层级查找素材包 manifest（schema rich4.assets/*）：`assets build --out .cache/xxx` 这类自选目录 */
export const CACHE_MANIFEST_MAX_DEPTH = 4;
const CACHE_MANIFEST_MAX_DIRS = 20_000;
const ASSET_MANIFEST_SCHEMA_RE = /"schema"\s*:\s*"rich4\.assets\\?\/\d+"/;

// 以下常量与 packages/shared/src/assets（DERIVED_MARKERS、DERIVED_JSON_SCHEMAS、DERIVED_DETAIL_JSON_SCHEMAS）保持一致，
// 由 __tests__ 对拍；守卫本身不依赖 shared，保证在 shared 编译不过时也能运行。
/** 派生 PNG 的 tEXt 关键字 */
export const DERIVED_PNG_KEYWORD = 'rich4:derived';
/** 音视频元数据里的派生标记（RICH4_DERIVED=1、rich4-derived、rich4:derived） */
export const DERIVED_MEDIA_MARKER_RE = /rich4[-_:]derived/i;
/** 素材包派生 JSON 的 schema 标识：契约版（manifest、图集、地图皮肤、映射表）+ A3 的详表与暂存映射表 */
export const DERIVED_JSON_SCHEMA_IDS: readonly string[] = [
  'rich4.assets/1',
  'rich4.mapskin/1',
  'rich4.atlas/1',
  'rich4.voicemap/1',
  'rich4.sfxsets/1',
  'rich4.musicmap/1',
  'rich4.flicmap/1',
  'rich4.voice-map/1',
  'rich4.sfx-sets/1',
  'rich4.music-map/1',
  'rich4.flic-map/1',
  'rich4.video-map/1',
];
/**
 * 顶层或嵌套的 `"schema": "rich4.<派生类>/<n>"`（允许 JSON 转义的 `\/`，覆盖后续版本号）。派生类名逐个列出，
 * 不做 `rich4\.[a-z-]+` 宽匹配：仓库里有合法入库的 rich4.known-files、rich4.fingerprints-lock、rich4.anchors-* 等 JSON。
 */
const DERIVED_JSON_SCHEMA_RE =
  /"schema"\s*:\s*"(rich4\.(?:assets|mapskin|atlas|voicemap|sfxsets|musicmap|flicmap|voice-map|sfx-sets|music-map|flic-map|video-map)\\?\/\d+)"/;

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
  if (segs.slice(0, -1).includes(ASSET_PACK_DIR)) reasons.push('rich4-assets/ 下的原版皮肤素材包');
  if (/\.fl[ci](?:\.(?:br|gz))?$/.test(base)) reasons.push('FLIC 动画 *.flc / *.fli（原版派生）');
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

const latin1 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');
const u16le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32le = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const u32be = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

const PNG_SIGNATURE = '\x89PNG\r\n\x1a\n';

/** 原版资源魔数：解压后的 SPR/SMP 精灵与 GND 地面 */
export function originalResourceMagic(p: ContentProbe): 'SPR' | 'SMP' | 'GND' | null {
  if (p.size < 4) return null;
  const m = latin1(p.read(0, 4));
  return m === 'SPR\0' || m === 'SMP\0' || m === 'GND\0' ? (m.slice(0, 3) as 'SPR' | 'SMP' | 'GND') : null;
}

/** FLIC 文件头：u16@4 为 0xAF12（FLC）或 0xAF11（FLI），u16@12（色深）为 8 */
export function looksLikeFlic(p: ContentProbe): boolean {
  if (p.size < 16) return false;
  const h = p.read(0, 16);
  if (h.length < 16) return false;
  const magic = u16le(h, 4);
  return (magic === 0xaf12 || magic === 0xaf11) && u16le(h, 12) === 8;
}

/** PNG 的文本块（tEXt/zTXt/iTXt）里是否有 rich4:derived（逐块遍历，只读块头与文本块） */
export function pngHasDerivedText(p: ContentProbe): boolean {
  if (p.size < 8 || latin1(p.read(0, 8)) !== PNG_SIGNATURE) return false;
  let off = 8;
  for (let n = 0; n < PNG_MAX_CHUNKS && off + 8 <= p.size; n++) {
    const hdr = p.read(off, 8);
    if (hdr.length < 8) break;
    const len = u32be(hdr, 0);
    const type = latin1(hdr.subarray(4, 8));
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const data = latin1(p.read(off + 8, Math.min(len, 64 * 1024)));
      if (data.includes(DERIVED_PNG_KEYWORD)) return true;
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return false;
}

/** 常见音视频容器：Ogg、ISO BMFF（mp4/m4a）、EBML（webm/mkv）、ID3（mp3）、FLAC、RIFF（wav/webp/avi） */
export function isMediaContainer(p: ContentProbe): boolean {
  if (p.size < 12) return false;
  const h = latin1(p.read(0, 12));
  return (
    h.startsWith('OggS') ||
    h.slice(4, 8) === 'ftyp' ||
    h.startsWith('\x1a\x45\xdf\xa3') ||
    h.startsWith('ID3') ||
    h.startsWith('fLaC') ||
    h.startsWith('RIFF')
  );
}

/** 音视频元数据里是否有派生标记（扫描文件头与文件尾各 1 MiB） */
export function mediaHasDerivedMarker(p: ContentProbe): boolean {
  if (p.size <= 2 * MEDIA_SCAN_WINDOW) return DERIVED_MEDIA_MARKER_RE.test(latin1(p.read(0, p.size)));
  return (
    DERIVED_MEDIA_MARKER_RE.test(latin1(p.read(0, MEDIA_SCAN_WINDOW))) ||
    DERIVED_MEDIA_MARKER_RE.test(latin1(p.read(p.size - MEDIA_SCAN_WINDOW, MEDIA_SCAN_WINDOW)))
  );
}

/** 文本内容里的素材包 schema（只看 *.json 或以 `{` 开头的文本）；没有时返回 null */
export function derivedJsonSchema(path: string, text: string): string | null {
  if (!lower(path).endsWith('.json') && !/^(?:\xef\xbb\xbf)?\s*\{/.test(text.slice(0, 256))) return null;
  const m = DERIVED_JSON_SCHEMA_RE.exec(text);
  return m ? m[1]!.replace('\\/', '/') : null;
}

/** 与原版派生内容相关的判定（二进制部分，不看大小阈值） */
export function derivedBinaryReasons(p: ContentProbe): string[] {
  const reasons: string[] = [];
  const magic = originalResourceMagic(p);
  if (magic) reasons.push(`内容为原版 ${magic} 资源（魔数 ${magic}\\0）`);
  if (looksLikeFlic(p)) reasons.push('内容为 FLIC 动画（FLC/FLI 8bpp 文件头）');
  if (pngHasDerivedText(p)) reasons.push('派生 PNG（tEXt rich4:derived）');
  else if (isMediaContainer(p) && mediaHasDerivedMarker(p)) {
    reasons.push('派生音视频（元数据含 RICH4_DERIVED / rich4-derived）');
  }
  return reasons;
}

/** 只告警的内容：RIFF WAVE 的 LIST/INFO/ISFT 为 GoldWave 或 Awave（原版 Speaking/Effect 的 WAV 带这两种签名） */
export function contentWarnings(p: ContentProbe): string[] {
  if (p.size < 12) return [];
  const head = p.read(0, 12);
  if (latin1(head.subarray(0, 4)) !== 'RIFF' || latin1(head.subarray(8, 12)) !== 'WAVE') return [];
  let off = 12;
  for (let n = 0; n < RIFF_MAX_CHUNKS && off + 8 <= p.size; n++) {
    const hdr = p.read(off, 8);
    if (hdr.length < 8) break;
    const id = latin1(hdr.subarray(0, 4));
    const size = u32le(hdr, 4);
    if (id === 'LIST' && size >= 4) {
      const body = p.read(off + 8, Math.min(size, 64 * 1024));
      if (latin1(body.subarray(0, 4)) === 'INFO') {
        let s = 4;
        while (s + 8 <= body.length) {
          const sid = latin1(body.subarray(s, s + 4));
          const ssize = u32le(body, s + 4);
          if (sid === 'ISFT') {
            const value = latin1(body.subarray(s + 8, s + 8 + ssize)).replace(/\0+$/, '');
            if (/^(?:GoldWave|Awave)/i.test(value)) return [`疑似原版 WAV（ISFT=${value}），请确认不是原版派生音频`];
          }
          s += 8 + ssize + (ssize & 1);
        }
      }
    }
    off += 8 + size + (size & 1);
  }
  return [];
}

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

// ───────────── 预压缩变体（*.br / *.gz 改名后只剩压缩流）：解压后再判定 ─────────────

/** 解压时最多读入的压缩字节数与最多产出的字节数；产出超限时退到只解前 64 KiB 输入 */
const INFLATE_INPUT_LIMIT = 8 * 1024 * 1024;
const INFLATE_OUTPUT_LIMIT = 64 * 1024 * 1024;
const INFLATE_HEAD = 64 * 1024;

export type CompressionKind = 'gzip' | 'brotli';

/** 常见的非 brotli 二进制格式（不必尝试 brotli 解码） */
function knownBinaryMagic(h: Uint8Array): boolean {
  const s = latin1(h.subarray(0, 16));
  const b = (...xs: number[]) => xs.every((x, i) => h[i] === x);
  return (
    s.startsWith(PNG_SIGNATURE) ||
    b(0xff, 0xd8, 0xff) ||
    s.startsWith('GIF8') ||
    s.startsWith('RIFF') ||
    s.startsWith('OggS') ||
    s.slice(4, 8) === 'ftyp' ||
    s.startsWith('\x1a\x45\xdf\xa3') ||
    s.startsWith('ID3') ||
    s.startsWith('fLaC') ||
    s.startsWith('PK\x03\x04') ||
    s.startsWith('MZ') ||
    s.startsWith('%PDF') ||
    s.startsWith('wOFF') ||
    s.startsWith('wOF2') ||
    s.startsWith('OTTO') ||
    b(0x00, 0x01, 0x00, 0x00) ||
    b(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) ||
    b(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) ||
    b(0x28, 0xb5, 0x2f, 0xfd) ||
    s.startsWith('BZh') ||
    s.startsWith('SQLite format 3')
  );
}

function isValidUtf8(b: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断是否像预压缩变体：gzip 看魔数 1f 8b 08；brotli 没有魔数——文件名以 .br 结尾，
 * 或内容既不是已知二进制格式、也不是合法 UTF-8 文本时，尝试解码（解不出来就不算）。
 */
export function compressionKind(path: string, p: ContentProbe): CompressionKind | null {
  if (p.size < 4) return null;
  const head = p.read(0, Math.min(p.size, INFLATE_HEAD));
  if (head[0] === 0x1f && head[1] === 0x8b && head[2] === 0x08) return 'gzip';
  if (lower(path).endsWith('.br')) return 'brotli';
  if (knownBinaryMagic(head)) return null;
  return head.includes(0) || !isValidUtf8(head) ? 'brotli' : null;
}

/** 解压预压缩变体（可能只解出文件头部）；不是压缩流或解不出内容时返回 null */
export function inflateVariant(kind: CompressionKind, p: ContentProbe): Uint8Array | null {
  const input = p.read(0, Math.min(p.size, INFLATE_INPUT_LIMIT));
  const run = (buf: Uint8Array): Uint8Array =>
    new Uint8Array(
      kind === 'gzip'
        ? gunzipSync(buf, { finishFlush: zc.Z_SYNC_FLUSH, maxOutputLength: INFLATE_OUTPUT_LIMIT })
        : brotliDecompressSync(buf, { finishFlush: zc.BROTLI_OPERATION_FLUSH, maxOutputLength: INFLATE_OUTPUT_LIMIT }),
    );
  for (const n of [input.length, Math.min(input.length, INFLATE_HEAD)]) {
    try {
      const out = run(input.subarray(0, n));
      return out.length > 0 ? out : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ERR_BUFFER_TOO_LARGE') return null;
    }
  }
  return null;
}

/** 按内容判定（纯函数）。预压缩变体（gzip / 疑似 brotli）另解压一层再判定，原因带「… 解压后」前缀 */
export function checkContent(path: string, p: ContentProbe, opts: CheckOptions = {}): string[] {
  const reasons = checkPlainContent(path, p, opts);
  if (reasons.length > 0) return reasons;
  const kind = compressionKind(path, p);
  if (kind === null) return reasons;
  const inner = inflateVariant(kind, p);
  if (inner === null) return reasons;
  const innerPath = path.replace(/\.(?:br|gz)$/i, '');
  for (const r of checkPlainContent(innerPath, probeFromBytes(inner), opts)) {
    reasons.push(`${kind} 解压后：${r}`);
  }
  return reasons;
}

function checkPlainContent(path: string, p: ContentProbe, opts: CheckOptions): string[] {
  const reasons: string[] = [];
  if (p.size > BINARY_SIZE_THRESHOLD) {
    if (looksLikePe(p)) reasons.push('内容为 PE/MZ 可执行文件且超过 64KB');
    else if (looksLikeMkf(p)) reasons.push('内容符合 MKF 容器特征且超过 64KB');
  }
  reasons.push(...derivedBinaryReasons(p));
  if (opts.bannedHashes && opts.bannedHashes.size > 0 && p.size <= HASH_LIMIT && opts.bannedHashes.has(sha256(p))) {
    reasons.push('sha256 命中禁单（原版文件指纹或本机素材包 manifest）');
  }
  if (p.size <= TEXT_SCAN_LIMIT && p.size > 0 && isTextLike(p)) {
    const text = Buffer.from(p.read(0, p.size)).toString('latin1');
    if (longestBase64Run(text) >= BINARY_SIZE_THRESHOLD) reasons.push('疑似内嵌二进制（超长 base64 串）');
    const inTestDir = path.split('/').some((s) => s === 'test' || s === 'tests' || s === '__tests__');
    if (path.endsWith('.json') && !inTestDir && /"(?:rawHex|hex)"\s*:\s*"[0-9a-fA-F\s]{128,}"/.test(text)) {
      reasons.push('JSON 中含原始字节 hex/rawHex 字段（只允许出现在 test/）');
    }
    const schema = derivedJsonSchema(path, text);
    if (schema) reasons.push(`原版皮肤素材包 JSON（schema ${schema}）`);
  } else if (p.size > TEXT_SCAN_LIMIT && lower(path).endsWith('.json')) {
    // 超大 JSON 只看头尾窗口（规范化 JSON 的键按字典序排列，schema 通常靠近末尾）
    const head = latin1(p.read(0, MEDIA_SCAN_WINDOW));
    const tail = latin1(p.read(p.size - MEDIA_SCAN_WINDOW, MEDIA_SCAN_WINDOW));
    const schema = derivedJsonSchema(path, head) ?? derivedJsonSchema(path, tail);
    if (schema) reasons.push(`原版皮肤素材包 JSON（schema ${schema}）`);
  }
  return reasons;
}

function isProtectedTarget(target: string, opts: CheckOptions): boolean {
  const segs = target.split('/');
  return (
    segs[0] === 'original' ||
    segs[0] === '.cache' ||
    segs.includes('rich4-data') ||
    segs.includes(ASSET_PACK_DIR) ||
    checkPath(target, opts).length > 0
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

/** 只告警、不判失败的内容（纯函数） */
export function checkWarnings(entries: readonly RepoEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const e of entries) {
    if (e.symlinkTarget !== undefined || !e.content) continue;
    for (const reason of contentWarnings(e.content)) out.push({ path: e.path, reason });
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

/** 本机素材包 manifest 的绝对路径候选：仓库内的默认位置，加上 RICH4_ASSETS_DIR（相对仓库根解析） */
export function assetManifestPaths(root: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out = ASSET_MANIFEST_CANDIDATES.map((f) => join(root, f));
  const dir = env.RICH4_ASSETS_DIR;
  if (dir) out.push(join(resolve(root, dir), 'manifest.json'));
  return [...new Set(out)];
}

/**
 * .cache/ 下（至多 CACHE_MANIFEST_MAX_DEPTH 层，不跟随符号链接）所有 schema 为 rich4.assets/* 的 manifest.json：
 * `assets build --out .cache/<任意>` 输出的素材包也并入禁单。按路径升序。
 */
export function cacheAssetManifests(root: string): string[] {
  const out: string[] = [];
  const queue: [dir: string, depth: number][] = [[join(root, '.cache'), 0]];
  for (let i = 0; i < queue.length && i < CACHE_MANIFEST_MAX_DIRS; i++) {
    const [dir, depth] = queue[i]!;
    let names: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < CACHE_MANIFEST_MAX_DEPTH) queue.push([abs, depth + 1]);
      } else if (e.isFile() && e.name === 'manifest.json') {
        try {
          if (ASSET_MANIFEST_SCHEMA_RE.test(readFileSync(abs, 'utf8'))) out.push(abs);
        } catch {
          // 读不到的文件跳过
        }
      }
    }
  }
  return out.sort();
}

/**
 * 禁单：公开的原版指纹 + tools/extract 的指纹文件 + 本机素材包 manifest 里的全部 sha256（文件不存在时忽略）。
 * 本机素材包 = rich4-assets/、.cache/rich4-assets/、RICH4_ASSETS_DIR，以及 .cache/** 下 schema 为 rich4.assets/* 的 manifest。
 * 素材包文件即使改名、去掉标记后被拷进仓库，也能按内容哈希拦下（预压缩变体的哈希也记在 manifest 里）。
 */
export function loadBannedHashes(root: string, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const set = new Set(KNOWN_ORIGINAL_SHA256);
  const sources = [
    join(root, 'tools/extract/fingerprints.lock.json'),
    join(root, 'tools/extract/known-files.json'),
    ...assetManifestPaths(root, env),
    ...cacheAssetManifests(root),
  ];
  for (const abs of new Set(sources)) {
    if (!existsSync(abs)) continue;
    for (const m of readFileSync(abs, 'utf8').matchAll(/\b[0-9a-f]{64}\b/gi)) set.add(m[0].toLowerCase());
  }
  return set;
}

export interface ScanResult {
  files: number;
  violations: Violation[];
  warnings: Violation[];
}

export function scan(root: string, opts: CheckOptions = {}): ScanResult {
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
  return { files: entries.length, violations: check(entries, opts), warnings: checkWarnings(entries) };
}

function main(): void {
  const root = parseRootArg(process.argv.slice(2));
  const opts: CheckOptions = {
    allowExtracted: process.env.RICH4_ALLOW_EXTRACTED_COMMIT === '1',
    bannedHashes: loadBannedHashes(root),
  };
  let result: ScanResult;
  try {
    result = scan(root, opts);
  } catch (err) {
    console.error(`check-no-original: ${(err as Error).message}`);
    process.exit(2);
  }
  for (const w of result.warnings) console.warn(`${w.path}  ${w.reason}（告警）`);
  if (result.violations.length > 0) {
    for (const v of result.violations) console.error(`${v.path}  ${v.reason}`);
    console.error(
      `\ncheck-no-original: 发现 ${result.violations.length} 处违规。原版文件与派生数据只能放在 original/、.cache/、rich4-data/、rich4-assets/（均已 gitignore）。`,
    );
    process.exit(1);
  }
  const note = opts.allowExtracted ? '（RICH4_ALLOW_EXTRACTED_COMMIT=1：已放行派生地图）' : '';
  const warn = result.warnings.length > 0 ? `，告警 ${result.warnings.length} 处` : '';
  console.log(`check-no-original: OK（检查 ${result.files} 个文件${warn}）${note}`);
}

if (isMainModule(import.meta)) main();
