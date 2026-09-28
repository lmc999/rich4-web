// 调试：「只有一名真人时不限时」的目视截图（design/net.md §5.4 有效计时档位）。先起本机服务（端口 3321 / 5321）：
//   PORT=3321 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5321 TRUST_PROXY=0 RICH4_ASSETS_ALLOW_UNGATED=1 \
//   RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_TEST_MODE=1 DATA_DIR=.cache/cs/solo-data \
//   npx tsx apps/server/src/main.ts
//   （apps/client）RICH4_API_TARGET=http://127.0.0.1:3321 npx vite --port 5321 --strictPort
// 再跑：node test/solo-untimed-shots.mjs [--skin=original|procedural] [宽x高] [--only=create]
// 场景：建房画面的计时说明；一名真人 + 3 电脑（档位 normal）大厅说明高亮、开局后侧栏「不限时」、没有中央倒计时；
// 两名真人 + 2 电脑有中央倒计时，P2 离开后 P1 的倒计时消失、侧栏变「不限时」。截图写到 .cache/cs/solo/<tag>/（含原版素材，不入库）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.SOLO_BASE ?? 'http://localhost:5321';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const TAG = `${SKIN}-${size[0]}x${size[1]}`;
const OUT = `.cache/cs/solo/${TAG}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  console.log(line);
  LOG.push(line);
};
const mobile = size[0] < 1000;
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function newPage(name) {
  const ctx = await browser.newContext({
    viewport: { width: size[0], height: size[1] },
    deviceScaleFactor: 1,
    ...(mobile ? { hasTouch: true } : {}),
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
  return { ctx, page, errors, name };
}

async function shot(page, name) {
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
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
      preset: room?.settings?.timerPreset ?? null,
      effective: room?.effectiveTimerPreset ?? null,
      decision: d ? { kind: d.kind, id: d.decisionId, deadlineAt: d.deadlineAt } : null,
      pendingDeadlines: (g?.pending ?? []).map((p) => p.deadlineAt),
      submitting: g?.submitting ?? null,
      centerCd: document.querySelectorAll('[data-testid="decision-countdown"]').length,
      centerSecs: document.querySelector('[data-testid="decision-countdown"]')?.getAttribute('data-secs') ?? null,
      railCd: document.querySelector('[data-testid="classic-my-countdown"]')?.textContent ?? null,
      ring: document.querySelector('[data-testid="countdown"]')?.getAttribute('aria-label') ?? null,
    };
  });
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

/** 对方的决策一律按默认处理 */
function driver(page) {
  return async () => {
    const st = await state(page);
    if (!st.idle || !st.decision || st.submitting !== null) return;
    await page.evaluate(() => {
      const h = window.__rich4;
      const d = h.store.game.getState().decision;
      return h.client.act(d.defaultIntent, d.decisionId);
    });
  };
}

async function home(page, nick) {
  await page.goto(`${BASE}/?test=1`);
  await page.getByTestId('home-nickname').fill(nick);
  await page.getByTestId('home-nickname').blur();
}

async function createRoom(page, o) {
  await page.getByTestId('home-create').click();
  await page.getByTestId('set-map').selectOption('taiwan');
  await page.getByTestId('set-timer').selectOption(o.timer);
  await page.getByTestId('set-pacing').selectOption('compact');
  await page.getByTestId('set-ai-count').selectOption(String(o.ais));
  if (o.shot) {
    await page.waitForTimeout(500);
    await shot(page, o.shot);
    const hint = page.getByTestId('set-timer-hint');
    log(`  set-timer-hint: "${await hint.textContent()}" visible=${await hint.isVisible()} box=${JSON.stringify(await hint.boundingBox())}`);
  }
  await page.getByTestId('create-submit').click();
  await page.waitForURL(/\/r\/\d{6}/);
  return /\/r\/(\d{6})/.exec(page.url())[1];
}

async function pick(page, id) {
  await page.getByTestId(`char-${id}`).click();
  await page.waitForTimeout(300);
  const txt = await page.getByTestId('char-select').textContent();
  if (!/^已(选择|選擇)$/.test(txt ?? '')) await page.getByTestId('char-select').click();
}

async function enterGame(page) {
  await page.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  await page.waitForFunction((k) => window.__rich4?.skin?.boardInUse === k, SKIN, { timeout: 60_000 });
}

const lobbyHint = async (page) => {
  const el = page.locator('[data-testid="set-timer-hint"], [data-testid="room-timer-hint"]').first();
  return { text: await el.textContent(), active: await el.getAttribute('data-active') };
};

const summary = {};

// --only=create：只截建房画面（手机横屏检查两列面板里的说明）与一名真人的大厅
if (args.includes('--only=create')) {
  const A = await newPage('solo');
  await home(A.page, '單人');
  await A.page.getByTestId('home-create').click();
  await A.page.getByTestId('set-timer').selectOption('normal');
  await A.page.waitForTimeout(800);
  await shot(A.page, '01-create');
  const hint = A.page.getByTestId('set-timer-hint');
  const sel = A.page.getByTestId('set-timer');
  log(`  hint box=${JSON.stringify(await hint.boundingBox())} select box=${JSON.stringify(await sel.boundingBox())}`);
  log(`  errors=${JSON.stringify(A.errors)}`);
  await browser.close();
  process.exit(0);
}

// ── 1. 一名真人 + 3 电脑（档位 normal） ──
{
  const A = await newPage('solo');
  const pa = A.page;
  await home(pa, '單人');
  const code = await createRoom(pa, { timer: 'normal', ais: 3, shot: '01-create' });
  log(`solo room ${code}`);
  await pa.getByTestId('screen-room').waitFor();
  await pa.waitForTimeout(800);
  const hint = await lobbyHint(pa);
  log(`  lobby hint ${JSON.stringify(hint)} effective=${(await state(pa)).effective}`);
  await shot(pa, '02-lobby-solo');
  await pick(pa, 2);
  await pa.getByTestId('room-start').click();
  await enterGame(pa);
  const st = await waitDecision(pa, ['TURN_MENU']);
  await pa.waitForTimeout(1500);
  const st2 = await state(pa);
  log(`  solo in game: ${JSON.stringify(st2)}`);
  await shot(pa, '03-game-solo');
  summary.solo = { lobbyHint: hint, game: st2, firstDecision: st.decision, errors: A.errors };
  await A.ctx.close();
}

// ── 2. 两名真人 + 2 电脑：有倒计时；P2 离开后取消 ──
{
  const A = await newPage('P1');
  const B = await newPage('P2');
  const pa = A.page;
  const pb = B.page;
  await home(pa, '測試甲');
  const code = await createRoom(pa, { timer: 'normal', ais: 2 });
  log(`duo room ${code}`);
  await home(pb, '測試乙');
  await pb.goto(`${BASE}/r/${code}?test=1`);
  await pb.getByTestId('screen-room').waitFor();
  await pick(pa, 2);
  await pick(pb, 9);
  await pb.getByTestId('room-ready').click();
  await pa.waitForTimeout(800);
  const hint = await lobbyHint(pa);
  log(`  lobby hint ${JSON.stringify(hint)} effective=${(await state(pa)).effective}`);
  await shot(pa, '04-lobby-duo');
  await pa.getByTestId('room-start').click();
  await enterGame(pa);
  await waitDecision(pa, ['TURN_MENU'], 180_000, driver(pb));
  await pa.waitForTimeout(1200);
  const timed = await state(pa);
  log(`  duo in game: ${JSON.stringify(timed)}`);
  await shot(pa, '05-game-duo');
  // P2 离开（对局中 room:leave → autopilot:left）：只剩一名真人
  await pb.evaluate(() => window.__rich4.client.leaveRoom());
  await pa.waitForFunction(() => window.__rich4.store.room.getState().room?.effectiveTimerPreset === 'off', null, {
    timeout: 10_000,
  });
  await pa.waitForTimeout(1200);
  const left = await state(pa);
  log(`  after P2 left: ${JSON.stringify(left)}`);
  await shot(pa, '06-game-duo-p2-left');
  summary.duo = { lobbyHint: hint, timed, left, errors: [...A.errors, ...B.errors] };
  await A.ctx.close();
  await B.ctx.close();
}

writeFileSync(`${OUT}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(`${OUT}/log.txt`, `${LOG.join('\n')}\n`);
await browser.close();
