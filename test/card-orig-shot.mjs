// 调试脚本（卡片取证）：把 .cache/card/orig/ 下的 HTML 拼图截成 PNG（Playwright，本地 file://）
// 用法：node test/card-orig-shot.mjs sheet.html sheet.png [宽]
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
const [html, png, width = '1100'] = process.argv.slice(2);
const dir = '.cache/card/orig';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: Number(width), height: 800 } });
await page.goto(`file://${resolve(dir, html)}`);
await page.waitForLoadState('networkidle');
await page.screenshot({ path: `${dir}/${png}`, fullPage: true });
await browser.close();
console.log(`${dir}/${png}`);
