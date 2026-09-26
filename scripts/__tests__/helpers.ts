import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../lib/cli';

/** 在系统临时目录建一个假仓库，返回根路径与清理函数 */
export function makeTempRepo(prefix: string): {
  root: string;
  write: (path: string, data: string | Uint8Array) => void;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), `rich4-${prefix}-`));
  return {
    root,
    write(path, data) {
      const abs = join(root, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, data);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 以 tsx 运行 scripts/ 下的守卫脚本（cwd 为真实仓库，便于解析 tsx），返回退出码与输出 */
export function runScript(script: string, root: string, env: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'scripts', script), '--root', root], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

export function hasGit(): boolean {
  return spawnSync('git', ['--version']).status === 0;
}

export function git(root: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
}
