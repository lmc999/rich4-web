// 调试（第三波整合）：复现用的小 spec（test/w3-repro*.spec.ts），服务器与端口同 w3-a14-default.config.ts（3140/5204）。
// 用法：CI=1 npx playwright test -c test/w3-repro.config.ts
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import base from './w3-a14-default.config';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export default { ...base, testDir: join(root, 'test'), testMatch: /w3-repro.*\.spec\.ts$/ };
