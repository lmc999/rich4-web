// 调试脚本（T3）：量开局飞行动画层里 <video> 的实际摆放（是否按 4:3 留黑边、有没有被裁切），对着本机 5813 → 3813。
// 用法：node test/maps-t3-fly-measure.mjs [宽 高]
import { chromium } from '@playwright/test';

const [w, h] = [Number(process.argv[2] ?? 812), Number(process.argv[3] ?? 375)];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: w, height: h } });
await context.addInitScript(() => {
  localStorage.setItem('rich4.introSeen', '1');
  localStorage.setItem('rich4.settings', JSON.stringify({ state: { nickname: 'T3量', skin: 'original' }, version: 2 }));
});
const page = await context.newPage();
const tid = (id) => page.locator(`[data-testid="${id}"]`);
await page.goto('http://localhost:5813/?audio=off&test=1');
await tid('home-create').click();
await tid('setup-stage-2').click();
await tid('set-timer').selectOption('off');
await tid('set-ai-count').selectOption('3');
await tid('create-submit').click();
await page.waitForURL(/\/r\/\d{6}/);
await tid('char-2').click();
await page.waitForTimeout(500);
await tid('room-start').click();
await tid('fly-video').waitFor();
await page.waitForTimeout(1500);
const m = await page.evaluate(() => {
  const v = document.querySelector('[data-testid="fly-video"]');
  const r = v.getBoundingClientRect();
  const cs = getComputedStyle(v);
  return { rect: [r.x, r.y, r.width, r.height].map(Math.round), fit: cs.objectFit, vw: v.videoWidth, vh: v.videoHeight };
});
console.log(JSON.stringify(m));
await page.screenshot({ path: `.cache/maps/t3-shots/measure-fly-${w}x${h}.png` });
await browser.close();
