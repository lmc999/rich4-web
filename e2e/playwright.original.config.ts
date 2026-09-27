// 原版皮肤 E2E（original-skin.md §3 修正 6、§5 A8/A14）：与 playwright.config.ts 相同的用例，但服务器挂上合成素材包
// （`npm run extract -- assets synth` 现场生成到 .cache/synthetic-pack，全为自绘图形，不入库）并开启口令门禁——
// 启用素材包的服务器必须设门禁（§3 修正 3）。fixture 地图 test 在合成包里有绑定，对局页因此判定为原版皮肤：
// 经典布局（ui/classic）、原版棋盘（game/orig）、繁体界面；夹具经 RICH4_E2E_PASSCODE 在打开页面前注入 cookie。
// 换端口（3110 / 5184）与构建目录（.cache/e2e-original/dist），可与默认配置同时跑。
// 用法：CI=1 npx playwright test -c e2e/playwright.original.config.ts lobby turn-cycle cards events minigame reconnect save-load
import { scryptSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const SERVER_PORT = 3110;
const CLIENT_PORT = 5184;
const DIST = join(repoRoot, '.cache', 'e2e-original', 'dist');
const PACK_DIR = join(repoRoot, '.cache', 'synthetic-pack');
const reuse = !process.env.CI;

// 测试专用口令与密钥（只用于本机回环地址上的 E2E 服务器）。配置文件在 runner 与 worker 里各载入一次，
// 所以哈希用固定盐确定性生成：两边得到同一个口令。scrypt 取允许的最低一档（启动时会提示低于建议值），验证更快。
const PASSCODE = 'e2e-original-skin-passcode';
const SALT = Buffer.from('rich4-e2e-original-salt');
const N = 1 << 14;
const R = 8;
const P = 1;
const HASH = [
  'scrypt',
  N,
  R,
  P,
  SALT.toString('base64url'),
  scryptSync(PASSCODE.normalize('NFC'), SALT, 32, { N, r: R, p: P }).toString('base64url'),
].join(':');
process.env.RICH4_E2E_PASSCODE = PASSCODE;
process.env.RICH4_E2E_SKIN = 'original';

export default defineConfig({
  testDir: './specs',
  outputDir: join(repoRoot, 'test-results', 'e2e-original'),
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
    // 桌面 16:9：经典舞台两侧的联机侧栏整栏显示（1280×800 时收成抽屉，座位条等不可见）
    viewport: { width: 1920, height: 1080 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  webServer: [
    {
      command:
        'npm run --silent extract -- assets synth --out .cache/synthetic-pack && npx tsx apps/server/src/main.ts',
      cwd: repoRoot,
      url: `http://127.0.0.1:${SERVER_PORT}/healthz`,
      reuseExistingServer: reuse,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        RICH4_TEST_MODE: '1',
        PORT: String(SERVER_PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        LOG_PRETTY: '0',
        PUBLIC_URL: `http://localhost:${CLIENT_PORT}`,
        DATA_DIR: mkdtempSync(join(tmpdir(), 'rich4-e2e-orig-')),
        RICH4_ASSETS_DIR: PACK_DIR,
        ACCESS_MODE: 'passcode',
        ACCESS_PASSCODE_HASH: HASH,
        ACCESS_SECRET: 'rich4-e2e-original-skin-secret-0123456789abcdef',
      },
    },
    {
      command: `npx vite build --logLevel warn --outDir ${DIST} --emptyOutDir && npx vite preview --outDir ${DIST} --port ${CLIENT_PORT} --strictPort`,
      cwd: join(repoRoot, 'apps/client'),
      url: `http://localhost:${CLIENT_PORT}/`,
      reuseExistingServer: reuse,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { RICH4_API_TARGET: `http://127.0.0.1:${SERVER_PORT}` },
    },
  ],
});
