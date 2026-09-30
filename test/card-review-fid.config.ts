// 审查（原版忠实度，只读）：连本机已起好的真实素材包实例（前端 5741 → 服务器 3741，RICH4_TEST_MODE=1、免门禁例外），
// 不启动 webServer。用法：npx playwright test -c test/card-review-fid.config.ts
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export default defineConfig({
  testDir: join(root, 'test'),
  testMatch: /card-review-fid\.spec\.ts$/,
  outputDir: join(root, '.cache', 'card', 'review-fid', 'pw'),
  timeout: 600_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.REVIEW_BASE ?? 'http://localhost:5741',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1920, height: 1080 },
    actionTimeout: 60_000,
  },
});
