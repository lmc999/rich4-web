// 调试（第三波整合）：本机真实素材包 + 口令门禁的原版皮肤全流程巡检（test/w3-tour.spec.ts）。
// 服务器 :3519（RICH4_ASSETS_DIR=./rich4-assets、RICH4_DATA_DIR=./rich4-data、RICH4_TEST_MODE=1）+ 生产构建的 vite preview :5519；
// 口令 / 哈希 / 密钥事先由 scripts/access.ts 生成在 .cache/w3/{passcode,hash,secret}.txt（不入库）。
// 截图与日志只写 .cache/w3/tour-<tag>/（含原版素材，不入库）。
// 用法：W3_TAG=desk npx playwright test -c test/w3-tour.config.ts   （W3_TAG=mobile：房主 844×390、P2 1920×1080）
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HASH = readFileSync(join(root, '.cache/w3/hash.txt'), 'utf8').trim().split('\n').at(-1)!;
const SECRET = readFileSync(join(root, '.cache/w3/secret.txt'), 'utf8').trim().split('\n').at(-1)!;

export default defineConfig({
  testDir: join(root, 'test'),
  testMatch: /w3-tour\.spec\.ts$/,
  outputDir: join(root, '.cache', 'w3', `tour-results-${process.env.W3_TAG ?? 'desk'}`),
  timeout: 3_600_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5519',
    channel: 'chrome',
    headless: true,
    actionTimeout: 20_000,
    trace: 'off',
  },
  webServer: [
    {
      command: 'npx tsx apps/server/src/main.ts',
      cwd: root,
      url: 'http://127.0.0.1:3519/healthz',
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        PORT: '3519',
        HOST: '127.0.0.1',
        PUBLIC_URL: 'http://localhost:5519',
        LOG_LEVEL: 'warn',
        LOG_PRETTY: '0',
        RICH4_TEST_MODE: '1',
        DATA_DIR: join(root, '.cache/w3/tour-data'),
        RICH4_DATA_DIR: join(root, 'rich4-data'),
        RICH4_ASSETS_DIR: join(root, 'rich4-assets'),
        ACCESS_MODE: 'passcode',
        ACCESS_PASSCODE_HASH: HASH,
        ACCESS_SECRET: SECRET,
      },
    },
    {
      // 生产构建 + preview（与 E2E 相同）：巡检期间改前端源码不会触发 HMR 整页重载
      command: `npx vite build --logLevel warn --outDir ${join(root, '.cache/w3/tour-dist')} --emptyOutDir && npx vite preview --outDir ${join(root, '.cache/w3/tour-dist')} --port 5519 --strictPort`,
      cwd: join(root, 'apps/client'),
      url: 'http://localhost:5519',
      reuseExistingServer: true,
      timeout: 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { RICH4_API_TARGET: 'http://127.0.0.1:3519' },
    },
  ],
});
