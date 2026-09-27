// 调试用：小游戏截图（不入 CI）。用法：npx playwright test -c test/mg-shots/playwright.config.ts
import { defineConfig } from '@playwright/test';
import base from '../../e2e/playwright.config';

export default defineConfig({ ...base, testDir: '.', outputDir: process.env.MG_SHOTS_OUT ?? '/tmp/mg-shots-out' });
