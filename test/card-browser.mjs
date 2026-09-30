// 调研（出卡插画，只读）：起一个常驻的无头 Chrome（CDP 端口），开两个互相隔离的上下文 P1 / P2（1280×960），
// 供 test/card-drive.mjs 反复连上去操作（避免每一步都重开房间）。Ctrl-C / kill 结束。
// 用法：node test/card-browser.mjs [cdp 端口=9711] [站点=http://localhost:5711]
import { chromium } from '@playwright/test';

const PORT = Number(process.argv[2] ?? 9711);
const BASE = process.argv[3] ?? 'http://localhost:5711';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [`--remote-debugging-port=${PORT}`, '--autoplay-policy=no-user-gesture-required'],
});
for (const name of ['P1', 'P2']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?test=1&who=${name}`);
  await page.evaluate((n) => {
    window.name = n;
  }, name);
}
console.log(`cdp http://127.0.0.1:${PORT} ready`);
process.on('SIGTERM', async () => {
  await browser.close();
  process.exit(0);
});
await new Promise(() => {});
