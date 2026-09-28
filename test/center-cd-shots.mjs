// 调试（中央倒计时改为「始终在画面正中央」）：真实素材包，两个真人（P2 另开页面，轮到自己时自动按默认应答）以便有计时，
// 台湾图 slow 档。逐个场景截图，并量中央倒计时的中心与「画面正中」的偏差：原版为 640×480 舞台（classic-stage-inner）的
// 中心，程序化为棋盘视口（右栏以外、顶栏以下、行动区以上）的中心。截图与记录写到 .cache/cs/center/<tag>/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；端口 3311 / 5311）：
//   PORT=3311 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5311 TRUST_PROXY=0 RICH4_ASSETS_ALLOW_UNGATED=1 \
//   RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_TEST_MODE=1 DATA_DIR=.cache/cs/center-data \
//   npx tsx apps/server/src/main.ts
//   （apps/client）RICH4_API_TARGET=http://127.0.0.1:3311 npx vite --port 5311 --strictPort
// 用法：node test/center-cd-shots.mjs [宽x高=1920x1080] [--skin=original|procedural] [--tag=名字] [--only=步骤,…]
//   步骤：banner,roll,sizes,menu,stock,dock,urgent,buy,bank,magic,auction（缺省除 sizes 外全部；dock 只对程序化有意义；
//   sizes 为同一画面换几档字号的比较图）
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.CD_BASE ?? 'http://localhost:5311';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const TAG = args.find((a) => a.startsWith('--tag='))?.slice(6) ?? `${SKIN}-${size[0]}x${size[1]}`;
const ONLY = (
  args.find((a) => a.startsWith('--only='))?.slice(7) ?? 'banner,roll,menu,stock,dock,urgent,buy,bank,magic,auction'
).split(',');
const OUT = `.cache/cs/center/${TAG}`;
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

/** 倒计时中心与画面正中的偏差、字号、颜色；横幅（有的话）的矩形 */
async function measure() {
  return pa.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom };
    };
    const cd = document.querySelector('[data-testid="decision-countdown"]');
    const stage = document.querySelector('[data-testid="classic-stage-inner"]');
    let expect = null;
    if (stage) {
      const s = rect(stage);
      expect = { x: s.x + s.w / 2, y: s.y + s.h / 2, from: 'stage' };
    } else {
      const top = rect(document.querySelector('[data-testid="top-bar"]'));
      const right = rect(document.querySelector('[data-testid="screen-game"] > aside'));
      const pad = rect(document.querySelector('[data-testid="action-pad"]'));
      const left = document.querySelector('[data-testid="screen-game"]')?.getAttribute('data-left') === 'true';
      if (top && right && pad) {
        const x0 = left ? right.r : 0;
        const x1 = left ? innerWidth : right.x;
        expect = { x: (x0 + x1) / 2, y: (top.b + pad.y) / 2, from: 'viewport' };
      }
    }
    const banner = rect(document.querySelector('[data-testid="turn-banner"]'));
    if (!cd) return { countdown: null, expect, banner };
    const r = rect(cd);
    const cs = getComputedStyle(cd);
    const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const round = (v) => Math.round(v * 10) / 10;
    return {
      countdown: {
        center: [round(c.x), round(c.y)],
        box: [r.x, r.y, r.w, r.h].map(round),
        secs: cd.getAttribute('data-secs'),
        kind: cd.getAttribute('data-kind'),
        urgent: cd.getAttribute('data-urgent'),
        fontPx: cs.fontSize,
        color: cs.color,
        visible: cs.visibility,
        opacity: cs.opacity,
        layerParent: cd.parentElement?.parentElement?.tagName ?? null,
      },
      expect: expect && { x: round(expect.x), y: round(expect.y), from: expect.from },
      delta: expect ? [round(c.x - expect.x), round(c.y - expect.y)] : null,
      banner,
    };
  });
}

async function shot(name, wait = 250) {
  shotN++;
  if (wait) await pa.waitForTimeout(wait);
  const file = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  const m = await measure();
  await pa.screenshot({ path: file });
  if (m.countdown) {
    // 数字附近的局部放大（看描边在背景上是否清楚）
    const [cx, cy] = m.countdown.center;
    const w = Math.min(size[0], 420);
    const h = Math.min(size[1], 260);
    const x = Math.max(0, Math.min(size[0] - w, cx - w / 2));
    const y = Math.max(0, Math.min(size[1] - h, cy - h / 2));
    await pa.screenshot({ path: file.replace(/\.png$/, '.zoom.png'), clip: { x, y, width: w, height: h } });
  }
  report.shots.push({ name, file, ...m });
  log(`shot ${file} ${JSON.stringify(m)}`);
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

/** P2：轮到自己时按默认应答（只负责让对局走下去） */
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
  for (let i = 0; i < 12; i++) {
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

async function escape(times = 2) {
  for (let i = 0; i < times; i++) {
    await pa.keyboard.press('Escape');
    await pa.waitForTimeout(350);
  }
}

// ── 建房：P1 建台湾图 slow、不补电脑；P2 进房（两个真人才有计时） ──
await pa.goto(`${BASE}/?test=1`);
await pa.getByTestId('home-nickname').fill('測試甲');
await pa.getByTestId('home-nickname').blur();
await pa.getByTestId('home-create').click();
await pa.getByTestId('set-map').selectOption('taiwan');
await pa.getByTestId('set-timer').selectOption('slow');
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
const seatA = (await state(pa)).seat;
const seatB = (await state(pb)).seat;
log(`seats A=${seatA} B=${seatB}`);

// ── 「轮到你了」横幅与倒计时同时在画面上（横幅显示约 1 秒） ──
if (ONLY.includes('banner')) {
  const t0 = Date.now();
  let got = false;
  while (Date.now() - t0 < 180_000 && !got) {
    const both = await pa.evaluate(
      () =>
        !!document.querySelector('[data-testid="turn-banner"]') &&
        !!document.querySelector('[data-testid="decision-countdown"]'),
    );
    if (both) {
      await shot('banner', 0);
      got = true;
      break;
    }
    const st = await state(pa);
    if (st.decision?.kind === 'TURN_MENU' && st.idle && st.submitting === null) {
      // 已经错过这一回合的横幅：掷骰，等下一回合
      await rollA();
      await finishTurnA();
    } else {
      await driveB();
      if (st.idle && st.decision && st.submitting === null && st.decision.kind !== 'TURN_MENU') await act(pa);
    }
    await pa.waitForTimeout(40);
  }
  if (!got) log('banner: 没抓到横幅与倒计时同屏');
}

await myTurn();
await pa.waitForTimeout(1500);
if (ONLY.includes('roll')) await shot('roll');
if (ONLY.includes('sizes')) {
  // 字号比较：原版按 640×480 逻辑像素，程序化按 CSS 像素（同一画面，只换字号）
  const sizes = SKIN === 'original' ? [56, 64, 72] : mobile ? [48, 56, 64] : [80, 96, 108];
  for (const px of sizes) {
    const tag = await pa.addStyleTag({
      content: `[data-testid="decision-countdown"]{font-size:${px}px !important}`,
    });
    await shot(`size-${px}`, 150);
    await tag.evaluate((el) => el.remove());
  }
}
if (ONLY.includes('dock') && SKIN !== 'original') {
  await pa.getByTestId('top-log').click();
  await pa.getByTestId('top-chat').click();
  await shot('dock-open', 500);
  await pa.getByTestId('top-log').click();
  await pa.getByTestId('top-chat').click();
}
if (ONLY.includes('menu')) {
  // 原版：工具列的卡片钮展开回合菜单（手机横屏时侧栏收成抽屉，「回合選單」钮不可见）；程序化：行动区「更多」
  if (SKIN === 'original') await pa.locator('[data-testid="classic-toolbar"] [data-testid="action-cards"]').click();
  else await pa.getByTestId('action-menu').click();
  await shot('menu-open', 700);
  await escape(1);
}
if (ONLY.includes('stock')) {
  if (SKIN === 'original') await pa.locator('[data-testid="classic-toolbar"] [data-testid="action-stock"]').click();
  else await pa.getByTestId('action-stock').click();
  await pa.getByTestId('turn-stock-sheet').waitFor({ timeout: 8000 }).catch(() => log('stock: 没有 turn-stock-sheet'));
  await shot('stock', 700);
  await escape(2);
}
if (ONLY.includes('urgent')) {
  // 最后 10 秒：变红；最后 3 秒：双响档
  await waitRemainingBelow(9_500);
  await shot('urgent', 0);
  await waitRemainingBelow(2_600);
  await shot('final', 0);
}
await rollA();
await finishTurnA();

if (ONLY.includes('buy')) {
  // 58（来路 59）掷 1 → 57 L17（无主住宅：买地）
  const d = await stepTo(58, 59, 1, ['BUY_LAND', 'UPGRADE_LAND']);
  await shot(`buy-${d.decision.kind}`, 900);
  await act(pa);
  await finishTurnA();
}
if (ONLY.includes('bank')) {
  // 56（来路 55）掷 1 → 19 银行
  const d = await stepTo(56, 55, 1, ['BANK_ATM', 'BANK_COUNTER']);
  await shot(`bank-${d.decision.kind}`, 900);
  await act(pa);
  const d2 = await waitDecision(pa, ['BANK_COUNTER', 'TURN_MENU'], 15_000).catch(() => null);
  if (d2?.decision.kind === 'BANK_COUNTER') {
    await shot('bank-counter', 900);
    await act(pa);
  }
  await finishTurnA();
}
if (ONLY.includes('magic')) {
  await myTurn();
  await debug(pa, { op: 'setCash', seat: seatB, cash: 900000, deposit: null });
  await debug(pa, { op: 'forceNext', purpose: 'magicCond', values: [3] });
  // 96（来路 95）掷 1 → 7 魔法屋
  await stepTo(96, 95, 1, ['MAGIC_CAST']);
  await shot('magic', 900);
  await act(pa);
  await finishTurnA();
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
  await shot('auction', 900);
  await waitRemainingBelow(2_400);
  await shot('auction-last3', 0);
}

// 同一窗口下各场景的中心是否一致
const centers = report.shots.filter((x) => x.countdown).map((x) => x.countdown.center.join(','));
log(`centers: ${JSON.stringify([...new Set(centers)])}`);
log(`errors A: ${JSON.stringify(A.errors.slice(0, 10))}`);
log(`errors B: ${JSON.stringify(B.errors.slice(0, 10))}`);
writeFileSync(`${OUT}/log.txt`, `${LOG.join('\n')}\n`);
writeFileSync(`${OUT}/result.json`, `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
