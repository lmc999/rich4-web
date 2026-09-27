// 调试（A12 第一组场所屏）：与 e2e/playwright.original.config.ts 相同的服务器配置（合成素材包 + 口令门禁），但换成
// 自己的端口（3167 / 5231）、构建目录与合成包目录，不与同时在跑的其他 E2E 抢端口、不覆盖共享的 .cache/synthetic-pack。
// 用法：CI=1 [W3_INTEGRATE=1] npx playwright test -c test/w3-venues-a.config.ts [skin-classic-venues-a | w3-venues-a-shots]
//   W3_PACK_DIR=rich4-assets：截图用例改用本机真实素材包（page.route 提供，截图只写 .cache/w3-shots）
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../e2e/playwright.original.config';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const SERVER_PORT = 3167;
const CLIENT_PORT = 5231;
// W3_INTEGRATE=1：客户端用 test/w3-venues-a.vite.config.ts 构建（在内存里接入原版股市与原版开奖演出）
const INTEGRATE = process.env.W3_INTEGRATE === '1';
const DIST = join(repoRoot, '.cache', 'w3-venues-a', INTEGRATE ? 'dist-int' : 'dist');
const VITE_CONFIG = INTEGRATE ? ` --config ${join(repoRoot, 'test', 'w3-venues-a.vite.config.ts')}` : '';
const PACK_DIR = join(repoRoot, '.cache', 'w3-venues-a-pack');
const [server, client] = base.webServer as [Record<string, unknown>, Record<string, unknown>];
const serverEnv = server.env as Record<string, string>;

if (process.env.W3_PACK_DIR) process.env.RICH4_E2E_SKIN = '';

export default {
  ...base,
  testDir: '..',
  // W3_ALL=1：跑全部 e2e/specs（回归：银行股市、回合菜单等在原版场所屏下是否照常）
  testMatch:
    process.env.W3_ALL === '1'
      ? [/e2e\/specs\/.*\.spec\.ts$/]
      : [/e2e\/specs\/skin-classic-venues-a\.spec\.ts$/, /test\/w3-venues-a-.*\.spec\.ts$/],
  outputDir: join(repoRoot, '.cache', 'w3-venues-a', 'results'),
  use: { ...base.use, baseURL: `http://localhost:${CLIENT_PORT}` },
  webServer: [
    {
      ...server,
      command: `npm run --silent extract -- assets synth --out .cache/w3-venues-a-pack && npx tsx apps/server/src/main.ts`,
      url: `http://127.0.0.1:${SERVER_PORT}/healthz`,
      env: {
        ...serverEnv,
        PORT: String(SERVER_PORT),
        PUBLIC_URL: `http://localhost:${CLIENT_PORT}`,
        DATA_DIR: mkdtempSync(join(tmpdir(), 'rich4-w3-venues-a-')),
        RICH4_ASSETS_DIR: PACK_DIR,
      },
    },
    {
      ...client,
      command: `npx vite build${VITE_CONFIG} --logLevel warn --outDir ${DIST} --emptyOutDir && npx vite preview${VITE_CONFIG} --outDir ${DIST} --port ${CLIENT_PORT} --strictPort`,
      url: `http://localhost:${CLIENT_PORT}/`,
      env: { RICH4_API_TARGET: `http://127.0.0.1:${SERVER_PORT}` },
    },
  ],
};
