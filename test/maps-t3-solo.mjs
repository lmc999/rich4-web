// 调试脚本（T3）：原版标题「单机对战」→ 单机页建房开局 → 房间页播飞行动画（单机页留下的记号），跳过后刷新不重播。
// 对着本机 5813 → 3813；截图写到 .cache/maps/t3-shots/solo-*.png。用法：node test/maps-t3-solo.mjs
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => {
  localStorage.setItem('rich4.introSeen', '1');
  if (!localStorage.getItem('rich4.settings'))
    localStorage.setItem('rich4.settings', JSON.stringify({ state: { nickname: 'T3单机', skin: 'original' }, version: 2 }));
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const tid = (id) => page.locator(`[data-testid="${id}"]`);
await page.goto('http://localhost:5813/?audio=off&test=1');
await tid('home-solo').click();
await page.waitForURL(/\/r\/\d{6}/, { timeout: 30_000 });
const fly = await tid('fly').waitFor({ timeout: 20_000 }).then(() => true, () => false);
const src = fly ? await tid('fly-video').getAttribute('src') : null;
const map = await page.evaluate(() => window.__rich4.store.room.getState().room?.settings.game.mapId);
console.log(`单机开局：地图 ${map}，飞行动画 ${fly ? `播放 ${src}` : '没有播'}`);
await page.waitForTimeout(1500);
await page.screenshot({ path: '.cache/maps/t3-shots/solo-1-fly.png' });
if (fly) await tid('fly-skip').click();
await page.reload();
await tid('screen-game').waitFor({ timeout: 30_000 });
await page.waitForTimeout(2000);
console.log(`刷新后：${(await tid('fly').count()) === 0 ? '不播（正确）' : '又播了（错误）'}`);
console.log(`页面错误：${errors.length ? errors.join(' | ') : '无'}`);
await browser.close();
