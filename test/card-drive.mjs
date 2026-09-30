// 调研（出卡插画，只读）：连上 test/card-browser.mjs 起的常驻 Chrome（CDP），在 P1 / P2 两页上执行一段脚本。
// 脚本里可用的助手见下方 H（state、act、debug、waitDecision、shot、probeCard…）；截图与记录写到 .cache/card/current/。
// 用法：node test/card-drive.mjs '<async 脚本>'，例如
//   node test/card-drive.mjs 'log(await state(A))'
//   node test/card-drive.mjs 'await setupRoom()'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import * as castLib from './card-cast-lib.mjs';

const CDP = process.env.CARD_CDP ?? 'http://127.0.0.1:9711';
const BASE = process.env.CARD_BASE ?? 'http://localhost:5711';
const OUT = '.cache/card/current';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP(CDP);
// 按 window.name 认页（card-browser.mjs 打开时写入 P1 / P2；同源导航保留）
const all = browser.contexts().flatMap((c) => c.pages());
const names = await Promise.all(all.map((p) => p.evaluate(() => window.name).catch(() => '')));
const A = all[names.indexOf('P1')];
const B = all[names.indexOf('P2')];
if (!A || !B) throw new Error(`找不到 P1 / P2 页：${JSON.stringify(names)}`);

const errs = { A: [], B: [] };
for (const [k, p] of [
  ['A', A],
  ['B', B],
]) {
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errs[k].push(`${m.type()}: ${m.text().slice(0, 400)}`);
  });
  p.on('pageerror', (e) => errs[k].push(`pageerror: ${e.message}`));
  p.on('response', (r) => {
    if (r.status() >= 400) errs[k].push(`http ${r.status()} ${r.url()}`);
  });
}

function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  appendFileSync(`${OUT}/drive.log`, `[${new Date().toISOString().slice(11, 23)}] ${line}\n`);
}

async function state(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const room = h?.store?.room?.getState().room;
    const d = g?.decision;
    return {
      url: location.pathname,
      seq: g?.seq ?? 0,
      idle: h?.eventPlayer?.idle ?? false,
      seat: room?.you?.seat ?? null,
      decision: d ? { kind: d.kind, id: d.decisionId, seat: d.seat } : null,
      submitting: g?.submitting ?? null,
      skin: h?.skin ?? null,
    };
  });
}

async function view(page) {
  return page.evaluate(() => {
    const v = window.__rich4.store.game.getState().view;
    return {
      date: v.date,
      players: v.players.map((p) => ({
        seat: p.seat,
        name: p.name,
        ch: p.character,
        node: p.node,
        cash: p.cash,
        cards: p.cards,
        status: p.status ?? null,
        controller: p.controller ?? null,
      })),
    };
  });
}

async function debug(page, op) {
  const s0 = (await state(page)).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
  return r;
}

async function act(page, intent = null) {
  return page.evaluate((it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(it ?? d.defaultIntent, d.decisionId) : null;
  }, intent);
}

async function decisionFull(page) {
  return page.evaluate(() => window.__rich4.store.game.getState().decision);
}

/** 等本页出现某种决策（其他页的默认应答由 other 负责） */
async function waitDecision(page, kinds, timeout = 120_000, other = null) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await state(page);
    if (st.idle && st.decision && st.submitting === null && kinds.includes(st.decision.kind)) return st;
    if (other) await other();
    await page.waitForTimeout(200);
  }
  throw new Error(`wait ${kinds} timeout: ${JSON.stringify(await state(page))}`);
}

/** 对方页：轮到它有决策就按默认应答 */
async function autoAnswer(page, except = []) {
  const st = await state(page);
  if (!st.idle || !st.decision || st.submitting !== null) return;
  if (except.includes(st.decision.kind)) return;
  await act(page);
}

let shotN = Number(readFileSafe(`${OUT}/.shotn`) ?? 0);
function readFileSafe(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
async function shot(page, name, clip = null) {
  shotN++;
  writeFileSync(`${OUT}/.shotn`, String(shotN));
  const file = `${OUT}/${String(shotN).padStart(3, '0')}-${name}.png`;
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  log(`shot ${file}`);
  return file;
}

/** 经典舞台在页面上的位置与倍率（场景坐标 → 页面坐标） */
async function stageXf(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-testid="classic-stage"]');
    if (!stage) return null;
    const [sx, sy] = (stage.getAttribute('data-stage') ?? '0,0').split(',').map(Number);
    const k = Number(stage.getAttribute('data-scale'));
    const r = stage.getBoundingClientRect();
    return { x: r.left + sx, y: r.top + sy, k };
  });
}

/** 卡片插画（CardArt / CardCast）现场：data-card、背景图 URL → 素材键、尺寸、可见性 */
async function probeCard(page) {
  return page.evaluate(() => {
    const url2key = window.__cardUrlKey ?? {};
    const pick = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const bg = cs.backgroundImage;
      const m = /url\("?(.*?)"?\)$/.exec(bg);
      const url = m ? m[1] : null;
      const path = url ? new URL(url, location.href).pathname : null;
      const r = el.getBoundingClientRect();
      return {
        testid: el.getAttribute('data-testid'),
        dataCard: el.getAttribute('data-card'),
        bgPath: path,
        bgKey: path ? (url2key[path.replace(/^\/pack\//, '')] ?? '?') : null,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        opacity: cs.opacity,
        transform: cs.transform,
        filter: cs.filter,
        visibility: cs.visibility,
        display: cs.display,
      };
    };
    const popup = document.querySelector('[data-testid="popup"]');
    const cast = document.querySelector('[data-testid="card-cast-popup"]');
    return {
      popup: popup
        ? {
            kind: popup.getAttribute('data-kind'),
            classic: popup.getAttribute('data-classic'),
            scene: popup.closest('[data-scene]')?.getAttribute('data-scene') ?? popup.getAttribute('data-scene'),
            inLayer: !!popup.closest('[data-testid="popup-layer"]'),
          }
        : null,
      cast: cast
        ? {
            dataCard: cast.getAttribute('data-card'),
            variant: cast.getAttribute('data-variant'),
            classic: !!cast.closest('[data-classic="true"]'),
            text: cast.textContent.slice(0, 200),
            procIcon: cast.querySelector('[class*="cardIcon"]')?.textContent ?? null,
          }
        : null,
      castArt: pick(document.querySelector('[data-testid="card-cast-art"]')),
      arts: [...document.querySelectorAll('[data-testid$="card-art"]')].map(pick),
    };
  });
}

/** 把素材包 manifest 的「文件路径 → 逻辑键」表装进页面（probeCard 用） */
async function installUrlKeys(page) {
  const m = JSON.parse(readFileSync('rich4-assets/manifest.json', 'utf8'));
  const map = {};
  for (const [k, e] of Object.entries(m.entries)) {
    if (e.type === 'image' && m.files[e.file]) map[m.files[e.file].path] = k;
  }
  await page.evaluate((mm) => {
    window.__cardUrlKey = mm;
  }, map);
}

async function setupRoom({ ai = 1, map = 'taiwan', timer = 'off' } = {}) {
  await A.goto(`${BASE}/?test=1&who=P1`);
  await A.getByTestId('home-nickname').fill('測試甲');
  await A.getByTestId('home-nickname').blur();
  await A.getByTestId('home-create').click();
  await A.getByTestId('set-map').selectOption(map);
  await A.getByTestId('set-timer').selectOption(timer);
  await A.getByTestId('set-ai-count').selectOption(String(ai));
  await A.getByTestId('create-submit').click();
  await A.waitForURL(/\/r\/\d{6}/);
  const code = /\/r\/(\d{6})/.exec(A.url())[1];
  log(`room ${code}`);
  await B.goto(`${BASE}/?test=1&who=P2`);
  await B.getByTestId('home-nickname').fill('測試乙');
  await B.getByTestId('home-nickname').blur();
  await B.goto(`${BASE}/r/${code}?test=1&who=P2`);
  await B.getByTestId('screen-room').waitFor();
  for (const [p, c] of [
    [A, 2],
    [B, 9],
  ]) {
    await p.getByTestId(`char-${c}`).click();
    if ((await p.getByTestId('screen-room').getAttribute('data-screen')) !== 'select')
      await p.getByTestId('char-select').click();
  }
  await B.getByTestId('room-ready').click();
  await A.waitForTimeout(500);
  await A.getByTestId('room-start').click();
  await A.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  await B.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  writeFileSync(`${OUT}/.room`, code);
  log('skin', (await state(A)).skin);
}

const H = {
  A,
  B,
  browser,
  log,
  state,
  view,
  debug,
  act,
  decisionFull,
  waitDecision,
  autoAnswer,
  shot,
  stageXf,
  probeCard,
  installUrlKeys,
  setupRoom,
  errs,
  OUT,
  BASE,
  writeFileSync,
  readFileSync,
};
H.H = H;
H.lib = castLib;
const src = process.argv.slice(2).join(' ');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const fn = new AsyncFunction(...Object.keys(H), src);
try {
  await fn(...Object.values(H));
} catch (e) {
  log(`ERROR ${e.stack ?? e}`);
  process.exitCode = 1;
} finally {
  if (errs.A.length || errs.B.length) log('errs', errs);
  // 只断开 CDP，不关浏览器（常驻浏览器由 card-browser.mjs 管）
  process.exit(process.exitCode ?? 0);
}
