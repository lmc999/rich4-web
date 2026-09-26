import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 统一退出码（data-pipeline.md §3）。 */
export const ExitCode = {
  OK: 0,
  /** 结构/校验失败 */
  STRUCTURE: 1,
  /** 缺少输入文件 */
  MISSING_INPUT: 2,
  /** 指纹未知且未加 --allow-unknown */
  UNKNOWN_FINGERPRINT: 3,
  /** 规则相关字段存在版本差异，需要用户选定基线 */
  RULE_DIFF: 4,
  /** override 错误 / 几何无解 */
  OVERRIDE: 5,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class ExtractError extends Error {
  readonly code: string;
  readonly exitCode: ExitCodeValue;
  constructor(code: string, message: string, exitCode: ExitCodeValue = ExitCode.STRUCTURE) {
    super(`${code}: ${message}`);
    this.name = 'ExtractError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class ReadOnlyViolationError extends ExtractError {
  constructor(target: string, guarded: string) {
    super('E_READONLY_SOURCE', `拒绝写入只读的原版目录：${target}（位于 ${guarded} 之下）`);
    this.name = 'ReadOnlyViolationError';
  }
}

/** 所有写操作都必须先经过它。 */
export interface WriteGuard {
  /** 返回规范化后的真实目标路径；目标落在只读目录下时抛 ReadOnlyViolationError。 */
  assertWritable(target: string): string;
}

export interface Logger {
  out(line: string): void;
  err(line: string): void;
}

export const consoleLogger: Logger = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** tools/extract 包目录（本文件位于 src/ 下）。 */
export const PACKAGE_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function norm(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

/** child 是否等于 parent 或位于其下（两者都应是绝对路径）。 */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * 解析真实路径；目标不存在时，对最深的已存在祖先取 realpath 再拼回剩余段。
 * 途经悬空符号链接时抛错，避免借链接写到别处。
 */
export function realpathLoose(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return rest.length > 0 ? path.join(real, ...rest.reverse()) : real;
    } catch {
      let isLink = false;
      try {
        isLink = lstatSync(cur).isSymbolicLink();
      } catch {
        isLink = false;
      }
      if (isLink) throw new ExtractError('E_DANGLING_LINK', `路径经过悬空符号链接：${cur}`);
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export interface ContextOptions {
  /** 仓库根目录；默认按包位置推导（tools/extract/../..）。 */
  root?: string;
  /** 原版文件目录；默认 <root>/original。 */
  src?: string;
  /** 缓存目录；默认 <root>/.cache/extract。 */
  cache?: string;
  /** 解析用户给的相对路径时的基准；默认 process.cwd()。 */
  cwd?: string;
  /** 指纹基线文件；默认 tools/extract/fingerprints.lock.json。 */
  lockFile?: string;
  logger?: Logger;
}

export class ExtractContext implements WriteGuard {
  readonly root: string;
  readonly srcDir: string;
  readonly cacheDir: string;
  readonly packageDir: string;
  readonly cwd: string;
  readonly lockFile: string;
  readonly log: Logger;
  private readonly guarded: readonly string[];

  constructor(opts: ContextOptions = {}) {
    this.cwd = path.resolve(opts.cwd ?? process.cwd());
    this.packageDir = PACKAGE_DIR;
    this.root = path.resolve(this.cwd, opts.root ?? path.join(PACKAGE_DIR, '..', '..'));
    this.srcDir = path.resolve(this.root, opts.src ?? 'original');
    this.cacheDir = path.resolve(this.root, opts.cache ?? path.join('.cache', 'extract'));
    this.lockFile = path.resolve(this.cwd, opts.lockFile ?? path.join(PACKAGE_DIR, 'fingerprints.lock.json'));
    this.log = opts.logger ?? consoleLogger;
    const guards = [this.srcDir, path.join(this.root, 'original')].map((p) => realpathLoose(p));
    this.guarded = [...new Set(guards)];
  }

  /** 只读守卫：任何写入目标位于 original/（或 --src）之下直接抛错。 */
  assertWritable(target: string): string {
    const real = realpathLoose(path.resolve(this.root, target));
    for (const g of this.guarded) {
      if (isInside(real, g)) throw new ReadOnlyViolationError(real, g);
    }
    return real;
  }

  cachePath(...segments: string[]): string {
    return path.join(this.cacheDir, ...segments);
  }

  /** 用户给的路径：绝对路径原样；相对路径先按 cwd，不存在再按仓库根。 */
  resolveUserPath(p: string): string {
    if (path.isAbsolute(p)) return p;
    const fromCwd = path.resolve(this.cwd, p);
    if (existsSync(fromCwd)) return fromCwd;
    const fromRoot = path.resolve(this.root, p);
    return existsSync(fromRoot) ? fromRoot : fromCwd;
  }

  /** 输出用的相对路径（POSIX 分隔符），避免把本机绝对路径写进报告。 */
  displayPath(p: string): string {
    const rel = path.relative(this.root, p);
    return (rel.startsWith('..') ? p : rel).split(path.sep).join('/');
  }
}
