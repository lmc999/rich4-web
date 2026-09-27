// 调试（A13）：小游戏原版视图目视截图用的 Playwright 配置。独立端口（3417 / 5417）与构建目录（.cache/w3-mg-dist），
// 不与 E2E 配置冲突；服务器不挂素材包也不设门禁，素材包由页面 route 提供（W3_PACK_DIR，缺省合成包）。
// 截图只写到 .cache/w3-mg/shots（真实素材截图绝不入库）。
// 用法：W3_PACK_DIR=rich4-assets npx playwright test -c test/w3-mg-playwright.config.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const SERVER_PORT = 3417;
const CLIENT_PORT = 5417;
const DIST = join(repoRoot, '.cache', 'w3-mg-dist');

export default defineConfig({
  testDir: '.',
  testMatch: /w3-mg-shot\.spec\.ts$/,
  outputDir: join(repoRoot, '.cache', 'w3-mg', 'results'),
  timeout: 300_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    channel: 'chrome',
    headless: true,
    trace: 'off',
    screenshot: 'off',
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
        DATA_DIR: mkdtempSync(join(tmpdir(), 'rich4-w3mg-')),
      },
    },
    {
      command: `npx vite build --logLevel warn --outDir ${DIST} --emptyOutDir && npx vite preview --outDir ${DIST} --port ${CLIENT_PORT} --strictPort`,
      cwd: join(repoRoot, 'apps/client'),
      url: `http://localhost:${CLIENT_PORT}/`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { RICH4_API_TARGET: `http://127.0.0.1:${SERVER_PORT}` },
    },
  ],
});
