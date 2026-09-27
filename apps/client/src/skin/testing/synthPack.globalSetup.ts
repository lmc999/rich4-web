// vitest globalSetup（client-unit）：测试前用命令行生成合成素材包到 .cache/synthetic-pack（original-skin.md §3 修正 6）。
// 合成包内容全是自绘图形（不含原版字节），但 JSON 带素材包 schema，所以不入库、每次现场生成。
// apps 不得 import tools/extract，这里只调用 `npm run extract -- assets synth`。
// 设 RICH4_SYNTH_PACK=0 可跳过（需要自己事先生成）。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const SYNTH_PACK_DIR = join(REPO_ROOT, '.cache', 'synthetic-pack');

export default function setup(): void {
  if (process.env.RICH4_SYNTH_PACK === '0' && existsSync(join(SYNTH_PACK_DIR, 'manifest.json'))) return;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['run', '--silent', 'extract', '--', 'assets', 'synth', '--out', '.cache/synthetic-pack'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 120_000,
  });
}
