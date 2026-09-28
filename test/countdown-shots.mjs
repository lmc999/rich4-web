// 调试：中央决策倒计时的目视截图（原版皮肤 + 真实素材包 + 台湾图）。先起本机服务（端口 3401 / 5401，见下），再跑：
//   node test/countdown-shots.mjs [宽x高] [--tag=desk] [--only=turn,buy,bank,menu,auction] [--css=文件]（--css 注入候选样式做比较）
// 服务端（本机例外：未设门禁的素材包，只监听回环）：
//   PORT=3401 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5401 TRUST_PROXY=0 RICH4_ASSETS_ALLOW_UNGATED=1 \
//   RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_TEST_MODE=1 DATA_DIR=.cache/pc/countdown-data \
//   npx tsx apps/server/src/main.ts
//   （apps/client）RICH4_API_TARGET=http://127.0.0.1:3401 npx vite --port 5401 --strictPort
// 两个真人（P1 截图、P2 配合出拍卖卡）+ 2 个电脑，计时 fast、节奏 compact。截图写到 .cache/pc/countdown/<tag>/（含原版素材，不入库）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.CD_BASE ?? 'http://localhost:5401';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const TAG = args.find((a) => a.startsWith('--tag='))?.slice(6) ?? `${size[0]}x${size[1]}`;
const ONLY = (args.find((a) => a.startsWith('--only='))?.slice(7) ?? 'turn,menu,buy,bank,auction').split(',');
const CSS = args.find((a) => a.startsWith('--css='))?.slice(6) ?? null;
/** --skin=procedural：设置里选程序化皮肤（同一台服务器、同一素材包） */
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const OUT = `.cache/pc/countdown/${TAG}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  console.log(line);
  LOG.push(line);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const mobile = size[0] < 1000;

async function newPage(name) {
  const ctx = await browser.newContext({
    viewport: { width: size[0], height: size[1] },
    deviceScaleFactor: 1,
    ...(mobile && name === 'P1' ? { hasTouch: true, isMobile: false } : {}),
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
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  if (CSS) await page.addInitScript((css) => {
    document.addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.textContent = css;
      document.head.append(st);
    });
  }, readFileSync(CSS, 'utf8'));
  return { ctx, page, errors, name };
}

const A = await newPage('P1');
const B = await newPage('P2');
const pa = A.page;
const pb = B.page;

async function shot(name) {
  const file = `${OUT}/${name}.png`;
  await pa.screenshot({ path: file });
  log(`shot ${file}`);
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
      decision: d ? { kind: d.kind, id: d.decisionId, deadlineAt: d.deadlineAt, def: d.defaultIntent } : null,
      submitting: g?.submitting ?? null,
      offset: h?.store?.connection?.getState().clockOffsetMs ?? 0,
      cd: document.querySelector('[data-testid="decision-countdown"]')?.getAttribute('data-secs') ?? null,
    };
  });
}

async function debug(page, op) {
  const s0 = (await state(page)).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
}

async function waitDecision(page, kinds, timeout = 120_000, other = null) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await state(page);
    if (st.idle && st.decision && st.submitting === null && kinds.includes(st.decision.kind)) return st;
    if (other) await other();
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: `${OUT}/fail-${kinds[0]}.png` }).catch(() => {});
  throw new Error(`wait ${kinds} timeout: ${JSON.stringify(await state(page))}`);
}

/** P2 的决策一律按默认处理（掷骰 / 放弃） */
async function driveB() {
  const st = await state(pb);
  if (!st.idle || !st.decision || st.submitting !== null) return;
  await pb.evaluate(() => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return h.client.act(d.defaultIntent, d.decisionId);
  });
}

/** 掷骰：点 GO 钮（手机横屏上可能被横幅等挡住），没反应就经测试钩子提交回合菜单的默认 intent（掷骰） */
async function rollA() {
  const s0 = (await state(pa)).seq;
  await pa.getByTestId('action-roll').click({ timeout: 5000 }).catch(() => {});
  await pa.waitForTimeout(1500);
  const s1 = await state(pa);
  if (s1.seq === s0 && s1.decision?.kind === 'TURN_MENU' && s1.submitting === null) {
    log('  GO 钮没反应，改用 act(defaultIntent)');
    await answerA();
  }
}

async function answerA() {
  await pa.evaluate(() => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return h.client.act(d.defaultIntent, d.decisionId);
  });
}

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
    await pa.waitForTimeout(Math.min(500, r - ms));
  }
}

/** 等 P1 的回合菜单（期间替 P2 做决定） */
async function myTurn() {
  return waitDecision(pa, ['TURN_MENU'], 180_000, driveB);
}

/** 本人回合结束前的其他决策按默认处理 */
async function finishTurnA() {
  for (let i = 0; i < 8; i++) {
    await pa.waitForTimeout(400);
    const st = await state(pa);
    if (!st.decision) return;
    if (st.decision.kind === 'TURN_MENU' && st.submitting === null) return;
    if (st.idle && st.submitting === null) await answerA();
  }
}

// ── 建房：P1 建台湾图 fast / compact、2 个电脑；P2 进房 ──
await pa.goto(`${BASE}/?test=1`);
await pa.getByTestId('home-nickname').fill('測試甲');
await pa.getByTestId('home-nickname').blur();
await pa.getByTestId('home-create').click();
await pa.getByTestId('set-map').selectOption('taiwan');
await pa.getByTestId('set-timer').selectOption('fast');
await pa.getByTestId('set-pacing').selectOption('compact');
await pa.getByTestId('set-ai-count').selectOption('2');
await pa.getByTestId('create-submit').click();
await pa.waitForURL(/\/r\/\d{6}/);
const code = /\/r\/(\d{6})/.exec(pa.url())[1];
log(`room ${code}`);
await pb.goto(`${BASE}/?test=1`);
await pb.getByTestId('home-nickname').fill('測試乙');
await pb.getByTestId('home-nickname').blur();
await pb.goto(`${BASE}/r/${code}?test=1`);
await pb.getByTestId('screen-room').waitFor();

async function pick(page, id) {
  await page.getByTestId(`char-${id}`).click();
  await page.waitForTimeout(300);
  const txt = await page.getByTestId('char-select').textContent();
  if (!/^已(选择|選擇)$/.test(txt ?? '')) await page.getByTestId('char-select').click();
}
await pick(pa, 2);
await pick(pb, 9);
await pb.getByTestId('room-ready').click();
await pa.getByTestId('room-start').click();
await pa.getByTestId('screen-game').waitFor({ timeout: 60_000 });
await pa.waitForFunction((k) => window.__rich4?.skin?.boardInUse === k, SKIN, { timeout: 60_000 });
const seatA = (await state(pa)).seat;
const seatB = (await state(pb)).seat;
log(`seats A=${seatA} B=${seatB}`);

// ── 回合菜单：正常、最后 10 秒、展开回合菜单 ──
let st = await myTurn();
log(`turn menu ${st.decision.id}`);
if (ONLY.includes('turn')) {
  await pa.waitForTimeout(600);
  await shot('01-turn-normal');
  await waitRemainingBelow(9300);
  await pa.waitForTimeout(150);
  await shot('02-turn-last10');
  await waitRemainingBelow(2400);
  await pa.waitForTimeout(150);
  await shot('03-turn-last3');
  // 最后 1 秒多时掷骰：提交后倒计时立即消失（不让它超时——连续两次超时会进托管，后面的场景就不是本人操作了）
  await waitRemainingBelow(1500);
  await pa.getByTestId('action-roll').click();
  await pa.waitForTimeout(120);
  const s2 = await state(pa);
  log(`after submit: cd=${s2.cd} submitting=${s2.submitting}`);
  await finishTurnA();
  st = await myTurn();
}
if (ONLY.includes('menu')) {
  await pa.getByTestId('action-cards').click();
  await pa.waitForTimeout(800);
  await shot('04-turn-menu-open');
  await pa.keyboard.press('Escape');
  await pa.waitForTimeout(500);
}
if (ONLY.includes('buy')) {
  // 传送到目标地块前一格、掷 1 点 → 落在无主的住宅上 → 买地（候选：57 L17、62 L22、44 L6；电脑可能已经买走）
  const cands = [
    { lot: 'L17', node: 58, prev: 59 },
    { lot: 'L22', node: 63, prev: 64 },
    { lot: 'L6', node: 45, prev: 46 },
  ];
  const owners = await pa.evaluate(() =>
    Object.fromEntries(window.__rich4.store.game.getState().latest.lands.map((l) => [l.id, l.owner])),
  );
  const c = cands.find((x) => owners[x.lot] === null) ?? cands[0];
  log(`buy target ${c.lot}`);
  await debug(pa, { op: 'teleport', seat: seatA, node: c.node, prev: c.prev });
  await debug(pa, { op: 'forceNext', purpose: 'dice', values: [1] });
  await waitDecision(pa, ['TURN_MENU']);
  await rollA();
  const d = await waitDecision(pa, ['BUY_LAND', 'UPGRADE_LAND', 'BUY_FACILITY'], 30_000);
  log(`buy decision ${d.decision.kind}`);
  await pa.waitForTimeout(700);
  await shot('05-buyland');
  await answerA();
  await finishTurnA();
  st = await myTurn();
}
if (ONLY.includes('bank')) {
  // 传送到 56（来路 55），掷 1 点 → 19（银行）
  await debug(pa, { op: 'teleport', seat: seatA, node: 56, prev: 55 });
  await debug(pa, { op: 'forceNext', purpose: 'dice', values: [1] });
  await waitDecision(pa, ['TURN_MENU']);
  await rollA();
  const d = await waitDecision(pa, ['BANK_COUNTER', 'BANK_ATM'], 30_000);
  log(`bank decision ${d.decision.kind}`);
  await pa.waitForTimeout(800);
  await shot('06-bank');
  await waitRemainingBelow(2400);
  await shot('07-bank-last3');
  await answerA();
  await finishTurnA();
}
if (ONLY.includes('auction')) {
  // P2 的回合：站到无主的 L20（节点 60），拿拍卖卡（8），从回合菜单出卡 → P1 被问竞拍
  await waitDecision(pb, ['TURN_MENU'], 180_000, async () => {
    const s = await state(pa);
    if (s.idle && s.decision && s.submitting === null) await answerA();
  });
  await debug(pb, { op: 'setCash', seat: seatA, cash: 80000, deposit: null });
  await debug(pb, { op: 'teleport', seat: seatB, node: 60, prev: 18 });
  await debug(pb, { op: 'give', seat: seatB, cards: [8], items: [] });
  await waitDecision(pb, ['TURN_MENU']);
  const slot = await pb.evaluate(
    () => window.__rich4.store.game.getState().decision.options.cards.find((r) => r.card === 8)?.slot ?? null,
  );
  log(`auction card slot ${slot}`);
  await pb.getByTestId('action-cards').click();
  await pb.getByTestId(`inv-card-${slot}`).click();
  await pb.getByTestId('target-picker').waitFor({ timeout: 10_000 });
  await pb.getByTestId('target-confirm').click();
  const d = await waitDecision(pa, ['AUCTION_BID'], 30_000);
  log(`auction ${d.decision.id}`);
  await pa.waitForTimeout(800);
  await shot('08-auction');
  await waitRemainingBelow(2400);
  await shot('09-auction-last3');
}

log(`errors A: ${JSON.stringify(A.errors.slice(0, 10))}`);
log(`errors B: ${JSON.stringify(B.errors.slice(0, 10))}`);
const beeps = await pa.evaluate(() => window.__rich4.countdown?.beeps ?? []);
log(`beeps: ${JSON.stringify(beeps.map((b) => `${b.decisionId.slice(-6)}:${b.secs}:${b.level}:${b.audio}`))}`);
const alog = await pa.evaluate(() =>
  (window.__rich4.audio?.log ?? []).filter((e) => e.kind === 'sfx' && e.key?.includes('countdown')).map((e) => `${e.op}:${e.key}`),
);
log(`audio countdown sfx: ${JSON.stringify(alog)}`);
writeFileSync(`${OUT}/log.txt`, `${LOG.join('\n')}\n`);
await browser.close();
