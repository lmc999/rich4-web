// w2 调试：真实素材包台湾图（test/w2-play-dev.sh），本人托管，逐回合记录镜头中心、跟随座位与当前行动者位置，
// 查「轮到你了」时镜头没有对准本人的问题。用法：node test/w2-follow-probe.mjs [回合数]
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5419';
const PASS = readFileSync('.cache/w3/passcode.txt', 'utf8').trim();
const N = Number(process.argv[2] ?? 12);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await ctx.request.post(`${BASE}/api/access`, { data: { passcode: PASS } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${BASE}/?test=1&audio=off`);
await page.getByTestId('home-nickname').fill('鏡頭');
await page.getByTestId('home-nickname').blur();
await page.getByTestId('home-create').click();
await page.getByTestId('set-map').selectOption('taiwan');
await page.getByTestId('set-timer').selectOption('normal');
await page.getByTestId('set-ai-count').selectOption('3');
await page.getByTestId('create-submit').click();
await page.waitForURL(/\/r\/\d{6}/);
await page.getByTestId('room-start').click();
await page.getByTestId('screen-game').waitFor();
await page.waitForFunction(() => window.__rich4?.client?.board?.stage, undefined, { timeout: 60_000 });
await page.evaluate(() => window.__rich4.client.autopilot(true));
let last = '';
const t0 = Date.now();
while (Date.now() - t0 < N * 20_000) {
  const s = await page.evaluate(() => {
    const h = window.__rich4;
    const g = h.store.game.getState();
    const r = h.renderer;
    const cam = r.camera;
    const ctrl = h.client.board;
    const cur = g.view?.clock.cursor;
    const seat = cur?.t === 'seat' ? cur.seat : null;
    const a = seat === null ? null : r.anchorPos({ seat });
    const c = cam.center;
    return {
      turn: g.view?.clock.turnNo,
      seat,
      followed: ctrl.followed,
      rFollow: r.followSeat ?? null,
      paused: cam.followPaused,
      animating: cam.camera?.animating ?? cam.animating ?? null,
      dist: a ? Math.round(Math.hypot(a.x - c.x, a.y - c.y)) : null,
      idle: h.eventPlayer.idle,
      ev: ctrl.stage?.currentEvent?.type ?? null,
    };
  });
  const k = `${s.turn}|${s.seat}|${s.idle}`;
  if (k !== last) {
    last = k;
    console.log(JSON.stringify(s));
  }
  await page.waitForTimeout(400);
}
await browser.close();
