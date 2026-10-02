// 调试脚本（T3）：两名真人。房主跳过飞行动画后立刻掷骰；另一人还在看飞行动画——他那边的事件回放暂缓（批次入队不播），
// 跳过后接着播。对着本机 5813 → 3813。用法：node test/maps-t3-two.mjs
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
async function player(nick) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((n) => {
    localStorage.setItem('rich4.introSeen', '1');
    localStorage.setItem('rich4.settings', JSON.stringify({ state: { nickname: n, skin: 'original' }, version: 2 }));
  }, nick);
  const page = await context.newPage();
  return page;
}
const tid = (p, id) => p.locator(`[data-testid="${id}"]`);
const a = await player('房主');
const b = await player('客人');
await a.goto('http://localhost:5813/?audio=off&test=1');
await tid(a, 'home-create').click();
await tid(a, 'setup-stage-3').click();
await tid(a, 'set-timer').selectOption('off');
await tid(a, 'create-submit').click();
await a.waitForURL(/\/r\/\d{6}/);
const code = /\/r\/(\d{6})/.exec(a.url())[1];
await b.goto(`http://localhost:5813/r/${code}?audio=off&test=1`);
await tid(b, 'screen-room').waitFor();
await tid(a, 'char-1').click();
await tid(b, 'char-2').click();
await b.waitForTimeout(500);
await tid(b, 'room-ready').click();
await a.waitForTimeout(500);
await tid(a, 'room-start').click();
await tid(a, 'fly').waitFor();
await tid(b, 'fly').waitFor();
console.log(`两人都在播：房主醒目=${await tid(a, 'fly-skip').getAttribute('data-urgent')} 客人醒目=${await tid(b, 'fly-skip').getAttribute('data-urgent')}`);
const vb = await b.evaluate(() => {
  const v = document.querySelector('[data-testid="fly-video"]');
  return v ? { t: v.currentTime, paused: v.paused, hidden: document.hidden } : null;
});
console.log(`客人的视频：${JSON.stringify(vb)}`);
await tid(a, 'fly-skip').click();
await tid(a, 'screen-game').waitFor();
await a.waitForTimeout(300);
// 房主掷骰（DOM 备用按钮）
const roll = tid(a, 'action-roll');
if (await roll.count()) await roll.click();
else console.log('房主没有 action-roll 按钮');
await b.waitForTimeout(600);
const st = await b.evaluate(() => ({
  held: window.__rich4.client.player.held,
  queued: window.__rich4.client.player.queued,
  fly: !!document.querySelector('[data-testid="fly"]'),
}));
console.log(`房主掷骰后客人：${JSON.stringify(st)}`);
if (await tid(b, 'fly').count()) await tid(b, 'fly-skip').click();
await b.waitForFunction(() => window.__rich4.client.player.idle, null, { timeout: 30_000 });
console.log(`客人跳过后：held=${await b.evaluate(() => window.__rich4.client.player.held)} 空闲=${await b.evaluate(() => window.__rich4.client.player.idle)}`);
await browser.close();
