// 调试：与 e2e/playwright.original.config.ts 相同的原版皮肤 E2E 环境（合成素材包 + 口令门禁），但换端口与构建目录
// （3131 / 5191、.cache/w3-a11/*），可与其他代理同时跑的原版 E2E 并存。W3_SPECS=e2e 时跑 e2e/specs 里的
// skin-classic-dialogs.spec.ts，否则跑 test/w3-a11-*.spec.ts（截图写到 .cache/w3-shots，不入库）。
import { scryptSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const SERVER_PORT = 3131;
const CLIENT_PORT = 5191;
const DIST = join(repoRoot, '.cache', 'w3-a11', 'dist');
const PACK_DIR = join(repoRoot, '.cache', 'w3-a11', 'pack');
const PASSCODE = 'w3-a11-passcode';
const SALT = Buffer.from('rich4-w3-a11-salt');
const N = 1 << 14;
const HASH = [
  'scrypt',
  N,
  8,
  1,
  SALT.toString('base64url'),
  scryptSync(PASSCODE.normalize('NFC'), SALT, 32, { N, r: 8, p: 1 }).toString('base64url'),
].join(':');
process.env.RICH4_E2E_PASSCODE = PASSCODE;
process.env.RICH4_E2E_SKIN = process.env.W3_PACK_DIR ? '' : 'original';

const e2e = process.env.W3_SPECS === 'e2e';

export default defineConfig({
  testDir: e2e ? join(repoRoot, 'e2e', 'specs') : here,
  testMatch: e2e ? new RegExp(`(${process.env.W3_MATCH ?? 'skin-classic-dialogs'})\\.spec\\.ts$`) : /w3-a11-.*\.spec\.ts$/,
  outputDir: join(repoRoot, '.cache', 'w3-a11', 'results'),
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1920, height: 1080 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  webServer: [
    {
      command: `npm run --silent extract -- assets synth --out .cache/w3-a11/pack && npx tsx apps/server/src/main.ts`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${SERVER_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 480_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        RICH4_TEST_MODE: '1',
        PORT: String(SERVER_PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        LOG_PRETTY: '0',
        PUBLIC_URL: `http://localhost:${CLIENT_PORT}`,
        DATA_DIR: mkdtempSync(join(tmpdir(), 'rich4-w3-a11-')),
        RICH4_ASSETS_DIR: PACK_DIR,
        ACCESS_MODE: 'passcode',
        ACCESS_PASSCODE_HASH: HASH,
        ACCESS_SECRET: 'rich4-w3-a11-secret-0123456789abcdef0123456789',
      },
    },
    {
      command: `npx vite build --logLevel warn --outDir ${DIST} --emptyOutDir && npx vite preview --outDir ${DIST} --port ${CLIENT_PORT} --strictPort`,
      cwd: join(repoRoot, 'apps/client'),
      url: `http://localhost:${CLIENT_PORT}/`,
      reuseExistingServer: false,
      timeout: 480_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { RICH4_API_TARGET: `http://127.0.0.1:${SERVER_PORT}` },
    },
  ],
});
