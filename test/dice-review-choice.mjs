// 审查用：回合菜单里先选骰子颗数、再做一次菜单操作（用道具），服务器按新状态重发 TURN_MENU（新 decisionId）后，
// 选过的颗数是否还在（原版点竖槽 / D 键立刻写玩家结构 +0x0A：exe 0x417a68 / 0x417a9a，之后用卡、道具不影响）。
// 服务：3941 / 5941（本机例外）。用法：node test/dice-review-choice.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.DICE_BASE ?? 'http://localhost:5941';
const OUT = '.cache/dice/review/choice';
mkdirSync(OUT, { recursive: true });
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${s}`);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 960 } });
await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
const page = await ctx.newPage();

async function state() {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const room = h?.store?.room?.getState().room;
    const d = g?.decision;
    return {
      seq: g?.seq ?? 0,
      idle: h?.eventPlayer?.idle ?? false,
      seat: room?.you?.seat ?? null,
      decision: d ? { kind: d.kind, id: d.decisionId, dice: d.options?.dice ?? null } : null,
      submitting: g?.submitting ?? null,
      players: (g?.view?.players ?? []).map((p) => ({ seat: p.seat, vehicle: p.vehicle, diceCount: p.diceCount })),
    };
  });
}
async function act(intent = null) {
  return page.evaluate((it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(it ?? d.defaultIntent, d.decisionId) : null;
  }, intent);
}
async function debug(op) {
  const s0 = (await state()).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
}
async function myTurn(timeout = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await state();
    if (st.idle && st.decision && st.submitting === null) {
      if (st.decision.kind === 'TURN_MENU') return st;
      await act();
    }
    await page.waitForTimeout(120);
  }
  throw new Error('myTurn timeout');
}
const slot = () =>
  page.evaluate(() => {
    const dc = document.querySelector('[data-testid="action-dice-count"]');
    return {
      value: dc?.getAttribute('data-value'),
      on: [...(dc?.querySelectorAll('[data-testid="dice-count-die"]') ?? [])].map((e) => e.getAttribute('data-on')),
      rollLabel: document.querySelector('[data-testid="action-roll"]')?.getAttribute('aria-label'),
    };
  });

await page.goto(`${BASE}/?test=1`);
await page.getByTestId('home-nickname').fill('審查丙');
await page.getByTestId('home-nickname').blur();
await page.getByTestId('home-create').click();
await page.getByTestId('set-map').selectOption('taiwan');
await page.getByTestId('set-timer').selectOption('off');
await page.getByTestId('set-ai-count').selectOption('1');
await page.getByTestId('create-submit').click();
await page.waitForURL(/\/r\/\d{6}/);
await page.getByTestId('char-2').click();
if ((await page.getByTestId('screen-room').getAttribute('data-screen')) !== 'select') await page.getByTestId('char-select').click();
await page.waitForTimeout(400);
await page.getByTestId('room-start').click();
await page.getByTestId('screen-game').waitFor({ timeout: 60_000 });
await page.waitForFunction(() => window.__rich4?.store?.game?.getState().view !== null && window.__rich4.eventPlayer.idle, null, { timeout: 60_000 });
await debug({ op: 'clearBoard' });
const report = {};
await myTurn();
await debug({ op: 'give', seat: (await state()).seat, cards: [], items: [{ item: 6, qty: 1 }, { item: 1, qty: 1 }] });
await myTurn();
await act({ type: 'USE_ITEM', item: 6, target: { t: 'none' } });
await page.waitForTimeout(2500);
const a = await myTurn();
report.afterCar = { decision: a.decision, slot: await slot() };
log(`afterCar ${JSON.stringify(report.afterCar)}`);
// 点竖槽第 1 个小骰子（选 1 颗）
const box = await page.getByTestId('action-dice-count').boundingBox();
const icons = await page.evaluate(() => [...document.querySelectorAll('[data-testid="dice-count-die"]')].map((e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }));
await page.mouse.click(icons[0].x, icons[0].y);
await page.waitForTimeout(300);
report.picked = { box, slot: await slot(), ui: await page.evaluate(() => { const u = window.__rich4?.store?.ui?.getState?.(); return u ? { diceChoice: u.diceChoice, diceChoiceFor: u.diceChoiceFor } : null; }) };
log(`picked ${JSON.stringify(report.picked)}`);
await page.screenshot({ path: `${OUT}/1-picked-1.png` });
// 菜单操作：用机器娃娃（非终结，服务器重发 TURN_MENU）
await act({ type: 'USE_ITEM', item: 1, target: { t: 'none' } });
await page.waitForTimeout(2500);
const b = await myTurn();
report.afterDoll = { decision: b.decision, slot: await slot() };
log(`afterDoll ${JSON.stringify(report.afterDoll)}`);
await page.screenshot({ path: `${OUT}/2-after-doll.png` });
// 按 GO，看掷了几颗
const events = [];
await page.exposeFunction('__reviewEv', (e) => events.push(e));
await page.evaluate(() => window.__rich4.client.transport.on('game:batch', (p) => { for (const e of p.events) if (e.type === 'DICE_ROLLED') window.__reviewEv({ dice: e.dice, diceCount: e.diceCount }); }));
await page.getByTestId('action-roll').click({ timeout: 5000 });
await page.waitForTimeout(3000);
report.rolled = events;
log(`rolled ${JSON.stringify(events)}`);
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
