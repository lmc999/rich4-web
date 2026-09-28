// 调试（M11 验证 8）：对着已部署的实例（缺省 https://localhost:8443，经 Caddy）用真实浏览器巡检原版皮肤（test/m11-tour.spec.ts）。
// 远程模式：不启动 webServer；Caddy 内部 CA 的自签证书用 ignoreHTTPSErrors 放行。口令从 .cache/m11/passcode.txt 读。
// 截图与 summary 写到 .cache/m11/tour/（含原版素材，不入库）。
// 用法：npx playwright test -c test/m11-playwright.config.ts            （M11_BASE_URL 可改目标实例）
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  testDir: join(root, 'test'),
  testMatch: /m11-(tour|ws-fallback)\.spec\.ts$/,
  outputDir: join(root, '.cache', 'm11', 'tour-results'),
  timeout: 900_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.M11_BASE_URL ?? 'https://localhost:8443',
    ignoreHTTPSErrors: true,
    channel: 'chrome',
    headless: true,
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
