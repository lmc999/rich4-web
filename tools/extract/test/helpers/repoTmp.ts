/**
 * 测试专用：本机测试（读用户正版文件、产出原版派生物）的临时目录一律建在 <仓库>/.cache/test-tmp/ 下，
 * 不写系统临时目录（原版皮肤硬性规则：素材包与所有派生物只写入 rich4-assets/ 或 .cache/**）。
 * 进程被杀时残留也只会留在已被 git / docker 忽略的 .cache/ 里。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { realpathLoose } from '../../src/context';
import { originalCtx } from './originalMkf';

/** 本机测试临时目录的父目录 */
export const REPO_TEST_TMP = path.join(originalCtx.root, '.cache', 'test-tmp');

/** 该路径是否被本仓库的 git 忽略（git 不可用时为 null） */
export function repoIgnores(abs: string): boolean | null {
  const r = spawnSync('git', ['check-ignore', '-q', '--', abs], { cwd: originalCtx.root });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  return r.status === 0;
}

/** 在 <仓库>/.cache/test-tmp/ 下建一个新的临时目录（真实路径） */
export function makeRepoTmpDir(prefix: string): string {
  mkdirSync(REPO_TEST_TMP, { recursive: true });
  return realpathLoose(mkdtempSync(path.join(REPO_TEST_TMP, prefix)));
}
