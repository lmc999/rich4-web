// 调试（venues/b）：沿用原版皮肤 E2E 的服务器配置，但换端口与构建目录（3187 / 5287、.cache/w3b/dist），
// 避免和同时在跑的其他 E2E 抢端口；只跑 test/w3-venueb-*.spec.ts 与 e2e/specs/skin-classic-venues-b.spec.ts。
// W3_PACK_DIR 指向真实素材包时 fixture 地图没有原版棋盘绑定，不做「原版棋盘」断言。
import { join } from 'node:path';
import base from '../e2e/playwright.original.config';

if (process.env.W3_PACK_DIR) process.env.RICH4_E2E_SKIN = '';

const SERVER_PORT = 3187;
const CLIENT_PORT = 5287;
// biome-ignore lint/suspicious/noExplicitAny: 调试配置
const servers = (base.webServer as any[]).map((w) => ({ ...w }));
const dist = join(process.cwd(), '.cache', 'w3b', 'dist');
const pack = join(process.cwd(), '.cache', 'w3b', 'synth');
servers[0] = {
  ...servers[0],
  command: `npm run --silent extract -- assets synth --out .cache/w3b/synth && npx tsx apps/server/src/main.ts`,
  url: `http://127.0.0.1:${SERVER_PORT}/healthz`,
  reuseExistingServer: false,
  timeout: 420_000,
  env: {
    ...servers[0].env,
    PORT: String(SERVER_PORT),
    PUBLIC_URL: `http://localhost:${CLIENT_PORT}`,
    RICH4_ASSETS_DIR: pack,
  },
};
servers[1] = {
  ...servers[1],
  command: `npx vite build --logLevel warn --outDir ${dist} --emptyOutDir && npx vite preview --outDir ${dist} --port ${CLIENT_PORT} --strictPort`,
  url: `http://localhost:${CLIENT_PORT}/`,
  reuseExistingServer: false,
  timeout: 420_000,
  env: { RICH4_API_TARGET: `http://127.0.0.1:${SERVER_PORT}` },
};

export default {
  ...base,
  testDir: '..',
  // W3_MATCH：另跑别的原版皮肤用例（例如 events|skin-original-stage），核对它们在第二组原版场景下照样通过
  testMatch: process.env.W3_MATCH
    ? new RegExp(`e2e/specs/(${process.env.W3_MATCH})\\.spec\\.ts$`)
    : /(test\/w3-venueb-.*|e2e\/specs\/skin-classic-venues-b)\.spec\.ts$/,
  outputDir: '../.cache/w3b/results',
  use: { ...base.use, baseURL: `http://localhost:${CLIENT_PORT}` },
  webServer: servers,
};
