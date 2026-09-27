// w2 调试：原版皮肤（合成素材包，test/w2-orig-servers.sh）下两人对局中依次离开，记录 room:leave 的回包与房间是否关闭。
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5184';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function player(nick) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1920, height: 1080 } });
  const r = await ctx.request.post('/api/access', { data: { passcode: 'e2e-original-skin-passcode' } });
  if (r.status() !== 200) throw new Error(`access ${r.status()}`);
  const page = await ctx.newPage();
  page.on('console', (m) => console.log(`[${nick} ${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[${nick} pageerror] ${e.message}`));
  await page.goto('/?anim=instant&audio=off&test=1');
  await page.getByTestId('home-nickname').fill(nick);
  await page.getByTestId('home-nickname').blur();
  return page;
}
const a = await player('P1');
const b = await player('P2');
await a.getByTestId('home-create').click();
await a.getByTestId('set-map').selectOption('test');
await a.getByTestId('set-timer').selectOption('off');
await a.getByTestId('set-ai-count').selectOption('1');
await a.getByTestId('create-submit').click();
await a.waitForURL(/\/r\/\d{6}/);
const code = /\/r\/(\d{6})/.exec(a.url())[1];
await b.goto(`/r/${code}?anim=instant&audio=off&test=1`);
await b.getByTestId('screen-room').waitFor();
for (const [p, ch] of [[a, 9], [b, 4]]) {
  await p.getByTestId(`char-${ch}`).click();
  await p.getByTestId('char-select').click();
}
await b.getByTestId('room-ready').click();
await a.getByTestId('room-start').click();
for (const p of [a, b]) await p.getByTestId('screen-game').waitFor();
await a.waitForTimeout(3000);
for (const [p, n] of [[b, 'P2'], [a, 'P1']]) {
  const res = await p.evaluate(async () => {
    const c = window.__rich4.client;
    const orig = c.req.bind(c);
    const out = [];
    c.req = async (ev, payload) => {
      const r = await orig(ev, payload);
      out.push({ ev, r });
      return r;
    };
    window.__probe = out;
    return c.roomCode ?? null;
  });
  console.log(n, 'roomCode', res);
  await p.getByTestId('top-menu').click();
  await p.getByTestId('menu-leave').click();
  await p.getByTestId('screen-home').waitFor();
  await p.waitForTimeout(500);
  console.log(n, 'probe', JSON.stringify(await p.evaluate(() => window.__probe)));
}
await b.goto(`/r/${code}?anim=instant&audio=off&test=1`);
await b.waitForTimeout(3000);
console.log('b after goto:', await b.evaluate(() => document.querySelector('[data-testid^="screen-"]')?.getAttribute('data-testid')));
await browser.close();
