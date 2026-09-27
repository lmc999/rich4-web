// 调试：在独立端口（服务器 3110、前端 5184）与独立构建目录（.cache/w1-e2e-dist）上跑 E2E，
// 不与其他并行任务正在使用的 3100/5174 与 apps/client/dist 冲突。用法：npx playwright test -c test/w1-e2e.config.ts [spec]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const repoRoot = resolve(import.meta.dirname, '..');
const SERVER_PORT = 3110;
const CLIENT_PORT = 5184;
const OUT = join(repoRoot, '.cache', 'w1-e2e-dist');

export default defineConfig({
  testDir: join(repoRoot, 'e2e/specs'),
  outputDir: join(repoRoot, 'test-results', 'w1-e2e'),
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
      reuseExistingServer: false,
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
        DATA_DIR: mkdtempSync(join(tmpdir(), 'rich4-w1-e2e-')),
      },
    },
    {
      command: `npx vite build --logLevel warn --outDir ${OUT} --emptyOutDir && npx vite preview --outDir ${OUT} --port ${CLIENT_PORT} --strictPort`,
      cwd: join(repoRoot, 'apps/client'),
      url: `http://localhost:${CLIENT_PORT}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { RICH4_API_TARGET: `http://127.0.0.1:${SERVER_PORT}` },
    },
  ],
});
