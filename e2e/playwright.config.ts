// Playwright E2E（design/client.md §12.2；architecture §8）：
// - webServer 启动 RICH4_TEST_MODE=1 的服务器（端口 3100，开放 debug:act）与 Vite（端口 5174，/socket.io 与 /api 代理到 3100；
//   用 build + preview 而不是 dev server，避免 HMR 整页刷新打断多页面测试）；
// - 浏览器用本机 Google Chrome（channel 'chrome'），不下载新浏览器；
// - 页面 URL 带 ?anim=instant&audio=off；点击一律走 DOM 备用按钮（data-testid），不点画布坐标。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
export const SERVER_PORT = 3100;
export const CLIENT_PORT = 5174;
const reuse = !process.env.CI;

export default defineConfig({
  testDir: './specs',
  outputDir: join(repoRoot, 'test-results', 'e2e'),
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  webServer: [
    {
      command: 'npx tsx apps/server/src/main.ts',
      cwd: repoRoot,
      url: `http://127.0.0.1:${SERVER_PORT}/healthz`,
      reuseExistingServer: reuse,
      timeout: 90_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        RICH4_TEST_MODE: '1',
        PORT: String(SERVER_PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        LOG_PRETTY: '0',
        PUBLIC_URL: `http://localhost:${CLIENT_PORT}`,
        // 持久化写到临时目录，不污染仓库
        DATA_DIR: mkdtempSync(join(tmpdir(), 'rich4-e2e-')),
      },
    },
    {
      // 生产构建 + vite preview（沿用 server.proxy 代理 /socket.io 与 /api）：没有 HMR，
      // 测试期间别处改文件也不会让页面整页刷新；测试钩子由 ?anim=instant 打开
      command: `npx vite build --logLevel warn && npx vite preview --port ${CLIENT_PORT} --strictPort`,
      cwd: join(repoRoot, 'apps/client'),
      url: `http://localhost:${CLIENT_PORT}/`,
      reuseExistingServer: reuse,
      timeout: 90_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { RICH4_API_TARGET: `http://127.0.0.1:${SERVER_PORT}` },
    },
  ],
});
