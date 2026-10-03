// 调研（随机事件里的「卡片样式」画面有没有原版插图，只读）：连上 test/card-browser.mjs 起的常驻 Chrome（CDP），
// 在 P1 / P2 两页（两名真人，私密手牌）上执行一段脚本，逐类触发事件，两页同时采样 DOM 与截图。
// 产物写到 .cache/evcard/current/（含原版素材，不入库）。
// 先起本机服务（复现端口 4211 / 6211，本机例外：未设门禁的素材包，只监听回环）：
//   (apps/server) PORT=4211 HOST=127.0.0.1 PUBLIC_URL=http://localhost:6211 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=<repo>/rich4-assets RICH4_DATA_DIR=<repo>/rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=<repo>/.cache/evcard/data npx tsx src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:4211 npx vite --port 6211 --strictPort
//   node test/card-browser.mjs 9211 http://localhost:6211
// 用法：node test/evcard-drive.mjs '<async 脚本>'，例如
//   node test/evcard-drive.mjs 'await setupRoom({ map: "taiwan" })'
//   node test/evcard-drive.mjs 'await toTurn(A); await trigger("fate-5", A, { node: 39, prev: 40, pre: [{ op: "stackDeck", deck: "fate", ids: [5] }] })'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const CDP = process.env.EVCARD_CDP ?? 'http://127.0.0.1:9211';
const BASE = process.env.EVCARD_BASE ?? 'http://localhost:6211';
const OUT = process.env.EVCARD_OUT ?? '.cache/evcard/current';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP(CDP);
const all = browser.contexts().flatMap((c) => c.pages());
const names = await Promise.all(all.map((p) => p.evaluate(() => window.name).catch(() => '')));
const A = all[names.indexOf('P1')];
const B = all[names.indexOf('P2')];
if (!A || !B) throw new Error(`找不到 P1 / P2 页：${JSON.stringify(names)}`);
const NAME = new Map([
  [A, 'A'],
  [B, 'B'],
]);

const errs = { A: [], B: [] };
for (const [k, p] of [
  ['A', A],
  ['B', B],
]) {
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errs[k].push(`${m.type()}: ${m.text().slice(0, 300)}`);
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
        node: p.node,
        prev: p.prevNode,
        cash: p.cash,
        points: p.points,
        cards: p.cards,
        cardCount: p.cardCount ?? null,
        items: p.items ?? null,
        vehicle: p.vehicle ?? null,
        st: p.st ?? null,
      })),
    };
  });
}

async function debug(page, op) {
  const s0 = (await state(page)).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r?.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page
    .waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 15_000 })
    .catch(() => {});
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

/** 两页都按默认应答（除了 stop(page, st) 返回 true 的那一刻），直到 until() 为真 */
async function pump(until, { timeout = 180_000, skip = () => false } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await until()) return true;
    for (const p of [A, B]) {
      const st = await state(p);
      if (!st.idle || !st.decision || st.submitting !== null) continue;
      if (st.decision.seat !== undefined && st.decision.seat !== st.seat) continue;
      if (await skip(p, st)) continue;
      await act(p);
    }
    await A.waitForTimeout(250);
  }
  throw new Error(`pump timeout: A=${JSON.stringify(await state(A))} B=${JSON.stringify(await state(B))}`);
}

/** 等到 page 本人的 TURN_MENU（期间两页其它决策按默认应答） */
async function toTurn(page) {
  await pump(
    async () => {
      const st = await state(page);
      const other = await state(page === A ? B : A);
      return st.idle && other.idle && st.decision?.kind === 'TURN_MENU' && st.submitting === null;
    },
    { skip: async (p, st) => p === page && st.decision.kind === 'TURN_MENU' },
  );
}

/** 页面上与「卡片样式」画面有关的 DOM：弹窗、卡图、插图、toast、决策场景 */
async function probe(page) {
  return page.evaluate(() => {
    const url2key = window.__evUrlKey ?? {};
    const keyOf = (bg) => {
      const m = /url\("?(.*?)"?\)/.exec(bg ?? '');
      if (!m) return null;
      if (m[1].startsWith('data:') || m[1].startsWith('blob:')) return m[1].slice(0, 5);
      const path = new URL(m[1], location.href).pathname;
      const base = path.split('/').pop();
      return url2key[base] ?? `?${path.slice(-40)}`;
    };
    const popup = document.querySelector('[data-testid="popup"]');
    const out = {
      popup: popup
        ? {
            kind: popup.getAttribute('data-kind'),
            classic: popup.getAttribute('data-classic') === 'true',
            procLayer: !!popup.closest('[data-testid="popup-layer"]'),
          }
        : null,
    };
    const pick = (sel) => document.querySelector(sel);
    const fate = pick('[data-testid="fate-popup"]');
    if (fate)
      out.fate = {
        id: fate.getAttribute('data-fate'),
        tone: fate.getAttribute('data-tone'),
        text: fate.textContent.replace(/\s+/g, ' ').slice(0, 120),
        // 文字与卡面颜色（原版皮肤下程序化命运卡的字色）
        colors: ['h2', '[data-testid="fate-text"]', '[class*="flipFace"]'].map((q) => {
          const e = fate.querySelector(q);
          if (!e) return null;
          const cs = getComputedStyle(e);
          return `${q}:${cs.color}/${cs.backgroundColor}/op${cs.opacity}`;
        }),
        imgs: [...fate.querySelectorAll('img')].map((i) => i.getAttribute('src')?.slice(0, 60)),
        bgs: [...fate.querySelectorAll('*')]
          .map((e) => getComputedStyle(e).backgroundImage)
          .filter((b) => b && b !== 'none' && b.includes('url(')).map(keyOf),
      };
    const news = pick('[data-testid="news-popup"]');
    if (news) {
      const art = news.querySelector('[data-testid="news-art"]');
      out.news = {
        id: news.getAttribute('data-news'),
        art: art ? keyOf(getComputedStyle(art).backgroundImage) : null,
        blank: !art,
        text: news.textContent.replace(/\s+/g, ' ').slice(0, 80),
      };
    }
    const cast = pick('[data-testid="card-cast-popup"]');
    if (cast) {
      const art = cast.querySelector('[data-testid="card-cast-art"]');
      out.cast = {
        card: cast.getAttribute('data-card'),
        variant: cast.getAttribute('data-variant'),
        art: art ? keyOf(getComputedStyle(art).backgroundImage) : null,
        assetKey: art?.getAttribute('data-asset-key') ?? null,
        procIcon: cast.querySelector('[class*="cardIcon"]')?.textContent ?? null,
        text: cast.textContent.replace(/\s+/g, ' ').slice(0, 80),
      };
    }
    const magic = pick('[data-testid="magic-popup"]');
    if (magic)
      out.magic = {
        imgs: [...magic.querySelectorAll('img')].map((i) => (i.getAttribute('src') ?? '').slice(0, 50)),
        text: magic.textContent.replace(/\s+/g, ' ').slice(0, 80),
      };
    const god = pick('[data-testid="god-popup"],[data-testid="god-arrive-popup"]');
    if (god) out.god = { tid: god.getAttribute('data-testid'), text: god.textContent.slice(0, 60) };
    out.toasts = [...document.querySelectorAll('[data-testid="toast"]')].map((t) => t.textContent.trim());
    const banner = document.querySelector('[data-testid="turn-banner"], [data-testid^="banner"]');
    if (banner) out.banner = banner.textContent.trim().slice(0, 60);
    const dec = document.querySelector('[data-testid^="decision-"][data-kind]');
    if (dec) out.decision = { kind: dec.getAttribute('data-kind'), classic: !!dec.closest('[data-classic]') };
    // 卡片插图（CardArt：资料栏位置 / 日历位置的卡图）
    out.cardArts = [...document.querySelectorAll('[data-testid$="card-art"]')].map((e) => ({
      tid: e.getAttribute('data-testid'),
      key: keyOf(getComputedStyle(e).backgroundImage),
    }));
    const g = window.__rich4?.store?.game?.getState();
    out.log = (g?.log ?? []).slice(-2).map((l) => `${l.type}|${(l.text ?? '').slice(0, 40)}`);
    return out;
  });
}

function sig(p) {
  return JSON.stringify({
    popup: p.popup,
    fate: p.fate?.id,
    news: [p.news?.id, p.news?.art],
    cast: [p.cast?.card, p.cast?.art],
    magic: !!p.magic,
    god: !!p.god,
    toasts: p.toasts,
    dec: p.decision?.kind,
    arts: p.cardArts.map((a) => a.key),
    log: p.log.at(-1),
  });
}

let shotN = Number(readFileSafe(`${OUT}/.shotn`) ?? 0);
function readFileSafe(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
async function shot(page, name) {
  shotN++;
  writeFileSync(`${OUT}/.shotn`, String(shotN));
  const file = `${OUT}/${String(shotN).padStart(3, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  return file;
}

/** 把素材包 manifest 的「文件路径 → 逻辑键」表装进两页（probe 用） */
async function installUrlKeys() {
  const m = JSON.parse(readFileSync('rich4-assets/manifest.json', 'utf8'));
  const map = {};
  for (const [k, e] of Object.entries(m.entries)) {
    if (e.file && m.files[e.file]) map[m.files[e.file].path.split('/').pop()] = k;
  }
  for (const p of [A, B]) await p.evaluate((mm) => (window.__evUrlKey = mm), map);
}

/**
 * 观察两页 ms 毫秒：每页签名（弹窗 / 卡图 / toast / 决策 / 最新日志）一变就截图并记一条；every > 0 时另按固定间隔截图
 * （FLIC 画在 Pixi 画布上，DOM 里看不到）。stopWhen(p, probe) 为真时提前结束该页。返回记录。
 */
async function watch(tag, ms, { every = 0, quietAfter = 0 } = {}) {
  const t0 = Date.now();
  // 观察期间两页请求的素材包文件（换成逻辑键），确认演出到底取了哪些插图
  const keyMap = packKeyMap();
  const reqs = { A: [], B: [] };
  const onReq = (who) => (r) => {
    const u = r.url();
    if (!u.includes('/pack/')) return;
    const base = new URL(u).pathname.split('/').pop();
    reqs[who].push(keyMap[base] ?? base);
  };
  const la = onReq('A');
  const lb = onReq('B');
  A.on('request', la);
  B.on('request', lb);
  const last = new Map();
  const lastShot = new Map();
  const rec = [];
  let lastChange = Date.now();
  while (Date.now() - t0 < ms) {
    await Promise.all(
      [A, B].map(async (p) => {
        const who = NAME.get(p);
        let pr;
        try {
          pr = await probe(p);
        } catch (e) {
          return;
        }
        const s = sig(pr);
        const now = Date.now();
        const changed = last.get(p) !== s;
        const periodic = every > 0 && now - (lastShot.get(p) ?? 0) >= every;
        if (changed || periodic) {
          last.set(p, s);
          lastShot.set(p, now);
          if (changed) lastChange = now;
          const file = await shot(p, `${tag}-${who}${changed ? '' : '-t'}`);
          const r = { t: now - t0, who, changed, file, ...pr };
          rec.push(r);
          appendFileSync(`${OUT}/records.jsonl`, `${JSON.stringify({ tag, ...r })}\n`);
        }
      }),
    );
    if (quietAfter > 0 && Date.now() - lastChange > quietAfter && Date.now() - t0 > quietAfter) {
      const [sa, sb] = await Promise.all([state(A), state(B)]);
      if (sa.idle && sb.idle) break;
    }
    await A.waitForTimeout(60);
  }
  A.off('request', la);
  B.off('request', lb);
  if (reqs.A.length || reqs.B.length) {
    log(`${tag} pack requests`, reqs);
    appendFileSync(`${OUT}/records.jsonl`, `${JSON.stringify({ tag, packRequests: reqs })}\n`);
  }
  return rec;
}

let keyMapCache = null;
/** 素材包文件名（带内容哈希）→ 逻辑键 */
function packKeyMap() {
  if (keyMapCache) return keyMapCache;
  const m = JSON.parse(readFileSync('rich4-assets/manifest.json', 'utf8'));
  const map = {};
  for (const [k, e] of Object.entries(m.entries)) {
    if (e.file && m.files[e.file]) map[m.files[e.file].path.split('/').pop()] = k;
  }
  keyMapCache = map;
  return map;
}

/** 本页把 seat 送到 node（来路 prev），预置 pre（stackDeck / forceNext…），骰子 1，掷骰并观察 */
async function trigger(tag, page, { node, prev, pre = [], dice = [1], ms = 12_000, every = 500, quietAfter = 2500 }) {
  const st = await state(page);
  if (st.decision?.kind !== 'TURN_MENU') throw new Error(`${tag}: 不在本人回合菜单 ${JSON.stringify(st)}`);
  for (const op of pre) await debug(page, op);
  if (node !== undefined) await debug(page, { op: 'teleport', seat: st.seat, node, prev });
  if (dice) await debug(page, { op: 'forceNext', purpose: 'dice', values: dice });
  await page.waitForFunction(() => window.__rich4.eventPlayer.idle, undefined, { timeout: 20_000 });
  const d = await decisionFull(page);
  await page.evaluate((id) => window.__rich4.client.act({ type: 'ROLL' }, id), d.decisionId);
  log(`trigger ${tag} by ${NAME.get(page)} seat ${st.seat} → node ${node}`);
  return watch(tag, ms, { every, quietAfter });
}

async function setupRoom({ map = 'taiwan', pacing = null } = {}) {
  await A.goto(`${BASE}/?test=1&who=P1`);
  await A.getByTestId('home-nickname').fill('測試甲');
  await A.getByTestId('home-nickname').blur();
  await A.getByTestId('home-create').click();
  await A.getByTestId('set-map').selectOption(map);
  await A.getByTestId('set-timer').selectOption('off');
  await A.getByTestId('set-ai-count').selectOption('0');
  if (pacing) await A.getByTestId('set-pacing').selectOption(pacing);
  await A.getByTestId('create-submit').click();
  await A.waitForURL(/\/r\/\d{6}/);
  const code = /\/r\/(\d{6})/.exec(A.url())[1];
  log(`room ${code} map ${map}`);
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
      await p.getByTestId('char-select').click().catch(() => {});
  }
  await B.getByTestId('room-ready').click();
  await A.waitForTimeout(500);
  await A.getByTestId('room-start').click();
  // 开局飞行动画：有跳过钮就跳过
  for (const p of [A, B]) {
    await p
      .getByTestId('fly-skip')
      .click({ timeout: 8000 })
      .catch(() => {});
  }
  await A.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  await B.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  writeFileSync(`${OUT}/.room`, code);
  await installUrlKeys();
  log('skin', (await state(A)).skin, (await state(B)).skin);
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
  pump,
  toTurn,
  probe,
  watch,
  trigger,
  shot,
  installUrlKeys,
  setupRoom,
  errs,
  OUT,
  BASE,
  writeFileSync,
  readFileSync,
};
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
  process.exit(process.exitCode ?? 0);
}
