// 调试脚本（命运 / 新闻改成原版原文、新闻板照原版版式，真实素材包目视）：自己起一个无头 Chrome（系统 Chrome），开两个互相
// 隔离的页面 A / B（两名真人），逐条把新闻 / 命运预置到牌堆、传送到前一格、掷 1 点落上去，在板子出现后截图，并核对：
// - 命运板：原文整句（zh-TW 即 exe 格式串）写在 (24,330)，金额在句中；33–36 在大陆 / 日本 / 美国图换成按图变体；
// - 新闻板：分类名 (24,8)、原文标题 (24,310)、没有打字机；税 / 储金红利逐行「<人>繳交<n>元」+ 小头像，豪雨只画头像，
//   获释（有人在押）从 (390,328) 起叠头像，得奖一人；
// - 新闻板停留 = max(2.4 秒, 语音)、B 点一下板子即结束（A 照常看满），原版新闻板开头没有 ZzFX news。
// 产物写到 .cache/fatenews/<地图>-<视图>/（含原版素材，不入库）。先起本机服务（端口 4311 / 6311，本机例外：未设门禁的素材包，只监听回环）：
//   (apps/server) PORT=4311 HOST=127.0.0.1 PUBLIC_URL=http://localhost:6311 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=<repo>/rich4-assets RICH4_DATA_DIR=<repo>/rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=<repo>/.cache/fatenews/data npx tsx src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:4311 npx vite --port 6311 --strictPort
// 用法：node test/fatenews-shots.mjs [地图 taiwan|china|japan|usa] [desktop|mobile]
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.FN_BASE ?? 'http://localhost:6311';
const [MAP = 'taiwan', VIEW = 'desktop'] = process.argv.slice(2);
const OUT = `.cache/fatenews/${MAP}-${VIEW}`;
mkdirSync(OUT, { recursive: true });
const VP = VIEW === 'mobile' ? { width: 844, height: 390 } : { width: 1920, height: 1080 };
const results = [];
/** 新闻语音时长（shared/view/pacing 的 NEWS_VOICE_MS） */
const NEWS_VOICE = [
  2206, 2028, 2178, 2179, 1750, 3068, 1346, 2617, 1940, 2095, 2579, 2136, 1827, 2029, 2092, 2889, 2831, 3060, 2389, 2103,
  3053, 3307, 1807, 1734, 2458, 2485, 1724, 1826, 1945, 3935, 2497, 2766, 1906, 2909, 2552, 1938,
];

function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  appendFileSync(`${OUT}/shots.log`, `[${new Date().toISOString().slice(11, 23)}] ${line}\n`);
}

function check(name, ok, detail = {}) {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail);
}

/** 页面脚本之前装的记录器：window.__fn.rows（新闻板 / 命运板每出现一次一行：出现、消失时刻） */
function recorder() {
  const rows = [];
  const els = new Map();
  const now = () => Math.round(performance.now());
  window.__fn = { rows };
  const scan = () => {
    const live = new Set();
    for (const el of document.querySelectorAll('[data-scene="classic"][data-kind]')) {
      const kind = el.getAttribute('data-kind');
      if (kind !== 'fate' && kind !== 'news') continue;
      if (el.getAttribute('data-testid') !== 'popup') continue;
      const phase = el.querySelector('[data-testid="fate-popup"]')?.getAttribute('data-phase') ?? null;
      const id =
        el.querySelector('[data-testid="news-popup"]')?.getAttribute('data-news') ??
        el.querySelector('[data-testid="fate-popup"]')?.getAttribute('data-fate') ??
        null;
      const key = `${kind}:${phase}:${id}`;
      live.add(el);
      if (!els.has(el) || els.get(el).key !== key) {
        const row = { kind, phase, id, t0: now(), t1: null };
        rows.push(row);
        if (els.has(el)) els.get(el).row.t1 = now();
        els.set(el, { key, row });
      }
    }
    for (const [el, v] of els) {
      if (!live.has(el) || el.getAttribute('data-testid') !== 'popup') {
        if (v.row.t1 === null) v.row.t1 = now();
        els.delete(el);
      }
    }
  };
  new MutationObserver(scan).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-testid', 'data-phase', 'data-news', 'data-fate'],
  });
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
async function openPage(name) {
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  await ctx.addInitScript(recorder);
  const page = await ctx.newPage();
  page.__name = name;
  page.__errs = [];
  page.on('pageerror', (e) => page.__errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') page.__errs.push(`console: ${m.text().slice(0, 200)}`);
  });
  return page;
}
const A = await openPage('A');
const B = await openPage('B');
const PAGES = [A, B];

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
    };
  });
}

async function debug(page, op) {
  const s0 = (await state(page)).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r?.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 15_000 }).catch(() => {});
  return r;
}

async function act(page, intent = null) {
  return page.evaluate((it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(it ?? d.defaultIntent, d.decisionId) : null;
  }, intent);
}

/** 两名真人按默认应答，直到 until() 为真 */
async function pump(until, { timeout = 240_000, skip = async () => false } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await until()) return;
    for (const p of PAGES) {
      const st = await state(p);
      if (!st.idle || !st.decision || st.submitting !== null) continue;
      if (st.decision.seat !== undefined && st.decision.seat !== st.seat) continue;
      if (await skip(p, st)) continue;
      await act(p);
    }
    await A.waitForTimeout(250);
  }
  throw new Error(`pump timeout A=${JSON.stringify(await state(A))} B=${JSON.stringify(await state(B))}`);
}

async function toTurn(page) {
  const other = page === A ? B : A;
  await pump(
    async () => {
      const [s, o] = await Promise.all([state(page), state(other)]);
      return s.idle && o.idle && s.decision?.kind === 'TURN_MENU' && s.submitting === null;
    },
    { skip: async (p, st) => p === page && st.decision.kind === 'TURN_MENU' },
  );
}

/** 地图上某类格子的「前一格」：从 node 以 prev 为来路掷 1 正好落到目标格 */
async function approach(kind, nth = 0, pred = null) {
  return A.evaluate(
    ({ kind, nth, pred }) => {
      const def = Object.values(window.__rich4.store.map.getState().entries).find((e) => e.def)?.def;
      const byId = new Map(def.tiles.map((t) => [t.id, t]));
      const f = pred ? new Function('t', 'def', `return (${pred})(t, def)`) : () => true;
      const out = [];
      for (const t of def.tiles) {
        if ((kind && t.kind !== kind) || !f(t, def)) continue;
        for (const l of t.links) {
          const n = byId.get(l.to);
          if (!n || n.kind === 'jail' || n.kind === 'hospital' || n.holdFor) continue;
          const open = n.links.filter((x) => !x.blocked);
          if (n.links.length !== 2 || open.length < 1) continue;
          const toT = n.links.find((x) => x.to === t.id);
          const prev = n.links.find((x) => x.to !== t.id);
          if (!toT || toT.blocked || !prev) continue;
          out.push({ target: t.id, node: n.id, prev: prev.to });
        }
      }
      return out[nth % Math.max(1, out.length)] ?? null;
    },
    { kind, nth, pred },
  );
}

let shotN = 0;
/** 整页截图 + 原版舞台（640×480 场景）裁切 */
async function shot(page, name) {
  const base = `${OUT}/${String(++shotN).padStart(3, '0')}-${name}-${page.__name}`;
  await page.screenshot({ path: `${base}.png` });
  const box = await page.locator('[data-testid="classic-stage-inner"]').first().boundingBox().catch(() => null);
  if (box) await page.screenshot({ path: `${base}-stage.png`, clip: box });
  return base;
}

/** 本页座位走到目标格：预置 pre，传送到前一格，骰子 1，返回掷骰动作（调用即掷） */
async function prepareLanding(page, { kind, nth = 0, pred = null, pre = [] }) {
  await toTurn(page);
  const st = await state(page);
  const ap = await approach(kind, nth, pred);
  if (!ap) throw new Error(`找不到 ${kind} 的前一格`);
  for (const op of pre) await debug(page, typeof op === 'function' ? op(st.seat) : op);
  await debug(page, { op: 'teleport', seat: st.seat, node: ap.node, prev: ap.prev });
  await debug(page, { op: 'forceNext', purpose: 'dice', values: [1] });
  await page.waitForFunction(() => window.__rich4.eventPlayer.idle, undefined, { timeout: 20_000 });
  const d = await page.evaluate(() => window.__rich4.store.game.getState().decision);
  log(`prepare ${page.__name} seat ${st.seat} → tile ${ap.target}（${kind ?? pred}）`);
  return { roll: () => page.evaluate((id) => window.__rich4.client.act({ type: 'ROLL' }, id), d.decisionId) };
}

async function idleAll() {
  for (const p of PAGES) await p.waitForFunction(() => window.__rich4.eventPlayer.idle, undefined, { timeout: 60_000 });
  await A.waitForTimeout(600);
}

async function rowsOf(page) {
  return page.evaluate(() => window.__fn.rows.map((r) => ({ ...r })));
}

async function audioLog(page) {
  return page.evaluate(() => {
    const a = window.__rich4.audio;
    return a ? a.log.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : null;
  });
}

/** 板子出现后读出画面上的文字与画点（舞台逻辑坐标） */
async function boardInfo(page, kind) {
  return page.evaluate((kind) => {
    const root = document.querySelector(`[data-testid="${kind}-popup"]`);
    if (!root) return null;
    const at = (el) => (el ? [el.style.left, el.style.top, el.style.fontSize].join(' ') : null);
    const q = (id) => root.querySelector(`[data-testid="${id}"]`);
    return {
      id: root.getAttribute(kind === 'news' ? 'data-news' : 'data-fate'),
      slot: root.getAttribute('data-slot'),
      category: q('news-category')?.textContent ?? null,
      categoryAt: at(q('news-category')),
      headline: q('news-headline')?.textContent ?? null,
      headlineAt: at(q('news-headline')),
      text: q('fate-text')?.textContent ?? null,
      textAt: at(q('fate-text')),
      amount: q('fate-amount')?.textContent ?? null,
      art: (q('news-art') ?? q('fate-art'))?.style.backgroundImage ?? null,
      rows: [...root.querySelectorAll('[data-testid="news-row"]')].map((r) => `${r.textContent} @${at(r)}`),
      faces: [...root.querySelectorAll('[data-testid="news-face"], [data-testid="fate-face"]')].map(
        (f) => `${f.getAttribute('data-sprite')} @${f.style.left},${f.style.top}`,
      ),
      caret: root.textContent.includes('▌'),
    };
  }, kind);
}

async function setupRoom() {
  await A.goto(`${BASE}/?test=1&who=P1`);
  await A.getByTestId('home-nickname').fill('原文甲');
  await A.getByTestId('home-nickname').blur();
  await A.getByTestId('home-create').click();
  await A.getByTestId('set-map').selectOption(MAP);
  await A.getByTestId('set-timer').selectOption('off');
  await A.getByTestId('set-ai-count').selectOption('0');
  await A.getByTestId('create-submit').click();
  await A.waitForURL(/\/r\/\d{6}/);
  const code = /\/r\/(\d{6})/.exec(A.url())[1];
  log(`room ${code} map ${MAP} view ${VIEW} ${VP.width}x${VP.height}`);
  await B.goto(`${BASE}/?test=1&who=P2`);
  await B.getByTestId('home-nickname').fill('原文乙');
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
  for (const p of PAGES) await p.getByTestId('fly-skip').click({ timeout: 8000 }).catch(() => {});
  for (const p of PAGES) await p.getByTestId('screen-game').waitFor({ timeout: 90_000 });
  await debug(A, { op: 'clearBoard' });
  // 等开局空闲预取把板面图集与插图下完（第一个演出就用原版画面）
  await A.waitForTimeout(6000);
}

// ───────────────────────── 场景 ─────────────────────────

let nth = 0;

/** 命运：page 落到命运格（预置 k），板子出现后截图、读文字 */
async function fate(page, k, name, expectText) {
  const L = await prepareLanding(page, { kind: 'fate', nth: nth++, pre: [{ op: 'stackDeck', deck: 'fate', ids: [k] }] });
  await L.roll();
  await page.locator('[data-testid="fate-popup"][data-phase="board"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('[data-testid="fate-face"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  const info = await boardInfo(page, 'fate');
  await shot(page, `fate${k}-${name}`);
  log(`fate ${k}`, info);
  if (expectText) check(`命运 ${k}（${name}）原文`, expectText.test(info?.text ?? ''), { text: info?.text, slot: info?.slot });
  await idleAll();
  return info;
}

/** 新闻：page 落到新闻格（预置 i），板子出现后截图；other 在 skipAfter 毫秒后点一下板子 */
async function news(page, i, name, { skipAfter = null } = {}) {
  const other = page === A ? B : A;
  const rows0 = { me: (await rowsOf(page)).length, other: (await rowsOf(other)).length };
  const L = await prepareLanding(page, { kind: 'news', nth: nth++, pre: [{ op: 'stackDeck', deck: 'news', ids: [i] }] });
  await L.roll();
  await page.locator('[data-testid="news-popup"]').waitFor({ state: 'visible', timeout: 30_000 });
  const first = await boardInfo(page, 'news');
  let clickT = null;
  if (skipAfter !== null) {
    await other.locator('[data-testid="news-popup"]').waitFor({ state: 'visible', timeout: 30_000 });
    await other.waitForTimeout(skipAfter);
    const box = await other.locator('[data-testid="classic-stage-inner"]').first().boundingBox();
    const s = box.width / 640;
    clickT = await other.evaluate(() => performance.now());
    await other.mouse.click(box.x + 200 * s, box.y + 200 * s);
  }
  // 有逐人名单的新闻（layout.ts NEWS_BOARD_LISTS）等小头像画出来
  if ([0, 1, 2, 3, 8, 9, 10, 11, 12, 13, 16, 17, 23].includes(i))
    await page.locator('[data-testid="news-face"]').first().waitFor({ state: 'visible', timeout: 1200 }).catch(() => {});
  await page.waitForTimeout(250);
  const info = await boardInfo(page, 'news');
  await shot(page, `news${i}-${name}`);
  log(`news ${i}`, info);
  check(`新闻 ${i}（${name}）一出现标题就是整句（没有打字机）`, first?.headline === info?.headline && !first?.caret, {
    first: first?.headline,
  });
  await idleAll();
  const mine = (await rowsOf(page)).slice(rows0.me).find((r) => r.kind === 'news');
  const theirs = (await rowsOf(other)).slice(rows0.other).find((r) => r.kind === 'news');
  const id = Number(mine?.id ?? -1);
  if (id === i) {
    const expect = Math.max(2400, NEWS_VOICE[i]);
    const ms = mine.t1 - mine.t0;
    check(`新闻 ${i}：${page.__name} 的新闻板停留 max(2.4 秒, 语音) = ${expect}`, Math.abs(ms - expect) < 300, { ms, expect });
    if (skipAfter !== null) {
      const ms2 = theirs ? theirs.t1 - theirs.t0 : null;
      const afterClick = theirs && clickT !== null ? Math.round(theirs.t1 - clickT) : null;
      check(
        `新闻 ${i}：${other.__name} 点一下板子即结束（任意放开，没有最短时间），${page.__name} 照常看满`,
        afterClick !== null && afterClick < 400 && ms2 < ms - 500,
        { shown: ms2, afterClick },
      );
    }
  } else {
    log(`news ${i}：实际抽到 ${id}（不可行时引擎跳到下一张）`);
  }
  return { ...info, drawn: id };
}

/** A 买下一块空地（新闻 8「第一大地主」要有人有地） */
async function buyLand() {
  const L0 = await prepareLanding(A, {
    kind: 'property',
    nth: nth++,
    pred: "(t) => typeof t.ref?.lot === 'string'",
  });
  await L0.roll();
  await A.waitForFunction(() => window.__rich4.eventPlayer.idle && !!window.__rich4.store.game.getState().decision, undefined, {
    timeout: 20_000,
  });
  const d = await A.evaluate(() => window.__rich4.store.game.getState().decision?.kind);
  if (d && d !== 'TURN_MENU') await act(A, { type: 'CONFIRM' });
  await idleAll();
}

try {
  await setupRoom();
  if (MAP === 'taiwan') {
    await fate(A, 25, 'inherit', /^意外獲得遺產\d+元$/);
    await fate(B, 17, 'treat', /^請所有人吃大餐\n花費\d+元$/);
    const n11 = await news(A, 11, 'income-tax', { skipAfter: 600 });
    check('新闻 11：分类「政府公告」在 (24,8)、标题在 (24,310)、28px', n11.category === '政府公告' && n11.categoryAt === '24px 8px 28px' && n11.headlineAt === '24px 310px 28px', n11);
    check('新闻 11：两人逐行「<人>繳交<n>元」24px 在 y=346 / 378，小头像图3', n11.rows.length === 2 && n11.rows.every((r) => /繳交\d+元 @24px (346|378)px 24px$/.test(r)) && n11.faces.every((f) => /\/3 @/.test(f)), n11);
    const al = await audioLog(A);
    check('A：原版新闻板没有 ZzFX news，有新闻语音', al !== null && !al.some((x) => /zzfx[.:]news/.test(x)) && al.some((x) => /news\.11|0160/.test(x)), {
      audio: al?.slice(-10),
    });
    const n23 = await news(B, 23, 'bonus');
    check('新闻 23：逐行「<人>得到<n>元」、头像图4', n23.drawn !== 23 || (n23.rows.length > 0 && n23.rows.every((r) => /得到\d+元/.test(r)) && n23.faces.every((f) => /\/4 @/.test(f))), n23);
    const n14 = await news(A, 14, 'haunted');
    check('新闻 14：两行标题（%s 是地块名）、不画人', n14.drawn !== 14 || (/房屋鬧鬼\n地價下跌３０％$/.test(n14.headline ?? '') && n14.faces.length === 0), n14);
    await buyLand();
    const n8 = await news(B, 8, 'landlord');
    check('新闻 8：得奖的一人头像（图4）在 (390,328)', n8.drawn !== 8 || (n8.faces.length === 1 && /\/4 @/.test(n8.faces[0])), n8);
    // A 坐牢（命运 33），B 抽到新闻 0：在押的 A 获释，头像叠在 (390,328)
    await fate(A, 33, 'jail', /^酒醉大鬧警局坐牢3天$/);
    const n0 = await news(B, 0, 'amnesty');
    check('新闻 0：在押的人只画头像（图4）', n0.drawn !== 0 || (n0.faces.length === 1 && /\/4 @/.test(n0.faces[0]) && n0.rows.length === 0), n0);
    // 豪雨（16）之后步行者都停一回合，放在最后
    const n16 = await news(B, 16, 'rain');
    check('新闻 16：只画步行者的头像（图2，(390,358) 起 +32）', n16.drawn !== 16 || (n16.rows.length === 0 && n16.faces.length >= 1 && n16.faces.every((f) => /\/2 @/.test(f))), n16);
  } else {
    const plan = {
      china: [
        [A, 34, 'protest', /^違法聚眾示威坐牢5天$/],
        [B, 36, 'relic', /^盜賣國寶坐牢9天$/],
      ],
      japan: [
        [A, 33, 'minor', /^誘騙未成年少女拘役3天$/],
        [B, 35, 'drugs', /^走私毒品坐牢7天$/],
      ],
      usa: [
        [A, 36, 'secrets', /^盜賣國家機密坐牢9天$/],
        [B, 34, 'assault', /^毆打警員坐牢5天$/],
      ],
    }[MAP];
    for (const [p, k, name, re] of plan) await fate(p, k, name, re);
    await news(A, 11, 'income-tax');
  }
} catch (e) {
  log('ERROR', String(e?.stack ?? e));
  results.push({ name: 'script', ok: false, detail: String(e) });
  for (const p of PAGES) await shot(p, 'error').catch(() => {});
} finally {
  for (const p of PAGES) if (p.__errs.length) log(`${p.__name} errors`, p.__errs.slice(0, 10));
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
  const bad = results.filter((r) => !r.ok);
  log(`done：${results.length} 项，失败 ${bad.length}`);
  await browser.close();
}
