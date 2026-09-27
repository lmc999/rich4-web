// w2 调试：用本机 Chrome 打开 test/w2-dev.sh 起的开发服（真实素材包 + 口令门禁），建台湾图房间开局，
// 按给定视口截图到 .cache/w2（含原版素材，不入库）。用法：node test/w2-shot.mjs [宽x高 ...] [--clip x,y,w,h]
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.W2_BASE ?? 'http://localhost:5417';
const PASS = process.env.W2_PASS ?? 'w2-pass-4417';
const OUT = '.cache/w2';
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const sizes = args.filter((a) => /^\d+x\d+$/.test(a)).map((a) => a.split('x').map(Number));
if (sizes.length === 0) sizes.push([1920, 1080], [844, 390]);
const clipArg = args.find((a) => a.startsWith('--clip='));
const steps = args.find((a) => a.startsWith('--steps='))?.slice(8) ?? '';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const [w, h] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await ctx.request.post(`${BASE}/api/access`, { data: { passcode: PASS } });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[${w}x${h} ${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => console.log(`[${w}x${h} pageerror] ${e.message}`));
    await page.goto(`${BASE}/?audio=off`);
    await page.getByTestId('home-nickname').fill('測試者');
    await page.getByTestId('home-create').click();
    await page.getByTestId('set-map').selectOption('taiwan');
    await page.getByTestId('set-timer').selectOption('normal');
    await page.getByTestId('set-ai-count').selectOption('3');
    await page.getByTestId('create-submit').click();
    await page.waitForURL(/\/r\/\d{6}/);
    await page.getByTestId('char-9').click();
    await page.getByTestId('char-select').click();
    await page.getByTestId('room-start').click();
    await page.getByTestId('classic-stage').waitFor();
    await page.waitForTimeout(4000);
    for (const s of steps.split(',').filter(Boolean)) {
      if (s === 'roll') {
        await page.getByTestId('action-roll').click({ timeout: 60_000 });
        await page.waitForTimeout(1500);
      } else if (s.startsWith('tab-')) {
        await page.getByTestId(`classic-tab-${s.slice(4)}`).click();
      } else if (s.startsWith('clicknow-')) {
        await page.getByTestId(s.slice(9)).click({ timeout: 60_000 });
      } else if (s.startsWith('click-')) {
        await page.getByTestId(s.slice(6)).click();
        await page.waitForTimeout(600);
      } else if (s.startsWith('wait-')) {
        await page.waitForTimeout(Number(s.slice(5)));
      } else if (s.startsWith('shot-')) {
        await page.screenshot({ path: `${OUT}/shot-${w}x${h}-${s.slice(5)}.png` });
      }
    }
    const clip = clipArg ? clipArg.slice(7).split(',').map(Number) : null;
    await page.screenshot({
      path: `${OUT}/shot-${w}x${h}.png`,
      ...(clip ? { clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3] } } : {}),
    });
    console.log(`saved ${OUT}/shot-${w}x${h}.png`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
