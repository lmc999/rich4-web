// 调试脚本（随机事件原版画面的审查修复，真实素材包目视）：自己起一个无头 Chrome（系统 Chrome），开三个互相隔离的页面
// P1（A）/ P2（B）两名真人与观战者 W，逐项确认：
// 1) 命运板盖着工具列：A 抽命运时，B 在板子上点舞台 (100,20)（「托管」的位置）、W 点 (260,20)（「查询」）——
//    只结束各自的命运板，托管不切换、资产表不打开；elementFromPoint 落在板面的接住层上；
// 2) 板子期间按键：B 按 M、W 按 <（,）——板子结束，大地图不打开；
// 3) 新闻板同样接住：W 在最短时间之前点板子不跳过也不穿透，之后点板子跳过；
// 4) 命运板之后的画面（按 exe 处理函数）：重画类（14 闯红灯）板子只停语音长度、关板后立即飘字；留板类（3 支票跳票）
//    板子留到 0.8 秒停顿结束；征收（1）关板后镜头移到地块；
// 5) 音频日志：原版命运板开头没有 ZzFX card。
// 产物写到 .cache/evcard/fix/<场景>/（含原版素材，不入库）。先起本机服务（修复端口 4261 / 6261，本机例外：未设门禁的素材包，只监听回环）：
//   (apps/server) PORT=4261 HOST=127.0.0.1 PUBLIC_URL=http://localhost:6261 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=<repo>/rich4-assets RICH4_DATA_DIR=<repo>/rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=<repo>/.cache/evcard/fix/data npx tsx src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:4261 npx vite --port 6261 --strictPort
// 用法：node test/evcard-fix.mjs [地图 taiwan|china|japan|usa] [desktop|mobile]
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.EVV_BASE ?? 'http://localhost:6261';
const [MAP = 'taiwan', VIEW = 'desktop'] = process.argv.slice(2);
const OUT = `.cache/evcard/fix/${MAP}-${VIEW}`;
mkdirSync(OUT, { recursive: true });
const VP = VIEW === 'mobile' ? { width: 844, height: 390 } : { width: 1920, height: 1080 };
const results = [];

function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  appendFileSync(`${OUT}/fix.log`, `[${new Date().toISOString().slice(11, 23)}] ${line}\n`);
}

function check(name, ok, detail = {}) {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail);
}

/** 页面脚本之前装的记录器：window.__fix.rows（新闻板 / 命运板每出现一次一行：出现、消失时刻） */
function recorder() {
  const rows = [];
  const els = new Map();
  const now = () => Math.round(performance.now());
  window.__fix = { rows };
  const scan = () => {
    const live = new Set();
    for (const el of document.querySelectorAll('[data-scene="classic"][data-kind]')) {
      const kind = el.getAttribute('data-kind');
      if (kind !== 'fate' && kind !== 'news') continue;
      if (el.getAttribute('data-testid') !== 'popup') continue;
      const phase = el.querySelector('[data-testid="fate-popup"]')?.getAttribute('data-phase') ?? null;
      const key = `${kind}:${phase}`;
      live.add(el);
      if (!els.has(el) || els.get(el).key !== key) {
        const row = { kind, phase, t0: now(), t1: null, shield: !!el.querySelector('[data-testid="popup-shield"]') };
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
    attributeFilter: ['data-testid', 'data-phase'],
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

/** 两名真人按默认应答（answer 返回非 null 时用它的 intent），直到 until() 为真 */
async function pump(until, { timeout = 240_000, skip = async () => false, answer = () => null } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await until()) return;
    for (const p of [A, B]) {
      const st = await state(p);
      if (!st.idle || !st.decision || st.submitting !== null) continue;
      if (st.decision.seat !== undefined && st.decision.seat !== st.seat) continue;
      if (await skip(p, st)) continue;
      await act(p, answer(p, st));
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
async function shot(page, name) {
  const file = `${OUT}/${String(++shotN).padStart(3, '0')}-${name}-${page.__name}.png`;
  await page.screenshot({ path: file });
  return file;
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
  return { target: ap.target, roll: () => page.evaluate((id) => window.__rich4.client.act({ type: 'ROLL' }, id), d.decisionId) };
}

async function idleAll() {
  for (const p of PAGES) await p.waitForFunction(() => window.__rich4.eventPlayer.idle, undefined, { timeout: 60_000 });
  await A.waitForTimeout(600);
}

/** 板子（kind / phase）出现后，舞台逻辑坐标 → 屏幕坐标；板子没出现返回 null */
async function boardPoint(page, kind, x, y, timeout = 30_000) {
  const sel =
    kind === 'fate' ? '[data-testid="fate-popup"][data-phase="board"]' : '[data-testid="news-popup"]';
  await page.locator(sel).waitFor({ state: 'visible', timeout });
  const box = await page.locator(`[data-scene="classic"][data-kind="${kind}"][data-testid="popup"]`).first().boundingBox();
  const s = box.width / 640;
  return { x: box.x + x * s, y: box.y + y * s };
}

/** 屏幕坐标上命中的元素 */
async function hitAt(page, pt) {
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? `${el.tagName} ${el.getAttribute('data-testid') ?? ''} ${el.getAttribute('data-tool') ?? ''}`.trim() : null;
  }, pt);
}

async function rowsOf(page) {
  return page.evaluate(() => window.__fix.rows.map((r) => ({ ...r })));
}

async function audioLog(page) {
  return page.evaluate(() => {
    const a = window.__rich4.audio;
    return a ? a.log.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : null;
  });
}

async function setupRoom() {
  await A.goto(`${BASE}/?test=1&who=P1`);
  await A.getByTestId('home-nickname').fill('修復甲');
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
  await B.getByTestId('home-nickname').fill('修復乙');
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
  await debug(A, { op: 'clearBoard' });
  // 等开局空闲预取把板面图集与插图下完（第一个演出就用原版画面）
  await A.waitForTimeout(6000);
}

// ───────────────────────── 场景 ─────────────────────────

/** 1) 命运 14（闯红灯，重画类）：B 点「托管」位置、W 点「查询」位置；A 的板子只停语音长度 */
async function fateClick() {
  const L = await prepareLanding(A, { kind: 'fate', pre: [{ op: 'stackDeck', deck: 'fate', ids: [14] }] });
  const autoBefore = await B.getByTestId('action-autopilot').getAttribute('aria-pressed');
  const rows0 = { A: (await rowsOf(A)).length, B: (await rowsOf(B)).length, W: (await rowsOf(W)).length };
  await L.roll();
  const pb = await boardPoint(B, 'fate', 100, 20);
  const pw = await boardPoint(W, 'fate', 260, 20);
  const hitB = await hitAt(B, pb);
  const hitW = await hitAt(W, pw);
  await shot(A, 'fate14-board');
  await B.mouse.click(pb.x, pb.y);
  await W.mouse.click(pw.x, pw.y);
  await B.waitForTimeout(300);
  await shot(B, 'fate14-after-click');
  await shot(W, 'fate14-after-click');
  // A：板子关掉那一刻截图（地图 + 飘字）
  await A.locator('[data-testid="fate-popup"][data-phase="board"]').waitFor({ state: 'detached', timeout: 15_000 });
  await A.waitForTimeout(150);
  await shot(A, 'fate14-after-board');
  await idleAll();
  const rA = (await rowsOf(A)).slice(rows0.A);
  const rB = (await rowsOf(B)).slice(rows0.B);
  const rW = (await rowsOf(W)).slice(rows0.W);
  const boardA = rA.find((r) => r.kind === 'fate' && r.phase === 'board');
  const boardB = rB.find((r) => r.kind === 'fate' && r.phase === 'board');
  const boardW = rW.find((r) => r.kind === 'fate' && r.phase === 'board');
  check('命运板：B 点 (100,20) 命中板面接住层', /popup-shield/.test(hitB ?? ''), { hitB });
  check('命运板：W 点 (260,20) 命中板面接住层', /popup-shield/.test(hitW ?? ''), { hitW });
  const autoAfter = await B.getByTestId('action-autopilot').getAttribute('aria-pressed');
  check('B 点板子后托管没切换', autoAfter === autoBefore, { autoBefore, autoAfter });
  check('B / W 点板子后没开资产表', (await B.getByTestId('classic-assets').count()) + (await W.getByTestId('classic-assets').count()) === 0);
  check('B / W 的命运板被点一下就结束（A 照常看满）', boardB && boardW && boardB.t1 - boardB.t0 < 2500 && boardW.t1 - boardW.t0 < 2500, {
    B: boardB && boardB.t1 - boardB.t0,
    W: boardW && boardW.t1 - boardW.t0,
  });
  const hold = 2957; // 命运 14 语音（FATE_VOICE_MS[14]），> 1.6 秒
  const msA = boardA ? boardA.t1 - boardA.t0 : null;
  check('A：重画类命运板只停语音长度（不含 0.8 秒停顿）', msA !== null && Math.abs(msA - hold) < 250, { msA, expect: hold });
  const al = await audioLog(A);
  // 罚金在随后的 MONEY 里（金币声 zzfx.coin）：关板后紧接着出，不再先空等 0.8 秒
  const coin = (al ?? [])
    .map((x) => {
      try {
        return JSON.parse(x);
      } catch {
        return null;
      }
    })
    .find((x) => x && x.kind === 'sfx' && x.key === 'zzfx.coin' && boardA && x.t >= boardA.t1 - 50);
  const gap = coin && boardA ? Math.round(coin.t - boardA.t1) : null;
  check('A：关板后罚金（MONEY 的金币声）紧接着出（< 400 ms）', gap !== null && gap < 400, { gap });
  // 命运 14 的语音是 Speaking.mkf #0199（#0185 + slot）
  check('A：原版命运板开头没有 ZzFX card（有命运语音 0199）', al !== null && !al.some((x) => /zzfx[.:]card/.test(x)) && al.some((x) => /0199|fate\.14/.test(x)), {
    audio: al?.slice(-12),
  });
}

/** 2) 命运 3（支票跳票，留板类）：B 按 M、W 按 <；A 的板子停语音 + 0.8 秒 */
async function fateKeys() {
  const L = await prepareLanding(A, { kind: 'fate', nth: 1, pre: [{ op: 'stackDeck', deck: 'fate', ids: [3] }] });
  const rows0 = { A: (await rowsOf(A)).length, B: (await rowsOf(B)).length, W: (await rowsOf(W)).length };
  const bigBefore = await B.getByTestId('tool-bigmap').getAttribute('aria-pressed');
  await L.roll();
  await boardPoint(B, 'fate', 0, 0);
  await boardPoint(W, 'fate', 0, 0);
  await B.locator('body').focus().catch(() => {});
  await B.keyboard.press('m');
  await W.keyboard.press(',');
  await B.waitForTimeout(400);
  await shot(B, 'fate3-after-key');
  await idleAll();
  const bigAfter = await B.getByTestId('tool-bigmap').getAttribute('aria-pressed');
  check('B 按 M 跳过命运板，大地图没打开', bigAfter === bigBefore && bigAfter !== 'true', { bigBefore, bigAfter });
  const rB = (await rowsOf(B)).slice(rows0.B).find((r) => r.kind === 'fate' && r.phase === 'board');
  const rW = (await rowsOf(W)).slice(rows0.W).find((r) => r.kind === 'fate' && r.phase === 'board');
  check('B / W 按键放开即结束命运板', rB && rW && rB.t1 - rB.t0 < 2500 && rW.t1 - rW.t0 < 2500, {
    B: rB && rB.t1 - rB.t0,
    W: rW && rW.t1 - rW.t0,
  });
  const rA = (await rowsOf(A)).slice(rows0.A).find((r) => r.kind === 'fate' && r.phase === 'board');
  const msA = rA ? rA.t1 - rA.t0 : null;
  check('A：留板类命运板停语音 + 0.8 秒', msA !== null && Math.abs(msA - (3706 + 800)) < 250, { msA, expect: 4506 });
}

/** 3) 新闻 11：W 在最短时间之前点板子（不跳过、不穿透），之后再点（跳过） */
async function newsClick() {
  const L = await prepareLanding(B, { kind: 'news', pre: [{ op: 'stackDeck', deck: 'news', ids: [11] }] });
  const rows0 = (await rowsOf(W)).length;
  await L.roll();
  const pw = await boardPoint(W, 'news', 260, 20);
  const hit = await hitAt(W, pw);
  await W.mouse.click(pw.x, pw.y);
  await W.waitForTimeout(200);
  const stillUp = await W.locator('[data-testid="news-popup"]').count();
  await W.locator('[data-testid="popup-skip"]').waitFor({ state: 'visible', timeout: 5000 });
  await shot(W, 'news-skippable');
  await W.mouse.click(pw.x, pw.y);
  await W.waitForTimeout(300);
  const after = await W.locator('[data-testid="news-popup"]').count();
  await idleAll();
  const r = (await rowsOf(W)).slice(rows0).find((x) => x.kind === 'news');
  check('新闻板：W 点 (260,20) 命中板面接住层', /popup-shield/.test(hit ?? ''), { hit });
  check('新闻板：最短时间之前点板子不跳过', stillUp === 1, { stillUp });
  check('新闻板：可跳过之后点板子即结束', after === 0, { after, ms: r && r.t1 - r.t0 });
  check('新闻板：W 没开资产表', (await W.getByTestId('classic-assets').count()) === 0);
}

/** 4) 征收（命运 1）：A 先买一块空地，再抽命运 1 → 关板后镜头移到那块地 */
async function fateFocus() {
  // 买地：走到一块没人的地产格，买下
  const L0 = await prepareLanding(A, {
    kind: 'property',
    nth: 2,
    pred: "(t) => typeof t.ref?.lot === 'string' && t.ref.lot.startsWith('L')",
  });
  await L0.roll();
  await A.waitForFunction(() => window.__rich4.eventPlayer.idle && !!window.__rich4.store.game.getState().decision, undefined, {
    timeout: 20_000,
  });
  const d = await A.evaluate(() => window.__rich4.store.game.getState().decision?.kind);
  log('after landing property decision', d);
  if (d && d !== 'TURN_MENU') await act(A, { type: 'CONFIRM' });
  await idleAll();
  const owned = await A.evaluate(() => {
    const v = window.__rich4.store.game.getState().view;
    return v.lands.filter((l) => l.owner === 0 && l.level === 0).map((l) => l.id);
  });
  log('A owns empty lands', owned);
  if (owned.length === 0) {
    check('征收：A 有空地可被征收（前置）', false, { owned });
    return;
  }
  const L = await prepareLanding(A, { kind: 'fate', nth: 2, pre: [{ op: 'stackDeck', deck: 'fate', ids: [1] }] });
  await L.roll();
  await A.locator('[data-testid="fate-popup"][data-phase="board"]').waitFor({ state: 'visible', timeout: 30_000 });
  await shot(A, 'fate1-board');
  // 买下的那块地离棋盘画布中心多远（镜头对准它时接近 0）
  const offCenter = () =>
    A.evaluate((tile) => {
      const p = window.__rich4.board.tileScreenPos(tile);
      const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!p || !c) return null;
      return Math.round(Math.hypot(p.x - c.clientWidth / 2, p.y - c.clientHeight / 2));
    }, L0.target);
  const before = await offCenter();
  await A.locator('[data-testid="fate-popup"][data-phase="board"]').waitFor({ state: 'detached', timeout: 15_000 });
  // 关板之后每 60 ms 记一次地块离画布中心的距离（镜头先移过去，之后跟随会拉回行动者）
  const track = [];
  let shotDone = false;
  for (let i = 0; i < 25; i++) {
    const d = await offCenter();
    track.push(d);
    if (!shotDone && d !== null && i >= 5) {
      shotDone = true;
      await shot(A, 'fate1-focus-lot');
    }
    await A.waitForTimeout(60);
  }
  log('fate1 lot off-center track', track);
  const after = Math.min(...track.filter((x) => x !== null));
  if (!shotDone) await shot(A, 'fate1-focus-lot');
  // 镜头停在地块上的时长：距离保持在最小值附近（±40）的采样数
  const held = track.filter((x) => x !== null && x <= after + 40).length;
  check('征收：关板后镜头移到被征收的地块并停一会儿（地块到画布中心的距离变小）', before !== null && after < before - 300 && held >= 5, {
    before,
    after,
    held,
  });
  await idleAll();
  await shot(A, 'fate1-done');
  const lot = await A.evaluate((ids) => {
    const v = window.__rich4.store.game.getState().view;
    return ids.filter((id) => v.lands.find((l) => l.id === id)?.owner !== 0);
  }, owned);
  check('征收：A 的空地被收走（镜头见截图 fate1-focus-lot）', lot.length === 1, { lot });
}

try {
  await setupRoom();
  const only = process.env.EVV_ONLY ? process.env.EVV_ONLY.split(',') : null;
  for (const [name, fn] of [
    ['fateClick', fateClick],
    ['fateKeys', fateKeys],
    ['newsClick', newsClick],
    ['fateFocus', fateFocus],
  ]) {
    if (only && !only.includes(name)) continue;
    try {
      await fn();
    } catch (e) {
      check(`${name} 运行`, false, { error: String(e).slice(0, 400) });
      await shot(A, `${name}-error`).catch(() => {});
    }
  }
  for (const p of PAGES) if (p.__errs.length) log(`${p.__name} errors`, p.__errs.slice(0, 8));
} finally {
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  log(`done: ${results.filter((r) => r.ok).length}/${results.length} pass`);
  await browser.close();
}
