// w2 调试：与 e2e/playwright.config.ts 相同，但换端口（3517 / 5517）与构建目录（.cache/w2/dist），
// 避免与同时在跑的其他 E2E 抢端口、互相覆盖 apps/client/dist。用法：
//   CI=1 npx playwright test -c test/w2-e2e.config.ts skin-classic-shell
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PORT = 3517;
const CLIENT_PORT = 5517;
const DIST = join(repoRoot, '.cache', 'w2', 'dist');

export default defineConfig({
  testDir: join(repoRoot, 'e2e', 'specs'),
  outputDir: join(repoRoot, '.cache', 'w2', 'e2e-results'),
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
        DATA_DIR: mkdtempSync(join(tmpdir(), 'rich4-w2-e2e-')),
      },
    },
    {
      command: `npx vite build --logLevel warn --outDir ${DIST} --emptyOutDir && npx vite preview --outDir ${DIST} --port ${CLIENT_PORT} --strictPort`,
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
