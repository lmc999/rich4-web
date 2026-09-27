// w2 调试：真实素材包台湾图（test/w2-play-dev.sh），开局后给本人陷害卡与路障，走经典外壳 DOM 出卡，逐步截图定位卡住的一步。
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5419';
const OUT = '.cache/w3/card-probe';
const PASS = readFileSync('.cache/w3/passcode.txt', 'utf8').trim();
const [w, h] = (process.argv[2] ?? '1920x1080').split('x').map(Number);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: w, height: h } });
await ctx.request.post(`${BASE}/api/access`, { data: { passcode: PASS } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text()));
await page.goto(`${BASE}/?test=1&audio=off`);
await page.getByTestId('home-nickname').fill('出卡');
await page.getByTestId('home-nickname').blur();
await page.getByTestId('home-create').click();
await page.getByTestId('set-map').selectOption('taiwan');
await page.getByTestId('set-timer').selectOption('off');
await page.getByTestId('set-ai-count').selectOption('3');
await page.getByTestId('create-submit').click();
await page.waitForURL(/\/r\/\d{6}/);
await page.getByTestId('room-start').click();
await page.getByTestId('screen-game').waitFor();
const menu = () =>
  page.waitForFunction(
    () => {
      const hh = window.__rich4;
      const g = hh?.store?.game?.getState();
      return hh?.eventPlayer.idle && g?.decision?.kind === 'TURN_MENU' && g.submitting === null;
    },
    undefined,
    { timeout: 60_000 },
  );
await menu();
const s0 = await page.evaluate(() => window.__rich4.store.game.getState().seq);
await page.evaluate(() => window.__rich4.client.debug({ op: 'give', seat: 0, cards: [17], items: [{ item: 2, qty: 1 }] }));
await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0);
await menu();
const slot = await page.evaluate(
  () => window.__rich4.store.game.getState().decision.options.cards.find((r) => r.card === 17)?.slot,
);
console.log('slot', slot);
const step = async (name, fn) => {
  try {
    await fn();
    console.log('ok', name);
  } catch (e) {
    console.log('FAIL', name, e.message.split('\n')[0]);
    await page.screenshot({ path: `${OUT}-${w}-${name}.png` });
    throw e;
  }
};
await step('open', () => page.getByTestId('action-cards').click({ timeout: 5000 }));
await page.screenshot({ path: `${OUT}-${w}-sheet.png` });
await step('card', () => page.getByTestId(`inv-card-${slot}`).click({ timeout: 5000 }));
await step('picker', () => page.getByTestId('target-picker').waitFor({ timeout: 5000 }));
await page.screenshot({ path: `${OUT}-${w}-picker.png` });
await step('target', () => page.getByTestId('target-actor-seat-1').click({ timeout: 5000 }));
await step('confirm', () => page.getByTestId('target-confirm').click({ timeout: 5000 }));
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}-${w}-after.png` });
await browser.close();
