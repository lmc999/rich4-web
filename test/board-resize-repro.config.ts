// 调试：棋盘画布在单次视口变化后卡在旧尺寸的复现（test/board-resize-repro.spec.ts），服务器与端口同默认 E2E 配置（3100/5174）。
// 用法：CI=1 npx playwright test -c test/board-resize-repro.config.ts
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../e2e/playwright.config';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export default { ...base, testDir: join(root, 'test'), testMatch: /board-resize-repro\.spec\.ts$/ };
