// 审查（原版忠实度，只读）：把本地 HTML 拼图截成 PNG（Playwright 自带 Chromium）。
// 用法：node test/card-review-fid-shot.mjs <html 相对仓库根> <输出 png> [宽=1200]
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const [src, out, w = '1200'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: Number(w), height: 800 }, deviceScaleFactor: 1 });
await page.goto(`file://${resolve(src)}`);
await page.waitForLoadState('networkidle');
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('ok', out);
