// 验证（随机事件的原版画面，真实素材包目视）：自己起一个无头 Chrome（系统 Chrome），开三个互相隔离的页面
// P1 / P2（两名真人，手牌私密）与 W（观战），按场景逐类触发事件（命运、新闻、卡片格、聖誕節、魔法屋、董事长赠品、礼物、加持），
// 三页各自用 MutationObserver 记下每个演出弹窗（种类、是否原版画面、出现 / 消失时刻、插图键、插图实际尺寸、头像、字色、文案）
// 与 toast，弹窗首次就绪时三页各截一张图。产物写到 .cache/evcard/verify/<场景>/（含原版素材，不入库）。
// 先起本机服务（验证端口 4231 / 6231，本机例外：未设门禁的素材包，只监听回环）：
//   (apps/server) PORT=4231 HOST=127.0.0.1 PUBLIC_URL=http://localhost:6231 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=<repo>/rich4-assets RICH4_DATA_DIR=<repo>/rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=<repo>/.cache/evcard/verify-data npx tsx src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:4231 npx vite --port 6231 --strictPort
// 用法：node test/evcard-verify.mjs <地图 taiwan|china|japan|usa> <desktop|mobile> <步骤,步骤…>
//   步骤：fate:<k>[@A|@B]、news:<i>、square[@A|@B]、xmas、magic、chairman、gift、bless、pardon（给两人各一张免罪卡）
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.EVV_BASE ?? 'http://localhost:6231';
const [MAP = 'taiwan', VIEW = 'desktop', PLAN = 'fate:3'] = process.argv.slice(2);
const TAG = `${MAP}-${VIEW}${process.env.EVV_PACING ? `-${process.env.EVV_PACING}` : ''}`;
const OUT = `${process.env.EVV_OUT ?? '.cache/evcard/verify'}/${TAG}`;
mkdirSync(OUT, { recursive: true });
const VP = VIEW === 'mobile' ? { width: 844, height: 390 } : { width: 1920, height: 1080 };

function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  appendFileSync(`${OUT}/verify.log`, `[${new Date().toISOString().slice(11, 23)}] ${line}\n`);
}

/** 页面脚本之前装的记录器：window.__evv.rows（每个演出弹窗一行）与 window.__evv.toasts */
function recorder() {
  const rows = [];
  const els = [];
  const toasts = [];
  const now = () => Math.round(performance.now());
  window.__evv = { rows, toasts };
  const rgb = (el) => (el ? getComputedStyle(el).color : null);
  const bgUrl = (el) => {
    const m = /url\("?(.*?)"?\)/.exec(el ? el.style.backgroundImage || getComputedStyle(el).backgroundImage : '');
    return m ? m[1] : null;
  };
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const detail = (pop) => {
    const d = {};
    const fate = pop.querySelector('[data-testid="fate-popup"]');
    if (fate) {
      const art = fate.querySelector('[data-testid="fate-art"]');
      Object.assign(d, {
        fate: Number(fate.dataset.fate),
        slot: fate.dataset.slot === undefined ? null : Number(fate.dataset.slot),
        phase: fate.dataset.phase ?? null,
        board: fate.querySelector('[data-testid="fate-board"]')?.getAttribute('data-sprite') ?? null,
        artKey: art?.dataset.assetKey ?? fate.querySelector('[data-testid="fate-art-blank"]')?.dataset.assetKey ?? null,
        artUrl: bgUrl(art),
        artBlank: !!fate.querySelector('[data-testid="fate-art-blank"]'),
        face: fate.querySelector('[data-testid="fate-face"]')?.getAttribute('data-sprite') ?? null,
        title: txt(fate.querySelector('[data-testid="fate-title"]') ?? fate.querySelector('h2')),
        text: txt(fate.querySelector('[data-testid="fate-text"]')),
        amount: txt(fate.querySelector('[data-testid="fate-amount"]')),
        blessing: txt(fate.querySelector('[data-testid="fate-blessing"]')),
        colors: {
          title: rgb(fate.querySelector('[data-testid="fate-title"]') ?? fate.querySelector('h2')),
          text: rgb(fate.querySelector('[data-testid="fate-text"]')),
        },
        rect: (() => {
          const r = fate.getBoundingClientRect();
          return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
        })(),
      });
    }
    const cast = pop.querySelector('[data-testid="card-cast-popup"]');
    if (cast) {
      const art = cast.querySelector('[data-testid="card-cast-art"]');
      Object.assign(d, {
        card: cast.dataset.card === undefined ? null : Number(cast.dataset.card),
        variant: cast.dataset.variant ?? null,
        mode: cast.dataset.mode ?? null,
        gainFrom: cast.dataset.gainFrom ?? null,
        artKey: art?.dataset.assetKey ?? null,
        artUrl: bgUrl(art),
        line: txt(cast.querySelector('[data-testid="card-cast-line"]')) ?? txt(cast),
        procIcon: txt(cast.querySelector('[class*="cardIcon"]')),
      });
    }
    const news = pop.querySelector('[data-testid="news-popup"]');
    if (news) {
      const art = news.querySelector('[data-testid="news-art"]');
      Object.assign(d, { news: Number(news.dataset.news), artKey: art?.dataset.assetKey ?? null, artUrl: bgUrl(art) });
    }
    const magic = pop.querySelector('[data-testid="magic-popup"]');
    if (magic) {
      Object.assign(d, {
        magic: txt(magic),
        magicBox: !!magic.querySelector('[data-testid="magic-box"]'),
        imgs: magic.querySelectorAll('img').length,
        color: rgb(magic.querySelector('[data-testid="magic-title"]') ?? magic.querySelector('h2,h3,p')),
      });
    }
    return d;
  };
  const scan = () => {
    for (const pop of document.querySelectorAll('[data-testid="popup"]')) {
      let i = els.indexOf(pop);
      if (i < 0) {
        i = els.length;
        els.push(pop);
        rows.push({ n: i, kind: pop.getAttribute('data-kind'), classic: pop.getAttribute('data-classic') === 'true', t0: now(), t1: null, d: {} });
      }
      const d = detail(pop);
      // 弹窗里的元素可能换（命运板 → 加持框），把首次出现的值与最新值都留着
      rows[i].first ??= Object.keys(d).length ? d : null;
      rows[i].d = d;
    }
    for (let i = 0; i < els.length; i++) if (rows[i].t1 === null && !els[i].isConnected) rows[i].t1 = now();
    for (const t of document.querySelectorAll('[data-testid="toast"]')) {
      if (t.__evv) continue;
      t.__evv = 1;
      toasts.push({ t: now(), text: t.textContent.replace('×', '').trim() });
    }
  };
  new MutationObserver(scan).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'data-sprite', 'data-src', 'data-phase', 'data-mode'],
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
  page.__reqs = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/pack/')) page.__reqs.push({ t: Date.now(), p: u.pathname });
  });
  page.on('response', (r) => {
    if (r.status() >= 400) page.__errs.push(`http ${r.status()} ${r.url()}`);
  });
  return page;
}
const A = await openPage('A');
const B = await openPage('B');
// 可选：B 页拦掉某些素材包文件（EVV_BLOCK_B 为正则），看素材不全时的回退画面
if (process.env.EVV_BLOCK_B) {
  const re = new RegExp(process.env.EVV_BLOCK_B);
  await B.route((u) => re.test(u.pathname), (r) => r.abort());
}
const W = await openPage('W');
const PAGES = [A, B, W];

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

/** 两名真人按默认应答（skip 返回 true 的那一刻除外），直到 until() 为真 */
async function pump(until, { timeout = 240_000, skip = async () => false } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await until()) return;
    for (const p of [A, B]) {
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
      const [s, o, w] = await Promise.all([state(page), state(other), state(W)]);
      return s.idle && o.idle && w.idle && s.decision?.kind === 'TURN_MENU' && s.submitting === null;
    },
    { skip: async (p, st) => p === page && st.decision.kind === 'TURN_MENU' },
  );
}

/** 地图上某类格子的「前一格」：从 node 以 prev 为来路掷 1 正好落到目标格（node 只有两条路，不经岔路） */
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

const shots = [];
// 同一场景目录多次运行时编号接着往下排
const shotBase = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
async function shot(page, name) {
  const file = `${OUT}/${String(shotBase + shots.length + 1).padStart(3, '0')}-${name}-${page.__name}.png`;
  await page.screenshot({ path: file });
  shots.push(file);
  return file;
}

async function rowsOf(page) {
  return page.evaluate(() => ({ rows: window.__evv.rows, toasts: window.__evv.toasts, now: Math.round(performance.now()) }));
}

/** 插图 URL 的实际尺寸（确认贴的是真图、解码成功） */
async function natural(page, url) {
  if (!url) return null;
  return page.evaluate(async (u) => {
    const i = new Image();
    i.src = u;
    try {
      await i.decode();
      return [i.naturalWidth, i.naturalHeight];
    } catch (e) {
      return `decode failed: ${e.message}`;
    }
  }, url);
}

/**
 * 观察三页直到安静：新弹窗出现、且原版画面的插图（若有）已就绪时各截一张；结束时返回每页这段时间内的弹窗行与 toast
 */
async function observe(tag, { ms = 30_000, quiet = 2500, want = () => true, action = null } = {}) {
  const base = {};
  for (const p of PAGES) base[p.__name] = await rowsOf(p);
  if (action) await action();
  const shotDone = new Set();
  const t0 = Date.now();
  let lastActivity = Date.now();
  while (Date.now() - t0 < ms) {
    for (const p of PAGES) {
      const r = await rowsOf(p);
      const fresh = r.rows.slice(base[p.__name].rows.length);
      // toast（不亮卡的得卡途径只有 toast）：每页第一条出现时截一张
      if (r.toasts.length > base[p.__name].toasts.length && !shotDone.has(`${p.__name}:toast`)) {
        shotDone.add(`${p.__name}:toast`);
        await shot(p, `${tag}-toast`);
      }
      for (const row of fresh) {
        if (row.t1 === null) lastActivity = Date.now();
        const key = `${p.__name}:${row.n}:${row.d.phase ?? ''}`;
        if (shotDone.has(key) || row.t1 !== null || !want(row)) continue;
        const d = row.d;
        const needsArt = row.classic && (d.fate !== undefined || d.news !== undefined) && d.phase !== 'blessing';
        if (needsArt && !d.artUrl) continue;
        if (row.classic && d.fate !== undefined && d.phase !== 'blessing' && !d.face) continue;
        shotDone.add(key);
        // 等一帧淡入
        await p.waitForTimeout(250);
        await shot(p, `${tag}-${row.kind}${d.phase ? `-${d.phase}` : ''}`);
      }
    }
    const sts = await Promise.all(PAGES.map((p) => state(p)));
    if (sts.some((s) => !s.idle)) lastActivity = Math.max(lastActivity, Date.now() - 1);
    if (Date.now() - lastActivity > quiet && sts.every((s) => s.idle)) break;
    await A.waitForTimeout(80);
  }
  const res = {};
  for (const p of PAGES) {
    const r = await rowsOf(p);
    const rows = r.rows.slice(base[p.__name].rows.length);
    for (const row of rows) {
      row.ms = row.t1 === null ? null : row.t1 - row.t0;
      const url = row.d.artUrl ?? row.first?.artUrl;
      if (url) row.natural = await natural(p, url);
    }
    res[p.__name] = { rows, toasts: r.toasts.slice(base[p.__name].toasts.length) };
  }
  log(`== ${tag}`);
  for (const [who, v] of Object.entries(res)) {
    for (const row of v.rows) {
      const { first, d, ...rest } = row;
      log(`  ${who} popup`, { ...rest, d });
    }
    if (v.toasts.length) log(`  ${who} toasts`, v.toasts.map((t) => t.text));
  }
  appendFileSync(`${OUT}/records.jsonl`, `${JSON.stringify({ tag, res })}\n`);
  return res;
}

/** 本页座位走到目标格：预置 pre，传送到前一格，骰子 1，掷骰并观察 */
async function landOn(page, tag, { kind, nth = 0, pred = null, pre = [], ms = 30_000 }) {
  await toTurn(page);
  const st = await state(page);
  const ap = await approach(kind, nth, pred);
  if (!ap) throw new Error(`${tag}: 找不到 ${kind} 的前一格`);
  for (const op of pre) await debug(page, typeof op === 'function' ? op(st.seat) : op);
  await debug(page, { op: 'teleport', seat: st.seat, node: ap.node, prev: ap.prev });
  await debug(page, { op: 'forceNext', purpose: 'dice', values: [1] });
  await page.waitForFunction(() => window.__rich4.eventPlayer.idle, undefined, { timeout: 20_000 });
  const d = await page.evaluate(() => window.__rich4.store.game.getState().decision);
  log(`trigger ${tag} by ${page.__name} seat ${st.seat} → tile ${ap.target}（${kind}）`);
  return observe(tag, {
    ms,
    action: () => page.evaluate((id) => window.__rich4.client.act({ type: 'ROLL' }, id), d.decisionId),
  });
}

async function view(page) {
  return page.evaluate(() => window.__rich4.store.game.getState().view);
}

async function setupRoom() {
  await A.goto(`${BASE}/?test=1&who=P1`);
  await A.getByTestId('home-nickname').fill('驗證甲');
  await A.getByTestId('home-nickname').blur();
  await A.getByTestId('home-create').click();
  await A.getByTestId('set-map').selectOption(MAP);
  await A.getByTestId('set-timer').selectOption('off');
  await A.getByTestId('set-ai-count').selectOption('0');
  // 可选：演出节奏（EVV_PACING=compact）
  if (process.env.EVV_PACING) await A.getByTestId('set-pacing').selectOption(process.env.EVV_PACING);
  await A.getByTestId('create-submit').click();
  await A.waitForURL(/\/r\/\d{6}/);
  const code = /\/r\/(\d{6})/.exec(A.url())[1];
  log(`room ${code} map ${MAP} view ${VIEW} ${VP.width}x${VP.height}`);
  await B.goto(`${BASE}/?test=1&who=P2`);
  await B.getByTestId('home-nickname').fill('驗證乙');
  await B.getByTestId('home-nickname').blur();
  await B.goto(`${BASE}/r/${code}?test=1&who=P2`);
  await B.getByTestId('screen-room').waitFor();
  await W.goto(`${BASE}/?test=1&who=W`);
  await W.getByTestId('home-nickname').fill('觀戰');
  await W.getByTestId('home-nickname').blur();
  await W.goto(`${BASE}/r/${code}?test=1&who=W&watch=1`);
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
  const info = await A.evaluate(() => ({
    skin: JSON.stringify(window.__rich4.skin ?? null).slice(0, 300),
    settings: window.__rich4.store.room.getState().room?.settings ?? null,
    gm: Object.values(window.__rich4.store.map.getState().entries).find((e) => e.def)?.def.globalMapId ?? null,
  }));
  log('room info', info);
  writeFileSync(`${OUT}/.room`, code);
}

const who = (s) => (s === 'B' ? B : A);

async function step(spec) {
  const [head, at] = spec.split('@');
  const [name, arg, arg2] = head.split(':');
  const page = who(at ?? (name === 'square' ? 'A' : 'A'));
  switch (name) {
    case 'fate': {
      const k = Number(arg);
      return landOn(page, `fate${k}${at ?? ''}`, { kind: 'fate', pre: [{ op: 'stackDeck', deck: 'fate', ids: [k] }] });
    }
    case 'news': {
      const i = Number(arg);
      return landOn(page, `news${i}${at ?? ''}`, { kind: 'news', pre: [{ op: 'stackDeck', deck: 'news', ids: [i] }] });
    }
    case 'square':
      return landOn(page, `square${at ?? ''}`, { kind: 'card' });
    case 'pardon': {
      await toTurn(A);
      for (const s of [0, 1]) await debug(A, { op: 'give', seat: s, cards: [21], items: [] });
      log('gave pardon to both');
      return null;
    }
    case 'magic': {
      // 点名（magicCond 预置为 arg）→ 施法者选「得到 1 張卡」（效果 6）
      await landOn(page, `magic-cond${at ?? ''}`, {
        kind: 'magic',
        nth: Number(arg2 || 0),
        pre: arg ? [{ op: 'forceNext', purpose: 'magicCond', values: [Number(arg)] }] : [],
      });
      const d = await page.evaluate(() => window.__rich4.store.game.getState().decision);
      log('magic decision', d?.kind, JSON.stringify(d?.options ?? null).slice(0, 300));
      if (d?.kind !== 'MAGIC_CAST') return null;
      await shot(page, 'magic-decision');
      return observe(`magic-cast6${at ?? ''}`, {
        action: () => page.evaluate((id) => window.__rich4.client.act({ type: 'MAGIC_CAST', effect: 6 }, id), d.decisionId),
      });
    }
    case 'xmas': {
      // 送卡的节日（聖誕節）前一天 → 走完一格，换日时 HOLIDAY → 每人 CARD_GAINED{holiday}
      await toTurn(page);
      const h = await A.evaluate(() => {
        const def = Object.values(window.__rich4.store.map.getState().entries).find((e) => e.def)?.def;
        return def.holidays.find((x) => x.giveCard) ?? null;
      });
      const v = await view(page);
      const y = Math.trunc(v.clock.date / 10000);
      const date = y * 10000 + h.month * 100 + h.day - 1;
      log('xmas holiday', h, 'setDate', date);
      await debug(page, { op: 'setDate', date });
      for (let i = 0; i < 3; i++) {
        const p = i % 2 === 0 ? page : page === A ? B : A;
        const r = await landOn(p, `xmas-${i}`, { kind: 'plain', nth: i, ms: 45_000 });
        if (Object.values(r).some((x) => x.rows.some((row) => row.kind === 'cardCast'))) break;
      }
      return null;
    }
    case 'chairman': {
      // 平日开市 → 买进每支股票 100 股（成为董事长）→ 走到百货公司（chairmanGift 预置 arg：0 送卡、1 送道具）。
      // 回合菜单的股市选项在出菜单时算好：改日期后先走完一轮，下一次回合菜单才按新日期开市
      await toTurn(page);
      const st = await state(page);
      let stock = await page.evaluate(() => window.__rich4.store.game.getState().decision?.options?.stock ?? null);
      if (!stock?.open) {
        const v = await view(page);
        const y = Math.trunc(v.clock.date / 10000);
        // 10 月 11 日（2010 年是星期一；避开大陆图的国庆长假休市），走完一轮后是平日
        await debug(page, { op: 'setDate', date: y * 10000 + 1011 });
        await landOn(page, `chairman-pass${at ?? ''}`, { kind: 'plain', nth: 3 });
        await toTurn(page);
        stock = await page.evaluate(() => window.__rich4.store.game.getState().decision?.options?.stock ?? null);
      }
      log('stock open', stock?.open, stock?.reason);
      for (const r of stock?.rows ?? []) {
        if (!r.maxBuy || r.chairman !== null) continue;
        const d = await page.evaluate(() => window.__rich4.store.game.getState().decision);
        const res = await page.evaluate(
          ({ id, idx }) => window.__rich4.client.act({ type: 'STOCK_BUY', stock: idx, shares: 100 }, id),
          { id: d.decisionId, idx: r.idx },
        );
        log('buy', r.idx, JSON.stringify(res));
        await page.waitForTimeout(400);
        await page.waitForFunction(
          () =>
            window.__rich4.eventPlayer.idle && window.__rich4.store.game.getState().decision?.kind === 'TURN_MENU',
          undefined,
          { timeout: 20_000 },
        );
      }
      const r = await landOn(page, `chairman${arg ?? 0}${at ?? ''}`, {
        kind: 'shop',
        pre: [{ op: 'forceNext', purpose: 'chairmanGift', values: [Number(arg || 0)] }],
      });
      log('seat', st.seat);
      return r;
    }
    case 'gift': {
      // 路上的礼物盒：走到它所在的格子
      await toTurn(page);
      const v = await view(page);
      const g = (v.objects ?? []).find((o) => o.kind === 'gift');
      log('gift objects', JSON.stringify((v.objects ?? []).filter((o) => o.kind === 'gift')));
      if (!g) return null;
      const node = g.node ?? g.at ?? g.tile;
      return landOn(page, `gift${at ?? ''}`, { kind: null, pred: `(t) => t.id === ${node}` });
    }
    case 'god': {
      // 附身：走到路上的某种神明（arg = GodKind）
      await toTurn(page);
      const v = await view(page);
      log('gods', JSON.stringify(v.gods));
      const g = (v.gods ?? []).find((x) => x.kind === Number(arg) && x.where?.t === 'road');
      if (!g) return null;
      return landOn(page, `god${arg}${at ?? ''}`, { kind: null, pred: `(t) => t.id === ${g.where.node}` });
    }
    case 'blessfate': {
      // arg = 命运编号；bless 预置 1（50 < 运势 ≤ 100 时 rand & 1 = 1 → high）
      const k = Number(arg);
      return landOn(page, `blessfate${k}${at ?? ''}`, {
        kind: 'fate',
        pre: [
          { op: 'stackDeck', deck: 'fate', ids: [k] },
          { op: 'forceNext', purpose: 'bless', values: [1] },
        ],
      });
    }
    case 'plain':
      return landOn(page, `plain${at ?? ''}`, { kind: 'plain', nth: Number(arg || 0) });
    default:
      throw new Error(`unknown step ${spec}`);
  }
}

const H = { A, B, W, PAGES, log, state, debug, act, pump, toTurn, approach, landOn, observe, shot, view, rowsOf, step, OUT };

try {
  await setupRoom();
  for (const s of PLAN.split(',').filter(Boolean)) {
    if (s.startsWith('js:')) {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      await new AsyncFunction(...Object.keys(H), s.slice(3))(...Object.values(H));
      continue;
    }
    try {
      await step(s);
    } catch (e) {
      log(`STEP ${s} ERROR ${e.stack ?? e}`);
    }
  }
  if (process.env.EVV_SCRIPT) {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction(...Object.keys(H), readFileSync(process.env.EVV_SCRIPT, 'utf8'))(...Object.values(H));
  }
} catch (e) {
  log(`ERROR ${e.stack ?? e}`);
  process.exitCode = 1;
} finally {
  for (const p of PAGES) if (p.__errs.length) log(`errs ${p.__name}`, p.__errs.slice(0, 30));
  log('shots', shots.length);
  await browser.close();
}
