// 调试：沿用原版皮肤 E2E 的服务器配置，只跑 test/w3-*.spec.ts（截图写到 .cache/w3-shots，不入库）。
// W3_PACK_DIR 指向真实素材包时 fixture 地图没有原版棋盘绑定，不做「原版棋盘」断言。
import base from '../e2e/playwright.original.config';

if (process.env.W3_PACK_DIR) process.env.RICH4_E2E_SKIN = '';

export default { ...base, testDir: '.', testMatch: /w3-.*\.spec\.ts$/, outputDir: '../.cache/w3-results' };
