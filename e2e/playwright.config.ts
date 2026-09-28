// Playwright E2E（design/client.md §12.2；architecture §8）：
// - webServer 启动 RICH4_TEST_MODE=1 的服务器（端口 3100，开放 debug:act）与 Vite（端口 5174，/socket.io 与 /api 代理到 3100；
//   用 build + preview 而不是 dev server，避免 HMR 整页刷新打断多页面测试）；
// - 浏览器用本机 Google Chrome（channel 'chrome'），不下载新浏览器；
// - 页面 URL 带 ?anim=instant&audio=off；点击一律走 DOM 备用按钮（data-testid），不点画布坐标。
//
// 远程模式（architecture M11 验证 3、4）：设置 E2E_BASE_URL（例如 https://localhost）时对着已部署的实例跑——
// 不启动 webServer，baseURL 用它，忽略证书错误（Caddy 内部 CA 的自签证书）；/socket.io、/api 与前端同源，夹具与用例
// 只用相对路径，不碰端口。实例需要 RICH4_TEST_MODE=1（debug:act）；开着访问门禁时另设 E2E_PASSCODE（fixtures/access.ts）。
// 重启恢复用例 specs/deploy-restart.spec.ts 另需 E2E_RESTART_CMD。
// 用法：E2E_BASE_URL=https://localhost npm run test:e2e -- e2e/specs/turn-cycle.spec.ts e2e/specs/reconnect.spec.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { E2E_REMOTE } from './fixtures/remote';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
export const SERVER_PORT = 3100;
export const CLIENT_PORT = 5174;
const reuse = !process.env.CI;

/** 远程实例的站点源（E2E_BASE_URL，见 fixtures/remote.ts）；null 为本机模式 */
const REMOTE = E2E_REMOTE;

/** 本机模式的两个 webServer（远程模式不启动，也不建临时数据目录） */
function localServers(): NonNullable<PlaywrightTestConfig['webServer']> {
  return [
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
  ];
}

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
    baseURL: REMOTE ?? `http://localhost:${CLIENT_PORT}`,
    // 远程实例常见的是 Caddy 内部 CA（SITE_ADDRESS=localhost）签的证书
    ...(REMOTE ? { ignoreHTTPSErrors: true } : {}),
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  ...(REMOTE ? {} : { webServer: localServers() }),
});
