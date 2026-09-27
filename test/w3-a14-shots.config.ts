// 调试（A14）：截图目视用（截图只写 .cache/w3-shots，不入库）。服务器与端口同 w3-a14-default.config.ts。
// 用法：CI=1 W3_PACK_DIR=rich4-assets npx playwright test -c test/w3-a14-shots.config.ts
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import base from './w3-a14-default.config';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export default { ...base, testDir: join(root, 'test'), testMatch: /w3-a14-shots\.spec\.ts$/ };
