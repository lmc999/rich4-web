// 调试（A14）：与 e2e/playwright.original.config.ts 相同的用例与服务器（合成素材包 + 口令门禁），只换端口与构建目录。
// 用法：CI=1 npx playwright test -c test/w3-a14-original.config.ts lobby turn-cycle
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaywrightTestConfig } from '@playwright/test';
import base from '../e2e/playwright.original.config';

const S = 3150;
const C = 5214;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(root, '.cache', 'w3-a14', 'dist-original');
const [server, client] = base.webServer as unknown as [Record<string, unknown>, Record<string, unknown>];

export default {
  ...base,
  testDir: join(root, 'e2e', 'specs'),
  outputDir: join(root, '.cache', 'w3-a14', 'results-original'),
  use: { ...base.use, baseURL: `http://localhost:${C}` },
  webServer: [
    {
      ...server,
      url: `http://127.0.0.1:${S}/healthz`,
      env: { ...(server.env as Record<string, string>), PORT: String(S), PUBLIC_URL: `http://localhost:${C}` },
    },
    {
      ...client,
      command: `npx vite build --logLevel warn --outDir ${DIST} --emptyOutDir && npx vite preview --outDir ${DIST} --port ${C} --strictPort`,
      url: `http://localhost:${C}/`,
      env: { RICH4_API_TARGET: `http://127.0.0.1:${S}` },
    },
  ],
} as PlaywrightTestConfig;
