import { readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 当前模块是否为命令行入口（tsx/node 直接运行时为 true，被 vitest 或其他模块导入时为 false） */
export function isMainModule(meta: ImportMeta): boolean {
  const flag = (meta as { main?: unknown }).main;
  if (typeof flag === 'boolean') return flag;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(meta.url));
  } catch {
    return false;
  }
}

/** 仓库根目录：scripts/lib 的上两级 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 解析 `--root <dir>` 参数，默认仓库根目录 */
export function parseRootArg(argv: readonly string[]): string {
  const k = argv.indexOf('--root');
  const v = k >= 0 ? argv[k + 1] : undefined;
  return v ? resolve(v) : REPO_ROOT;
}

export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.cache', 'rich4-data', 'original']);

/** 递归列出 dir 下满足 accept 的文件，返回相对 root 的 posix 路径（已排序）；dir 不存在时返回空数组 */
export function walkFiles(
  root: string,
  dir: string,
  accept: (relPath: string) => boolean,
  skipDirs: ReadonlySet<string> = DEFAULT_SKIP_DIRS,
): string[] {
  const out: string[] = [];
  const abs = join(root, dir);
  try {
    if (!statSync(abs).isDirectory()) return out;
  } catch {
    return out;
  }
  const visit = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        if (!skipDirs.has(ent.name)) visit(p);
      } else if (ent.isFile()) {
        const rel = toPosix(relative(root, p));
        if (accept(rel)) out.push(rel);
      }
    }
  };
  visit(abs);
  return out.sort();
}
