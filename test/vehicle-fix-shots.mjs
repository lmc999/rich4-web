// 修复复核（收起交通工具的提示 / 日志 / 音效）：原版皮肤 + 真实素材包，两个真人（P2 另开页面，由脚本代答），台湾图、不限时、
// 汽车开局。原版收起（v2.06 0x4467b1）只刷新外观、重画，不说台词，所以：
//   ① P1 从道具欄右下角收起汽车 → 两边都不弹「換乘交通工具」提示、不放 ding，日志记「收起汽車，改為步行」（VEHICLE.stowed=car）；
//   ② 对照：P1 再用 6 号道具把汽车装回 → 照旧弹「換乘交通工具（3 顆骰子）」、放 ding。
// 每步截整页（toast 3.2 秒就消失，收起 / 装回后 0.5 秒内截图）与右栏日志，写到 .cache/vehicle/fix/<名字>/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；端口按 VEHICLE_BASE，缺省 5961 / 3961）：
//   (apps/server) PORT=3961 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5961 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=<repo>/rich4-assets RICH4_DATA_DIR=<repo>/rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=<repo>/.cache/vehicle/fix/data npx tsx src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:3961 npx vite --port 5961 --strictPort
// 用法：node test/vehicle-fix-shots.mjs [宽x高=1920x1080] [--mobile] [--name=desktop]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.VEHICLE_BASE ?? 'http://localhost:5961';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const MOBILE = args.includes('--mobile');
const NAME = args.find((a) => a.startsWith('--name='))?.slice(7) ?? `${size[0]}x${size[1]}`;
const OUT = `.cache/vehicle/fix/${NAME}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const checks = [];
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};
function check(cond, msg, detail) {
  checks.push({ ok: !!cond, msg, detail });
  log(`${cond ? 'PASS' : 'FAIL'} ${msg}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function newPage(primary) {
  const ctx = await browser.newContext(
    primary
      ? {
          viewport: { width: size[0], height: size[1] },
          deviceScaleFactor: MOBILE ? 2 : 1,
          ...(MOBILE ? { isMobile: true, hasTouch: true } : {}),
        }
      : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  );
  await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { ctx, page, errors };
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
      decision: d ? { kind: d.kind, id: d.decisionId, seat: d.seat } : null,
      submitting: g?.submitting ?? null,
      skin: h?.skin ?? null,
    };
  });
}

async function me(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h.store.game.getState();
    const seat = h.store.room.getState().room?.you?.seat ?? null;
    const p = g.view?.players?.find((x) => x.seat === seat);
    return { seat, vehicle: p?.vehicle ?? null, diceCount: p?.diceCount ?? null };
  });
}

/** 页面里常驻的记录器：新弹出的提示（toast 3.2 秒就消失）；音频日志从这里起算 */
async function installRecorders(page) {
  await page.evaluate(() => {
    if (window.__fix) return;
    const rec = { toasts: [] };
    window.__fix = rec;
    window.__rich4.store.ui.subscribe((st, prev) => {
      for (const t of st.toasts) if (!prev.toasts.includes(t)) rec.toasts.push({ t: Math.round(performance.now()), text: t.text });
    });
  });
}

async function mark(page) {
  return page.evaluate(() => ({
    toasts: window.__fix.toasts.length,
    log: window.__rich4.store.game.getState().log.length,
    audio: window.__rich4.audio?.log?.length ?? null,
  }));
}

/** 从 mark 起的新提示、日志行（带原事件）、音频日志（没有音频钩子时为 null） */
async function since(page, m) {
  return page.evaluate((m0) => {
    const h = window.__rich4;
    const audio = h.audio?.log ?? null;
    return {
      toasts: window.__fix.toasts.slice(m0.toasts).map((x) => x.text),
      log: h.store.game
        .getState()
        .log.slice(m0.log)
        .map((l) => ({ type: l.type, text: l.text, stowed: l.src?.event?.stowed ?? null, seat: l.src?.event?.seat ?? null })),
      audio:
        audio === null || m0.audio === null
          ? null
          : audio.slice(m0.audio).map((e) => ({ kind: e.kind, op: e.op, key: e.key ?? null, detail: e.detail ?? null })),
    };
  }, m);
}

async function act(page, intent = null) {
  return page.evaluate((it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(it ?? d.defaultIntent, d.decisionId) : null;
  }, intent);
}

async function debug(page, op) {
  const s0 = (await state(page)).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r?.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    const st = await state(page);
    if (st.seq > s0 && st.idle) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`debug ${op.op} seq 没有前进`);
}

async function skipFly(page) {
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    if ((await page.getByTestId('fly').count()) > 0) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      if ((await page.getByTestId('fly').count()) === 0) return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function rect(page, testId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }, testId);
}

async function clipShot(page, file, testId, pad = 8) {
  const r = await rect(page, testId);
  if (!r || r.w === 0) return false;
  const vw = page.viewportSize();
  const x = Math.max(0, r.x - pad);
  const y = Math.max(0, r.y - pad);
  await page.screenshot({
    path: file,
    clip: { x, y, width: Math.min(r.w + pad * 2, vw.width - x), height: Math.min(r.h + pad * 2, vw.height - y) },
  });
  return true;
}

/** 右栏切到「日志」页再截（桌面布局才有右栏；手机横屏没有就跳过） */
async function logShot(page, file) {
  const tab = page.getByTestId('top-log');
  if ((await tab.count()) === 0 || !(await tab.isVisible())) return false;
  await tab.click({ timeout: 3000 });
  await page.waitForTimeout(400);
  return clipShot(page, file, 'event-log');
}

const A = await newPage(true);
const B = await newPage(false);
const pa = A.page;
const pb = B.page;
const driveB = async () => {
  const st = await state(pb);
  if (!st.idle || !st.decision || st.submitting !== null || st.decision.seat !== st.seat) return;
  await act(pb, st.decision.kind === 'TURN_MENU' ? { type: 'ROLL' } : null);
};
async function myTurn(timeout = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await state(pa);
    if (st.idle && st.decision && st.submitting === null && st.decision.seat === st.seat) {
      if (st.decision.kind === 'TURN_MENU') return st;
      await act(pa);
    }
    await driveB();
    await pa.waitForTimeout(200);
  }
  await pa.screenshot({ path: `${OUT}/fail-myturn.png` }).catch(() => {});
  throw new Error(`myTurn timeout: ${JSON.stringify(await state(pa))}`);
}

async function waitIdleBoth() {
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    const [a, b] = await Promise.all([state(pa), state(pb)]);
    if (a.idle && b.idle) return;
    await pa.waitForTimeout(50);
  }
}

try {
  await pa.goto(`${BASE}/?test=1`);
  await pa.getByTestId('home-nickname').fill('測試甲');
  await pa.getByTestId('home-nickname').blur();
  await pa.getByTestId('home-create').click();
  await pa.getByTestId('set-map').selectOption('taiwan');
  await pa.getByTestId('set-timer').selectOption('off');
  await pa.getByTestId('set-ai-count').selectOption('0');
  await pa.getByTestId('set-vehicle').selectOption('car');
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
    if ((await p.getByTestId('screen-room').getAttribute('data-screen')) !== 'select')
      await p.getByTestId('char-select').click();
  }
  await pb.getByTestId('room-ready').click();
  await pa.waitForTimeout(500);
  await pa.getByTestId('room-start').click();
  await pa.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  await pb.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  log(`skin ${JSON.stringify((await state(pa)).skin)}`);
  await Promise.all([skipFly(pa), skipFly(pb)]);
  await debug(pa, { op: 'clearBoard' });
  await Promise.all([installRecorders(pa), installRecorders(pb)]);

  await myTurn();
  await pa.waitForTimeout(1200);
  const m0 = await me(pa);
  check(m0.vehicle === 'car' && m0.diceCount === 3, '汽车开局', m0);
  await pa.screenshot({ path: `${OUT}/01-turn1-car.png` });

  // ① 收起：道具欄右下角
  await pa.getByTestId('action-items').click({ timeout: 5000 });
  await pa.waitForTimeout(700);
  await pa.screenshot({ path: `${OUT}/02-itembar.png` });
  const [ka, kb] = await Promise.all([mark(pa), mark(pb)]);
  await pa.getByTestId('inv-stow-vehicle').click({ timeout: 5000 });
  await waitIdleBoth();
  await pa.waitForTimeout(300);
  await pa.screenshot({ path: `${OUT}/03-after-stow.png` });
  await pb.screenshot({ path: `${OUT}/03-after-stow.P2.png` });
  await myTurn();
  const m1 = await me(pa);
  check(m1.vehicle === 'walk' && m1.diceCount === 1, '收起后步行、1 颗', m1);
  const sa = await since(pa, ka);
  const sb = await since(pb, kb);
  log(`P1 since stow ${JSON.stringify(sa)}`);
  log(`P2 since stow ${JSON.stringify(sb)}`);
  for (const [who, s] of [
    ['P1', sa],
    ['P2', sb],
  ]) {
    check(
      s.toasts.every((t) => !t.includes('換乘') && !t.includes('换乘')),
      `${who}：收起时没有「換乘交通工具」提示`,
      s.toasts,
    );
    const v = s.log.filter((l) => l.type === 'VEHICLE');
    check(
      v.length === 1 && v[0].stowed === 'car' && v[0].text.includes('收起汽車，改為步行'),
      `${who}：日志记「收起汽車，改為步行」（VEHICLE.stowed=car）`,
      v,
    );
    if (s.audio === null) log(`${who}：没有音频钩子，音效不核对`);
    else
      check(
        s.audio.every((e) => !String(e.key ?? '').includes('ding') && !String(e.detail ?? '').includes('ding')),
        `${who}：收起时没有放 ding`,
        s.audio.filter((e) => e.kind === 'sfx'),
      );
  }
  await logShot(pa, `${OUT}/04-log-after-stow.png`);

  // ② 对照：用 6 号道具把汽车装回 → 照旧提示「換乘交通工具（3 顆骰子）」、放 ding
  await pa.getByTestId('action-items').click({ timeout: 5000 });
  await pa.waitForTimeout(700);
  const [ka2, kb2] = await Promise.all([mark(pa), mark(pb)]);
  await pa.getByTestId('inv-item-6').click({ timeout: 5000 });
  await pa.waitForTimeout(500);
  await pa.getByTestId('target-confirm').click({ timeout: 5000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    const s = await since(pa, ka2);
    if (s.toasts.some((t) => t.includes('換乘'))) break;
    await pa.waitForTimeout(50);
  }
  await pa.screenshot({ path: `${OUT}/05-after-reequip.png` });
  await myTurn();
  const m2 = await me(pa);
  check(m2.vehicle === 'car' && m2.diceCount === 3, '装回汽车、3 颗', m2);
  const ra = await since(pa, ka2);
  const rb = await since(pb, kb2);
  log(`P1 since re-equip ${JSON.stringify(ra)}`);
  log(`P2 since re-equip ${JSON.stringify(rb)}`);
  check(
    ra.toasts.some((t) => t.includes('換乘交通工具（3 顆骰子）')),
    'P1：装回汽车照旧提示「換乘交通工具（3 顆骰子）」',
    ra.toasts,
  );
  const rv = ra.log.filter((l) => l.type === 'VEHICLE');
  check(rv.length === 1 && rv[0].stowed === null, '装回的 VEHICLE 没有 stowed', rv);
  if (ra.audio !== null)
    check(
      ra.audio.some((e) => String(e.key ?? '').includes('ding') || String(e.detail ?? '').includes('ding')),
      'P1：装回汽车照旧放 ding（对照）',
      ra.audio.filter((e) => e.kind === 'sfx'),
    );
  await logShot(pa, `${OUT}/06-log-after-reequip.png`);

  check(A.errors.length === 0 && B.errors.length === 0, '没有控制台错误', { P1: A.errors, P2: B.errors });
} catch (e) {
  log(`FAILED ${e.stack ?? e}`);
  checks.push({ ok: false, msg: 'crashed', detail: String(e) });
  await pa.screenshot({ path: `${OUT}/fail.png` }).catch(() => {});
}
const summary = { pass: checks.filter((c) => c.ok).length, fail: checks.filter((c) => !c.ok).length };
writeFileSync(`${OUT}/report.json`, JSON.stringify({ size, mobile: MOBILE, summary, checks }, null, 2));
writeFileSync(`${OUT}/log.txt`, LOG.join('\n'));
log(`summary ${JSON.stringify(summary)} → ${OUT}/report.json`);
await A.ctx.close();
await B.ctx.close();
await browser.close();
