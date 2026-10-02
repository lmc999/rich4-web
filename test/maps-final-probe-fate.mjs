// 调试脚本（集成阶段）：在集成服务（5815 → 3815）上开一局，把本人送到命运格抽指定命运，逐 200ms 记录弹窗与状态，
// 用来确认巡检脚本里命运弹窗 / 被关状态的判定方式。用法：node test/maps-final-probe-fate.mjs [china] [12]
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const MAP = process.argv[2] ?? 'china';
const FATE = Number(process.argv[3] ?? 12);
const BASE = 'http://localhost:5815';
const STAGE = { taiwan: 0, china: 1, japan: 2, usa: 3 };
const def = JSON.parse(readFileSync(`rich4-data/maps/${MAP}.map.json`, 'utf8'));
const fates = def.tiles.filter((t) => t.kind === 'fate').map((t) => t.id);
let path = null;
for (const t of def.tiles) {
  const o = t.links.filter((l) => !l.blocked).map((l) => l.to);
  if (o.length === 2 && fates.includes(o[0]) !== fates.includes(o[1])) {
    const f = o.find((x) => fates.includes(x));
    path = { node: t.id, prev: o.find((x) => x !== f), fate: f };
    break;
  }
}
console.log('path', path);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => {
  localStorage.setItem('rich4.introSeen', '1');
  localStorage.setItem('rich4.settings', JSON.stringify({ state: { nickname: '探针', skin: 'original' }, version: 2 }));
});
const page = await context.newPage();
const tid = (id) => page.locator(`[data-testid="${id}"]`);
await page.goto(`${BASE}/?audio=off&test=1`);
await tid('home-create').click();
await tid(`setup-stage-${STAGE[MAP]}`).click();
await tid('set-timer').selectOption('off');
await tid('set-ai-count').selectOption('3');
await tid('set-pacing').selectOption('compact');
await tid('create-submit').click();
await page.waitForURL(/\/r\/\d{6}/);
await tid('char-3').click();
await page.waitForTimeout(500);
await tid('room-start').click();
await tid('fly').waitFor();
await tid('fly-skip').click();
await tid('screen-game').waitFor();
const idle = () =>
  page.waitForFunction(() => {
    const h = window.__rich4;
    const d = h?.store?.game?.getState().decision;
    return d?.kind === 'TURN_MENU' && h.eventPlayer.idle;
  }, undefined, { timeout: 120_000 });
await idle();
const dbg = async (op) => {
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  console.log('debug', op.op, JSON.stringify(r));
  await page.waitForTimeout(600);
};
await dbg({ op: 'stackDeck', deck: 'fate', ids: [FATE] });
await dbg({ op: 'teleport', seat: 0, node: path.node, prev: path.prev });
await dbg({ op: 'forceNext', purpose: 'dice', values: [1] });
await idle();
await page.evaluate(() => {
  const h = window.__rich4;
  const d = h.store.game.getState().decision;
  return h.client.act({ type: 'ROLL' }, d.decisionId);
});
for (let i = 0; i < 60; i++) {
  const s = await page.evaluate(() => {
    const h = window.__rich4;
    const g = h.store.game.getState();
    const p = g.latest.players[0];
    const pops = document.querySelectorAll('[data-testid="fate-popup"], [data-testid="popup"], [data-testid^="popup-"]');
    return {
      t: Date.now() % 100000,
      node: p.node,
      st: p.st,
      pops: [...pops].map((e) => `${e.getAttribute('data-testid')}:${e.getAttribute('data-kind') ?? e.getAttribute('data-fate') ?? ''}`),
      idle: h.eventPlayer.idle,
      logTail: g.log.slice(-3).map((l) => `${l.type}|${l.text.slice(0, 30)}`),
    };
  });
  console.log(JSON.stringify(s));
  if (i === 8) await page.screenshot({ path: '.cache/maps/final/smoke/probe-fate.png' });
  await page.waitForTimeout(250);
}
await browser.close();
