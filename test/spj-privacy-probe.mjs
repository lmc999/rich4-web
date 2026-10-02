// 调研：联机时对手能看到别人的哪些卡片 / 道具（本机两名真人 + 2 电脑，原版皮肤，台湾图）。
// 两种房间各走一遍：public（当前默认）与 private（room:updateSettings{handVisibility:'private'}，大厅没有这个选项）。
// 开局后用 debug:act give 给 P1 发卡与道具，然后从 P2 的页面读：
//   1. P2 本地 view 里 P1 的 cards / items / cardCount；
//   2. P2 收到的 socket 帧里与卡片、道具有关的事件（CARD_GAINED / ITEM_GAINED / DEBUG_APPLIED 的 post.players、post.pools）；
//   3. 截图：P2 点左栏 P1 的座位再点工具列「查询」（放大镜）打开的原版资产表。
// 另外在 private 房里用 pools 前后差推算 P1 拿到的卡（验证 pools 泄露）。
// 输出：.cache/spj/privacy/<mode>-*.png、<mode>-probe.json（含原版素材，不入库）。
// 用法：服务器与前端先起在 6012/4012（RICH4_TEST_MODE=1），然后 node test/spj-privacy-probe.mjs [public|private|both]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.PRIV_BASE ?? 'http://localhost:6012';
const OUT = '.cache/spj/privacy';
mkdirSync(OUT, { recursive: true });
const which = process.argv[2] ?? 'both';
const MODES = which === 'both' ? ['public', 'private'] : [which];
const Q = 'audio=off&test=1&anim=instant';

const P1_CARDS = [13, 18, 1]; // 抢夺、复仇、均富
const P1_ITEMS = [
  { item: 8, qty: 9 }, // 遥控骰子 ×9
  { item: 2, qty: 2 }, // 路障 ×2
  { item: 10, qty: 1 }, // 时光机
];

/** 选中查看对象：左栏座位条可见时点它，否则直接设 uiStore.inspectSeat（同一个动作） */
async function inspect(page, seat) {
  const chip = page.getByTestId(`chip-${seat}`);
  if (await chip.isVisible().catch(() => false)) await chip.click();
  else await page.evaluate((s) => window.__rich4.store.ui.getState().setInspectSeat(s), seat);
}

const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

async function newPage(browser, nickname) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  const frames = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      const t = typeof f.payload === 'string' ? f.payload : '';
      if (/CARD_|ITEM_|SHOP_|DEBUG_APPLIED|"pools"/.test(t)) frames.push(t);
    });
  });
  await page.goto(`${BASE}/?${Q}`);
  await page.getByTestId('home-nickname').fill(nickname);
  await page.getByTestId('home-nickname').blur();
  return { ctx, page, errors, frames };
}

const idle = (page) =>
  page.waitForFunction(
    () => {
      const h = window.__rich4;
      return !!h?.store?.game && h.store.game.getState().view !== null && h.eventPlayer.idle;
    },
    undefined,
    { timeout: 90_000 },
  );

async function runMode(browser, mode) {
  log(`== mode ${mode}`);
  const p1 = await newPage(browser, 'P1甲');
  const p2 = await newPage(browser, 'P2乙');
  await p1.page.getByTestId('home-create').click();
  await p1.page.getByTestId('set-map').selectOption('taiwan');
  await p1.page.getByTestId('set-timer').selectOption('off');
  await p1.page.getByTestId('set-ai-count').selectOption('2');
  await p1.page.getByTestId('create-submit').click();
  await p1.page.waitForURL(/\/r\/\d{6}/);
  const code = /\/r\/(\d{6})/.exec(p1.page.url())[1];
  log(`room ${code}`);
  if (mode === 'private') {
    const r = await p1.page.evaluate(() => window.__rich4.client.updateSettings({ handVisibility: 'private' }));
    log(`updateSettings private: ${JSON.stringify(r)}`);
  }
  await p1.page.getByTestId('char-9').click();
  await p2.page.goto(`${BASE}/r/${code}?${Q}`);
  await p2.page.getByTestId('screen-room').waitFor();
  await p2.page.getByTestId('char-3').click();
  await p2.page.getByTestId('room-ready').click();
  await p1.page.getByTestId('room-start').waitFor();
  await p1.page.waitForFunction(() => !document.querySelector('[data-testid="room-start"]')?.disabled);
  await p1.page.getByTestId('room-start').click();
  for (const p of [p1, p2]) {
    await p.page.getByTestId('screen-game').waitFor({ timeout: 90_000 });
    await idle(p.page);
  }
  const seatOf = (pg) => pg.evaluate(() => window.__rich4.store.room.getState().room.you.seat);
  const s1 = await seatOf(p1.page);
  const s2 = await seatOf(p2.page);
  const settings = await p1.page.evaluate(() => window.__rich4.store.room.getState().room.settings.handVisibility);
  log(`seats P1=${s1} P2=${s2} handVisibility=${settings}`);

  const poolsBefore = await p2.page.evaluate(() => window.__rich4.store.game.getState().view.pools);
  const seq0 = await p1.page.evaluate(() => window.__rich4.store.game.getState().seq);
  const give = await p1.page.evaluate(
    (o) => window.__rich4.client.debug({ op: 'give', seat: o.seat, cards: o.cards, items: o.items }),
    { seat: s1, cards: P1_CARDS, items: P1_ITEMS },
  );
  log(`give: ${JSON.stringify(give)}`);
  // P2 也给一点，看 P1 能否看到
  await p1.page.evaluate((seat) => window.__rich4.client.debug({ op: 'give', seat, cards: [26], items: [] }), s2);
  for (const p of [p1, p2]) {
    await p.page.waitForFunction((s) => window.__rich4.store.game.getState().seq >= s + 2, seq0);
    await idle(p.page);
  }
  const probe = (pg, seat) =>
    pg.evaluate((s) => {
      const v = window.__rich4.store.game.getState().view;
      const p = v.players.find((x) => x.seat === s);
      return { cards: p.cards, cardCount: p.cardCount, items: p.items, points: p.points };
    }, seat);
  const p2SeesP1 = await probe(p2.page, s1);
  const p1SeesP2 = await probe(p1.page, s2);
  const p1Self = await probe(p1.page, s1);
  const poolsAfter = await p2.page.evaluate(() => window.__rich4.store.game.getState().view.pools);
  // pools 差推算 P1 拿到的卡（P2 视角）
  const inferred = [];
  if (poolsBefore && poolsAfter) {
    poolsBefore.cards.forEach((n, id) => {
      const d = n - (poolsAfter.cards[id] ?? 0);
      for (let k = 0; k < d; k++) inferred.push(id);
    });
  }
  log(`P2 sees P1: ${JSON.stringify(p2SeesP1)}`);
  log(`P1 sees P2: ${JSON.stringify(p1SeesP2)}`);
  log(`P2 infers cards drawn from pools diff: ${JSON.stringify(inferred)}`);
  // P1 持有抢夺卡（13）：把 P1、P2 传送到同一格（开局还没人落地，范围内没有对手），
  // 再看 TURN_MENU 选项里的抢夺候选（范围内对手的手牌与道具，只发给 P1）
  const seqT = await p1.page.evaluate(() => window.__rich4.store.game.getState().seq);
  const node = Number(process.env.PRIV_NODE ?? 10);
  for (const seat of [s1, s2]) {
    const r = await p1.page.evaluate((o) => window.__rich4.client.debug({ op: 'teleport', seat: o.seat, node: o.node }), {
      seat,
      node,
    });
    log(`teleport seat ${seat} → ${node}: ${JSON.stringify(r)}`);
  }
  // 传送不重发回合菜单；再发一张卡，回合菜单按新位置重发
  await p1.page.evaluate((seat) => window.__rich4.client.debug({ op: 'give', seat, cards: [2], items: [] }), s1);
  await p1.page.waitForFunction((s) => window.__rich4.store.game.getState().seq >= s + 3, seqT).catch(() => {});
  await idle(p1.page);
  const robTargets = await p1.page.evaluate(() => {
    const d = window.__rich4.store.game.getState().decision;
    if (d?.kind !== 'TURN_MENU') return { decision: d?.kind ?? null };
    const row = d.options.cards.find((r) => r.card === 13);
    return row ? { usable: row.usable, reason: row.reason, targets: row.targets } : { row: null };
  });
  log(`P1 rob-card targets in TURN_MENU options: ${JSON.stringify(robTargets)}`);

  // 截图：P2 点 P1 的座位，再点工具列「查询」
  await inspect(p2.page, s1);
  await p2.page.getByTestId('action-info').click();
  await p2.page.getByTestId('classic-assets').waitFor({ timeout: 15_000 }).catch(() => log('classic-assets not shown'));
  await p2.page.waitForTimeout(800);
  await p2.page.screenshot({ path: `${OUT}/${mode}-p2-views-p1-assets.png` });
  const assetDom = await p2.page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-testid^="assets-item-"]')].map(
      (e) => `${e.getAttribute('data-testid')}×${e.getAttribute('data-count')}`,
    );
    const cards = [...document.querySelectorAll('[data-testid^="assets-card-"]')].map((e) => e.textContent);
    return { items, cards };
  });
  log(`P2 asset sheet DOM: ${JSON.stringify(assetDom)}`);
  await p2.page.keyboard.press('Escape');
  // P1 视角看 P2（对照）
  await inspect(p1.page, s2);
  await p1.page.getByTestId('action-info').click();
  await p1.page.getByTestId('classic-assets').waitFor({ timeout: 15_000 }).catch(() => log('classic-assets not shown'));
  await p1.page.waitForTimeout(800);
  await p1.page.screenshot({ path: `${OUT}/${mode}-p1-views-p2-assets.png` });
  await p1.page.keyboard.press('Escape');

  const res = {
    mode,
    room: code,
    seats: { p1: s1, p2: s2 },
    handVisibility: settings,
    p2SeesP1,
    p1SeesP2,
    p1Self,
    inferredFromPools: inferred,
    robTargets,
    assetDom,
    // P2 收到的相关帧（截断）
    p2Frames: p2.frames.map((f) => f.slice(0, 2000)),
    errors: { p1: p1.errors, p2: p2.errors },
  };
  writeFileSync(`${OUT}/${mode}-probe.json`, `${JSON.stringify(res, null, 2)}\n`);
  await p1.page.evaluate(() => window.__rich4.client.leaveRoom()).catch(() => {});
  await p2.page.evaluate(() => window.__rich4.client.leaveRoom()).catch(() => {});
  await p1.ctx.close();
  await p2.ctx.close();
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const m of MODES) await runMode(browser, m);
} finally {
  await browser.close();
}
