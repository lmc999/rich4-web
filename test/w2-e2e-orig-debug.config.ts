// w2 调试：e2e/playwright.original.config.ts 的变体——服务器日志 info 级输出到终端，便于排查原版皮肤 E2E 失败。
// 用法：CI=1 npx playwright test -c test/w2-e2e-orig-debug.config.ts save-load --grep 自动存档
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../e2e/playwright.original.config';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default {
  ...base,
  testDir: join(repoRoot, 'e2e', 'specs'),
  webServer: servers.map((w, i) =>
    i === 0 ? { ...w, stdout: 'pipe' as const, env: { ...(w.env ?? {}), LOG_LEVEL: 'info' } } : w,
  ),
};
