// 调试（复审修复）：中央决策倒计时在各场景 / 布局下的摆放目视截图 + 与场景文字、可见按钮的矩形求交。
// 真实素材包，台湾图（原版皮肤只认原版地图；场所节点见下），计时 slow（回合菜单里有时间逐个开场景）。截图与记录写到 .cache/pc/fix/<tag>/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；端口 3801 / 5801）：
//   PORT=3801 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5801 TRUST_PROXY=0 RICH4_ASSETS_ALLOW_UNGATED=1 \
//   RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_TEST_MODE=1 DATA_DIR=.cache/pc/fix-data \
//   npx tsx apps/server/src/main.ts
//   （apps/client）RICH4_API_TARGET=http://127.0.0.1:3801 npx vite --port 5801 --strictPort
// 用法：node test/fix-cd-shots.mjs [宽x高=1920x1080] [--skin=original|procedural] [--tag=名字] [--only=步骤,…]
//   原版步骤：stock,board,info,save,trustee,bank,shop,lottery,magic,auction（缺省全部）
//   程序化步骤：dock,buy,bank,auction
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.FIX_BASE ?? 'http://localhost:5801';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const TAG = args.find((a) => a.startsWith('--tag='))?.slice(6) ?? `${SKIN}-${size[0]}x${size[1]}`;
const DEF =
  SKIN === 'original'
    ? 'stock,board,info,save,trustee,bank,shop,lottery,magic,auction'
    : 'dock,buy,bank,auction';
const ONLY = (args.find((a) => a.startsWith('--only='))?.slice(7) ?? DEF).split(',');
const OUT = `.cache/pc/fix/${TAG}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, skin: SKIN, shots: [] };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const mobile = size[0] < 1000;

async function newPage(name) {
  const ctx = await browser.newContext({
    viewport: { width: size[0], height: size[1] },
    deviceScaleFactor: 1,
    ...(mobile && name === 'P1' ? { hasTouch: true } : {}),
  });
  await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  if (SKIN !== 'original') {
    await ctx.addInitScript((skin) => {
      const k = 'rich4.settings';
      try {
        const cur = JSON.parse(localStorage.getItem(k) ?? 'null');
        if (!cur) localStorage.setItem(k, JSON.stringify({ state: { skin }, version: 2 }));
      } catch {}
    }, SKIN);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { ctx, page, errors, name };
}

const A = await newPage('P1');
const B = await newPage('P2');
const pa = A.page;
const pb = B.page;
let shotN = 0;

/** 倒计时的矩形、摆放，与 root 里文字（逐个文本节点的实际字形矩形）、可见按钮的交叠 */
async function measure(rootSel) {
  return pa.evaluate((sel) => {
    const cd = document.querySelector('[data-testid="decision-countdown"]');
    if (!cd) return { countdown: null };
    const r = cd.getBoundingClientRect();
    const box = [r.x, r.y, r.width, r.height].map(Math.round);
    const hit = (b) => {
      const ix = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const iy = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      return ix > 0.5 && iy > 0.5 ? [Math.round(ix), Math.round(iy)] : null;
    };
    const root = sel ? document.querySelector(sel) : document.body;
    const texts = [];
    const buttons = [];
    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const txt = n.textContent?.trim();
        if (!txt || cd.contains(n)) continue;
        const el = n.parentElement;
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
        if (el.closest('[aria-hidden="true"]') && !el.closest('[data-sprite]')) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const b of range.getClientRects()) {
          const h = hit(b);
          if (h) texts.push({ text: txt.slice(0, 20), tag: el.tagName, hit: h });
        }
      }
      for (const el of root.querySelectorAll('button, [role="button"], input, select')) {
        if (cd.contains(el)) continue;
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const h = hit(b);
        if (h) buttons.push({ id: el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.tagName, hit: h });
      }
    }
    return {
      countdown: {
        box,
        place: cd.getAttribute('data-place'),
        anchor: cd.getAttribute('data-anchor'),
        secs: cd.getAttribute('data-secs'),
        urgent: cd.getAttribute('data-urgent'),
        visible: getComputedStyle(cd).visibility,
        left: cd.style.left,
        top: cd.style.top,
      },
      texts,
      buttons,
    };
  }, rootSel);
}

async function shot(name, rootSel = null) {
  shotN++;
  await pa.waitForTimeout(250);
  const file = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  await pa.screenshot({ path: file });
  const m = await measure(rootSel);
  report.shots.push({ name, file, ...m });
  log(
    `shot ${file} cd=${JSON.stringify(m.countdown)} texts=${JSON.stringify(m.texts ?? [])} buttons=${JSON.stringify(m.buttons ?? [])}`,
  );
  return m;
}

async function state(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const room = h?.store?.room?.getState().room;
    const d = g?.decision;
    return {
      seq: g?.seq ?? 0,
      idle: h?.eventPlayer?.idle ?? false,
      seat: room?.you?.seat ?? null,
      decision: d ? { kind: d.kind, id: d.decisionId, deadlineAt: d.deadlineAt } : null,
      submitting: g?.submitting ?? null,
      control: room && room.you?.seat != null ? (room.seats[room.you.seat]?.control ?? null) : null,
    };
  });
}

async function debug(page, op) {
  const s0 = (await state(page)).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
}

async function act(page) {
  await page.evaluate(() => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(d.defaultIntent, d.decisionId) : null;
  });
}

async function driveB() {
  const st = await state(pb);
  if (!st.idle || !st.decision || st.submitting !== null) return;
  await act(pb);
}

async function waitDecision(page, kinds, timeout = 120_000, other = null) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await state(page);
    if (st.idle && st.decision && st.submitting === null && kinds.includes(st.decision.kind)) return st;
    if (other) await other();
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: `${OUT}/fail-${kinds[0]}.png` }).catch(() => {});
  throw new Error(`wait ${kinds} timeout: ${JSON.stringify(await state(page))}`);
}

const myTurn = () =>
  waitDecision(pa, ['TURN_MENU'], 180_000, async () => {
    await driveB();
    const s = await state(pa);
    if (s.idle && s.decision && s.submitting === null && s.decision.kind !== 'TURN_MENU') await act(pa);
  });

async function remainingA() {
  return pa.evaluate(() => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    const off = h.store.connection?.getState().clockOffsetMs ?? 0;
    return d?.deadlineAt ? d.deadlineAt - (Date.now() + off) : null;
  });
}

async function waitRemainingBelow(ms) {
  for (;;) {
    const r = await remainingA();
    if (r === null || r <= ms) return r;
    await pa.waitForTimeout(Math.max(20, Math.min(400, r - ms)));
  }
}

async function rollA() {
  const s0 = (await state(pa)).seq;
  await pa.getByTestId('action-roll').click({ timeout: 5000 }).catch(() => {});
  await pa.waitForTimeout(1200);
  const s1 = await state(pa);
  if (s1.seq === s0 && s1.decision?.kind === 'TURN_MENU' && s1.submitting === null) await act(pa);
}

async function finishTurnA() {
  for (let i = 0; i < 10; i++) {
    await pa.waitForTimeout(400);
    const st = await state(pa);
    if (!st.decision) return;
    if (st.decision.kind === 'TURN_MENU' && st.submitting === null) return;
    if (st.idle && st.submitting === null) await act(pa);
  }
}

/** 本人回合：传送到 node（来路 prev）、强制掷出 dice，掷骰后等 kinds 决策 */
async function stepTo(node, prev, dice, kinds) {
  await myTurn();
  const seat = (await state(pa)).seat;
  await debug(pa, { op: 'teleport', seat, node, prev });
  await debug(pa, { op: 'forceNext', purpose: 'dice', values: [dice] });
  await myTurn();
  await rollA();
  return waitDecision(pa, kinds, 30_000);
}

async function closeScene(sel) {
  await pa.keyboard.press('Escape');
  await pa.waitForTimeout(400);
  if (sel && (await pa.locator(sel).count()) > 0) {
    await pa.keyboard.press('Escape');
    await pa.waitForTimeout(400);
  }
}

// ── 建房：P1 建台湾图 slow / compact、不补电脑；P2 进房 ──
await pa.goto(`${BASE}/?test=1`);
await pa.getByTestId('home-nickname').fill('測試甲');
await pa.getByTestId('home-nickname').blur();
await pa.getByTestId('home-create').click();
await pa.getByTestId('set-map').selectOption('taiwan');
await pa.getByTestId('set-timer').selectOption('slow');
await pa.getByTestId('set-pacing').selectOption('compact');
await pa.getByTestId('set-ai-count').selectOption('0');
await pa.getByTestId('create-submit').click();
await pa.waitForURL(/\/r\/\d{6}/);
const code = /\/r\/(\d{6})/.exec(pa.url())[1];
log(`room ${code}`);
await pb.goto(`${BASE}/?test=1`);
await pb.getByTestId('home-nickname').fill('測試乙');
await pb.getByTestId('home-nickname').blur();
await pb.goto(`${BASE}/r/${code}?test=1`);
await pb.getByTestId('screen-room').waitFor();
await pa.getByTestId('char-2').click();
if ((await pa.getByTestId('screen-room').getAttribute('data-screen')) !== 'select') await pa.getByTestId('char-select').click();
await pb.getByTestId('char-9').click();
if ((await pb.getByTestId('screen-room').getAttribute('data-screen')) !== 'select') await pb.getByTestId('char-select').click();
await pb.getByTestId('room-ready').click();
await pa.waitForTimeout(500);
await pa.getByTestId('room-start').click();
await pa.getByTestId('screen-game').waitFor({ timeout: 60_000 });
const seatA = (await state(pa)).seat;
const seatB = (await state(pb)).seat;
log(`seats A=${seatA} B=${seatB}`);

if (SKIN === 'original') {
  await myTurn();
  await pa.waitForTimeout(1500);
  await shot('center', '[data-testid="classic-stage"]');
  if (ONLY.includes('stock')) {
    await pa.getByTestId('action-stock').click();
    await pa.getByTestId('turn-stock-sheet').waitFor();
    await shot('stock', '[data-testid="turn-stock-sheet"]');
    await pa.getByTestId('stock-pick-0').click();
    await pa.waitForTimeout(300);
    await shot('stock-trade', '[data-testid="turn-stock-sheet"]');
    await closeScene('[data-testid="turn-stock-sheet"]');
  }
  if (ONLY.includes('board')) {
    await pa.getByTestId('action-board').click();
    await pa.getByTestId('board-panel').waitFor({ state: 'attached' });
    await shot('board', '[data-venue="bulletin"]');
    await pa.getByTestId('board-sell').click();
    await pa.getByTestId('board-kinds').waitFor({ state: 'attached' });
    await shot('board-kinds', '[data-venue="bulletin"]');
    const kind = pa.locator('[data-testid^="board-kind-"]:not([disabled]):not([data-testid="board-kind-close"])').first();
    if ((await kind.count()) > 0) {
      await kind.click();
      await pa.getByTestId('board-table').waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
      await shot('board-table', '[data-venue="bulletin"]');
    }
    await closeScene('[data-venue="bulletin"]');
    await closeScene('[data-venue="bulletin"]');
  }
  if (ONLY.includes('info')) {
    await pa.getByTestId('action-info').click();
    await pa.getByTestId('classic-assets').waitFor({ timeout: 5000 }).catch(() => {});
    await shot('info', '[data-testid="classic-assets"]');
    await closeScene('[data-testid="classic-assets"]');
  }
  if (ONLY.includes('save')) {
    for (const mode of ['save', 'load']) {
      await pa.getByTestId(`tool-${mode}`).click();
      const ok = await pa
        .getByTestId('classic-saves')
        .waitFor({ timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        await shot(mode, '[data-testid="classic-saves"]');
        await closeScene('[data-testid="classic-saves"]');
      } else log(`${mode}: 没有打开 classic-saves`);
    }
  }
  if (ONLY.includes('trustee')) {
    const box = await pa.getByTestId('action-autopilot').boundingBox();
    await pa.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await pa.mouse.down();
    await pa.waitForTimeout(800);
    await pa.mouse.up();
    const ok = await pa
      .getByTestId('trustee-dialog')
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (ok) {
      await shot('trustee', '[data-testid="trustee-dialog"]');
      await closeScene('[data-testid="trustee-dialog"]');
    } else log('trustee: 没有打开');
  }
  // 最后 10 秒的股市（小牌放大、变红）
  if (ONLY.includes('stock')) {
    const r = await remainingA();
    if (r !== null && r > 11_000) {
      await pa.getByTestId('action-stock').click();
      await pa.getByTestId('turn-stock-sheet').waitFor();
      await waitRemainingBelow(9_600);
      await shot('stock-urgent', '[data-testid="turn-stock-sheet"]');
      await closeScene('[data-testid="turn-stock-sheet"]');
    }
  }
  await rollA();
  await finishTurnA();

  if (ONLY.includes('bank')) {
    // 56（来路 55）掷 1 → 19 银行
    const d = await stepTo(56, 55, 1, ['BANK_ATM', 'BANK_COUNTER']);
    await pa.waitForTimeout(800);
    await shot(`bank-${d.decision.kind}`, `[data-testid="decision-${d.decision.kind}"]`);
    await act(pa);
    const d2 = await waitDecision(pa, ['BANK_COUNTER', 'TURN_MENU'], 15_000).catch(() => null);
    if (d2?.decision.kind === 'BANK_COUNTER') {
      await pa.waitForTimeout(800);
      await shot('bank-counter', '[data-testid="decision-BANK_COUNTER"]');
      await act(pa);
    }
    await finishTurnA();
  }
  if (ONLY.includes('shop')) {
    await myTurn();
    await debug(pa, { op: 'setPoints', seat: seatA, points: 500 });
    // 90（来路 91）掷 1 → 8 百货
    await stepTo(90, 91, 1, ['SHOP']);
    await pa.waitForTimeout(800);
    await shot('shop', '[data-testid="decision-SHOP"]');
    await act(pa);
    await finishTurnA();
  }
  if (ONLY.includes('lottery')) {
    // 52（来路 51）掷 1 → 20 乐透
    await stepTo(52, 51, 1, ['LOTTERY']);
    await pa.waitForTimeout(800);
    await shot('lottery', '[data-testid="decision-LOTTERY"]');
    await act(pa);
    await finishTurnA();
  }
  if (ONLY.includes('magic')) {
    await myTurn();
    await debug(pa, { op: 'setCash', seat: seatB, cash: 900000, deposit: null });
    await debug(pa, { op: 'forceNext', purpose: 'magicCond', values: [3] });
    // 96（来路 95）掷 1 → 7 魔法屋
    await stepTo(96, 95, 1, ['MAGIC_CAST']);
    await pa.waitForTimeout(800);
    await shot('magic', '[data-testid="decision-MAGIC_CAST"]');
    await act(pa);
    await finishTurnA();
  }
}

if (SKIN !== 'original') {
  await myTurn();
  await pa.waitForTimeout(1500);
  await shot('center', 'body');
  if (ONLY.includes('dock')) {
    await pa.getByTestId('top-log').click();
    await pa.getByTestId('top-chat').click();
    await pa.waitForTimeout(500);
    await shot('dock-open', 'body');
    await waitRemainingBelow(9_600);
    await shot('dock-open-urgent', 'body');
    await pa.getByTestId('top-log').click();
    await pa.getByTestId('top-chat').click();
  }
  await rollA();
  await finishTurnA();
  if (ONLY.includes('buy')) {
    // 58（来路 59）掷 1 → 57 L17
    await stepTo(58, 59, 1, ['BUY_LAND', 'UPGRADE_LAND']);
    await pa.waitForTimeout(800);
    await shot('buyland', '[data-testid="decision-layer"]');
    await act(pa);
    await finishTurnA();
  }
  if (ONLY.includes('bank')) {
    const d = await stepTo(56, 55, 1, ['BANK_ATM', 'BANK_COUNTER']);
    await pa.waitForTimeout(800);
    await shot(`bank-${d.decision.kind}`, '[data-testid="decision-layer"]');
    await waitRemainingBelow(2_400);
    await shot('bank-last3', '[data-testid="decision-layer"]');
    await act(pa);
    await finishTurnA();
  }
  if (ONLY.includes('menu')) {
    await myTurn();
    await pa.getByTestId('action-cards').click();
    await pa.waitForTimeout(800);
    await shot('menu-open', 'body');
    await pa.keyboard.press('Escape');
    await rollA();
    await finishTurnA();
  }
}

if (ONLY.includes('auction')) {
  // P2 的回合：站到无主的 L20（节点 60），拿拍卖卡（8），经测试钩子出卡 → P1 被问竞拍
  await waitDecision(pb, ['TURN_MENU'], 180_000, async () => {
    const s = await state(pa);
    if (s.idle && s.decision && s.submitting === null) await act(pa);
  });
  await debug(pb, { op: 'setCash', seat: seatA, cash: 80000, deposit: null });
  await debug(pb, { op: 'teleport', seat: seatB, node: 60, prev: 18 });
  await debug(pb, { op: 'give', seat: seatB, cards: [8], items: [] });
  await waitDecision(pb, ['TURN_MENU']);
  const used = await pb.evaluate(() => {
    const h = window.__rich4;
    const dd = h.store.game.getState().decision;
    const row = dd.options.cards.find((r) => r.card === 8);
    const tg = row.targets;
    const target =
      tg.t === 'underfoot'
        ? { t: 'underfoot', facility: null }
        : tg.t === 'lot'
          ? { t: 'lot', lot: tg.lots[0], facility: null }
          : { t: 'none' };
    return h.client.act({ type: 'USE_CARD', slot: row.slot, card: 8, target }, dd.decisionId);
  });
  log(`use auction card: ${JSON.stringify(used)}`);
  await waitDecision(pa, ['AUCTION_BID'], 30_000);
  await pa.waitForTimeout(900);
  await shot('auction', SKIN === 'original' ? '[data-testid="decision-AUCTION_BID"]' : '[data-testid="decision-layer"]');
  await waitRemainingBelow(2_400);
  await shot('auction-last3', SKIN === 'original' ? '[data-testid="decision-AUCTION_BID"]' : '[data-testid="decision-layer"]');
}

log(`errors A: ${JSON.stringify(A.errors.slice(0, 10))}`);
log(`errors B: ${JSON.stringify(B.errors.slice(0, 10))}`);
writeFileSync(`${OUT}/log.txt`, `${LOG.join('\n')}\n`);
writeFileSync(`${OUT}/result.json`, `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
