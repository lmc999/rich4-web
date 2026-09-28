// 调试（中央倒计时改为始终正中央）：程序化布局 HUD 的实际几何——顶栏、右栏、底部行动区、决策层、中央倒计时的矩形，
// 用来确定「棋盘视口」的边界。两个真人（P2 另开页面，轮到自己时自动按默认应答），台湾图 slow 档。
// 先起本机服务（端口 3311 / 5311，见 test/center-cd-shots.mjs 文件头）。
// 用法：node test/center-cd-probe.mjs [宽x高=1280x800] [--skin=procedural|original]
import { chromium } from '@playwright/test';

const BASE = process.env.CD_BASE ?? 'http://localhost:5311';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x800').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'procedural';
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  if (SKIN !== 'original') {
    await ctx.addInitScript(() => {
      try {
        if (!localStorage.getItem('rich4.settings'))
          localStorage.setItem('rich4.settings', JSON.stringify({ state: { skin: 'procedural' }, version: 2 }));
      } catch {}
    });
  }
  return ctx.newPage();
}

const pa = await newPage();
const pb = await newPage();
await pa.goto(`${BASE}/?test=1`);
await pa.getByTestId('home-nickname').fill('甲');
await pa.getByTestId('home-nickname').blur();
await pa.getByTestId('home-create').click();
await pa.getByTestId('set-map').selectOption('taiwan');
await pa.getByTestId('set-timer').selectOption('slow');
await pa.getByTestId('set-ai-count').selectOption('0');
await pa.getByTestId('create-submit').click();
await pa.waitForURL(/\/r\/\d{6}/);
const code = /\/r\/(\d{6})/.exec(pa.url())[1];
await pb.goto(`${BASE}/?test=1`);
await pb.getByTestId('home-nickname').fill('乙');
await pb.getByTestId('home-nickname').blur();
await pb.goto(`${BASE}/r/${code}?test=1`);
await pb.getByTestId('screen-room').waitFor();
for (const [p, c] of [
  [pa, 2],
  [pb, 9],
]) {
  await p.getByTestId(`char-${c}`).click();
  if ((await p.getByTestId('screen-room').getAttribute('data-screen')) !== 'select') await p.getByTestId('char-select').click();
}
await pb.getByTestId('room-ready').click();
await pa.waitForTimeout(500);
await pa.getByTestId('room-start').click();
await pa.getByTestId('screen-game').waitFor({ timeout: 60_000 });

async function driveB() {
  await pb.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const d = g?.decision;
    if (h?.eventPlayer?.idle && d && g.submitting === null) h.client.act(d.defaultIntent, d.decisionId);
  });
}

for (let i = 0; i < 400; i++) {
  const ok = await pa.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    return !!g && h.eventPlayer.idle && g.decision?.kind === 'TURN_MENU' && g.submitting === null;
  });
  if (ok) break;
  await driveB();
  await pa.waitForTimeout(300);
}
await pa.waitForTimeout(1500);
const rects = await pa.evaluate(() => {
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return [b.left, b.top, b.right, b.bottom].map((v) => Math.round(v * 10) / 10);
  };
  return {
    win: [innerWidth, innerHeight],
    top: r('[data-testid="screen-game"] > div'),
    topBar: r('[data-testid="top-bar"]'),
    right: r('[data-testid="screen-game"] > aside'),
    actionPad: r('[data-testid="action-pad"]'),
    bottom: r('[data-testid="action-pad"]')?.length ? r('[data-testid="screen-game"] [data-testid="action-pad"]') : null,
    bottomWrap: (() => {
      const el = document.querySelector('[data-testid="action-pad"]')?.parentElement;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return [b.left, b.top, b.right, b.bottom];
    })(),
    countdown: r('[data-testid="decision-countdown"]'),
    layer: (() => {
      const el = document.querySelector('[data-testid="decision-countdown"]')?.parentElement;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return [b.left, b.top, b.right, b.bottom];
    })(),
    stage: r('[data-testid="classic-stage"]'),
  };
});
console.log(JSON.stringify(rects));
await pa.screenshot({ path: `.cache/cs/center/probe-${SKIN}-${size[0]}x${size[1]}.png` });
await browser.close();
