// 联调目视（「倒计时始终在画面正中央」+「只有一名真人时不限时」）：真实素材包、台湾图。
// 先起本机服务（本机例外：未设门禁的素材包、只监听回环；端口 3331 / 5331）：
//   PORT=3331 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5331 TRUST_PROXY=0 RICH4_ASSETS_ALLOW_UNGATED=1 \
//   RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_TEST_MODE=1 DATA_DIR=.cache/cs/final-data \
//   npx tsx apps/server/src/main.ts
//   （apps/client）npx vite build --outDir <临时目录> && RICH4_API_TARGET=http://127.0.0.1:3331 npx vite preview --outDir <临时目录> --port 5331 --strictPort
// 用法：node test/final-cs-check.mjs [宽x高=1920x1080] [--skin=original|procedural] [--only=a,b,c]
//   a：一名真人 + 3 电脑（fast 档）——侧栏「不限時」、全程没有中央倒计时、没有提示音，过了 fast 档时限也不超时；
//   b：两名真人（P2 另开页面，轮到自己时按默认应答），normal 档——P1 的中央倒计时始终在画面正中，最后 10 秒变红、
//      每秒提示音（测试钩子记时间点，对照截止时间），等掷骰 / 回合菜单 / 股市 / 买地 / 银行 / 魔法屋 / 拍卖时位置不变、
//      不拦点击（elementsFromPoint 命中测试；买地时真的用鼠标点在数字上的按钮上作答）；
//   c：接着 b，P1 的回合菜单进入最后 10 秒后 P2 离开房间 → P1 当前决策的倒计时消失、提示音停、侧栏「不限時」。
// 截图与记录写到 .cache/cs/final/<皮肤>-<宽x高>/（含原版素材，不入库）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.FINAL_BASE ?? 'http://localhost:5331';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const ONLY = (args.find((a) => a.startsWith('--only='))?.slice(7) ?? 'a,b,c').split(',');
const TAG = `${SKIN}-${size[0]}x${size[1]}`;
const OUT = `.cache/cs/final/${TAG}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, skin: SKIN, a: null, b: { shots: [] }, c: null, problems: [] };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};
const problem = (s) => {
  report.problems.push(s);
  log(`!! ${s}`);
};
const mobile = size[0] < 1000;
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function newPage(name, touch = false) {
  const ctx = await browser.newContext({
    viewport: { width: size[0], height: size[1] },
    deviceScaleFactor: 1,
    ...(mobile && touch ? { hasTouch: true } : {}),
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
      submitting: g?.submitting ?? null,
      centerCd: document.querySelectorAll('[data-testid="decision-countdown"]').length,
      rail: document.querySelector('[data-testid="classic-my-countdown"]')?.textContent ?? null,
      ring: document.querySelector('[data-testid="countdown"]')?.textContent ?? null,
    };
  });
}

/** 页面里装采样器：每 40ms 记中央倒计时的变化；每 250ms 把音频引擎日志里的 countdown 音效收进来 */
async function installRecorder(page) {
  await page.evaluate(() => {
    const w = window;
    if (w.__finalRec) return;
    const rec = { samples: [], audio: [], seen: new Set() };
    w.__finalRec = rec;
    let last = '';
    setInterval(() => {
      const cd = document.querySelector('[data-testid="decision-countdown"]');
      const g = w.__rich4?.store?.game?.getState();
      const d = g?.decision;
      const r = cd?.getBoundingClientRect();
      const sig = cd
        ? [cd.getAttribute('data-decision'), cd.getAttribute('data-secs'), cd.getAttribute('data-urgent')].join('|')
        : `none|${d?.decisionId ?? ''}`;
      if (sig === last) return;
      last = sig;
      const off = w.__rich4?.store?.connection?.getState().clockOffsetMs ?? 0;
      const num = cd?.querySelector('span');
      rec.samples.push({
        at: Date.now(),
        decision: cd?.getAttribute('data-decision') ?? null,
        storeDecision: d?.decisionId ?? null,
        kind: cd?.getAttribute('data-kind') ?? d?.kind ?? null,
        secs: cd ? Number(cd.getAttribute('data-secs')) : null,
        urgent: cd?.getAttribute('data-urgent') ?? null,
        color: num ? getComputedStyle(num).color : null,
        center: r ? [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] : null,
        deadlineAt: d?.deadlineAt ?? null,
        remainingMs: d?.deadlineAt ? d.deadlineAt - (Date.now() + off) : null,
      });
    }, 40);
    setInterval(() => {
      const log = w.__rich4?.audio?.log ?? [];
      for (const e of log) {
        if (e.kind !== 'sfx' || !String(e.key ?? '').includes('countdown')) continue;
        const k = `${e.t}|${e.op}|${e.key}`;
        if (rec.seen.has(k)) continue;
        rec.seen.add(k);
        rec.audio.push({ at: Math.round(performance.timeOrigin + e.t), op: e.op, key: e.key, bus: e.bus });
      }
    }, 250);
  });
}

async function collect(page) {
  return page.evaluate(() => ({
    beeps: window.__rich4.countdown?.beeps ?? [],
    samples: window.__finalRec?.samples ?? [],
    audio: window.__finalRec?.audio ?? [],
    audioState: window.__rich4.audio?.state ?? null,
    offset: window.__rich4.store.connection?.getState().clockOffsetMs ?? 0,
  }));
}

/** 中央倒计时：中心、画面正中、偏差、字号颜色；命中测试（数字不拦点击） */
async function measure(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom };
    };
    const round = (v) => Math.round(v * 10) / 10;
    const describe = (el) =>
      el ? `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}` : null;
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
      if (top && right && pad) expect = { x: right.x / 2, y: (top.b + pad.y) / 2, from: 'viewport' };
    }
    if (!cd) return { countdown: null, expect };
    const r = rect(cd);
    const cs = getComputedStyle(cd);
    const num = cd.querySelector('span');
    const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    // 命中测试：数字中心往下是谁；pointer-events: none 的元素不会出现在 elementsFromPoint 里
    const stack = document.elementsFromPoint(c.x, c.y);
    const layer = document.querySelector('[data-testid="decision-countdown-layer"]');
    const cdInStack = stack.some((el) => el === cd || cd.contains(el) || el === layer);
    // 与数字外框相交的可点控件：在相交区域中心点命中的是控件本身（而不是倒计时）
    const ctrls = [...document.querySelectorAll('button, [role="button"], select, input, a[href]')].filter((b) => {
      const q = b.getBoundingClientRect();
      if (q.width === 0 || q.height === 0) return false;
      if (getComputedStyle(b).visibility === 'hidden') return false;
      return q.left < r.r && q.right > r.x && q.top < r.b && q.bottom > r.y;
    });
    const under = ctrls.map((b) => {
      const q = b.getBoundingClientRect();
      const x = (Math.max(q.left, r.x) + Math.min(q.right, r.r)) / 2;
      const y = (Math.max(q.top, r.y) + Math.min(q.bottom, r.b)) / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        ctrl: describe(b),
        text: (b.textContent ?? '').trim().slice(0, 16),
        at: [round(x), round(y)],
        /** 相交区域的宽高（太窄的一条不拿来真点：落在边上会点到父元素） */
        size: [round(Math.min(q.right, r.r) - Math.max(q.left, r.x)), round(Math.min(q.bottom, r.b) - Math.max(q.top, r.y))],
        hit: describe(hit),
        hitIsCtrl: !!hit && (hit === b || b.contains(hit)),
        hitIsCountdown: !!hit && (hit === cd || cd.contains(hit) || hit === layer),
      };
    });
    return {
      countdown: {
        center: [round(c.x), round(c.y)],
        box: [r.x, r.y, r.w, r.h].map(round),
        secs: cd.getAttribute('data-secs'),
        kind: cd.getAttribute('data-kind'),
        urgent: cd.getAttribute('data-urgent'),
        fontPx: cs.fontSize,
        color: num ? getComputedStyle(num).color : cs.color,
        pointerEvents: cs.pointerEvents,
        layerParent: layer?.parentElement === document.body ? 'body' : (layer?.parentElement?.getAttribute('data-testid') ?? null),
      },
      expect: expect && { x: round(expect.x), y: round(expect.y), from: expect.from },
      delta: expect ? [round(c.x - expect.x), round(c.y - expect.y)] : null,
      hitTop: describe(stack[0]),
      cdInStack,
      under,
    };
  });
}

let shotN = 0;
async function shot(page, phase, name, wait = 250, list = null) {
  shotN++;
  if (wait) await page.waitForTimeout(wait);
  const file = `${OUT}/${phase}-${String(shotN).padStart(2, '0')}-${name}.png`;
  const m = await measure(page);
  await page.screenshot({ path: file });
  const st = await state(page);
  const entry = { name, file, rail: st.rail, ring: st.ring, decision: st.decision, ...m };
  if (list) list.push(entry);
  log(`shot ${file} ${JSON.stringify(entry)}`);
  return entry;
}

/**
 * 真的用鼠标点在数字外框里压着的控件上（entry.under 里第一个 testid 匹配 re 的），用捕获阶段的监听记下 click 的目标：
 * 目标是控件本身（而不是倒计时）即点击穿透
 */
async function clickThrough(page, entry, re) {
  const u = (entry.under ?? []).find((x) => re.test(x.ctrl ?? '') && Math.min(...x.size) >= 8);
  if (!u) return null;
  await page.evaluate(() => {
    window.__lastClick = null;
    document.addEventListener(
      'click',
      (e) => {
        const el = e.target instanceof Element ? e.target : null;
        window.__lastClick = {
          testid: el?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
          inCountdown: !!el?.closest('[data-testid="decision-countdown-layer"]'),
        };
      },
      { capture: true, once: true },
    );
  });
  await page.mouse.click(u.at[0], u.at[1]);
  const got = await page.evaluate(() => window.__lastClick);
  const res = { scene: entry.name, ctrl: u.ctrl, at: u.at, clicked: got };
  const want = /\[(.+)\]/.exec(u.ctrl)?.[1];
  res.ok = !!got && !got.inCountdown && got.testid === want;
  report.b.clicks ??= [];
  report.b.clicks.push(res);
  log(`click-through ${JSON.stringify(res)}`);
  if (!res.ok) problem(`b: ${entry.name} 在数字上点 ${u.ctrl} 没点着 ${JSON.stringify(got)}`);
  return res;
}

async function act(page) {
  await page.evaluate(() => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(d.defaultIntent, d.decisionId) : null;
  });
}

function driver(page) {
  return async () => {
    const st = await state(page);
    if (!st.idle || !st.decision || st.submitting !== null) return;
    await act(page);
  };
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

async function debug(page, op) {
  const s0 = (await state(page)).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
}

async function remaining(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    const off = h.store.connection?.getState().clockOffsetMs ?? 0;
    return d?.deadlineAt ? d.deadlineAt - (Date.now() + off) : null;
  });
}

async function waitRemainingBelow(page, ms) {
  for (;;) {
    const r = await remaining(page);
    if (r === null || r <= ms) return r;
    await page.waitForTimeout(Math.max(20, Math.min(400, r - ms)));
  }
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

async function escape(page, times = 2) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
  }
}

/** 掷骰：点行动区 / 工具列的掷骰钮；没点着就经测试钩子 */
async function roll(page) {
  const s0 = (await state(page)).seq;
  const btn = page.getByTestId('action-roll').first();
  if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const s1 = await state(page);
  if (s1.seq === s0 && s1.decision?.kind === 'TURN_MENU' && s1.submitting === null) await act(page);
}

async function finishTurn(page, other = null) {
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(400);
    if (other) await other();
    const st = await state(page);
    if (!st.decision) return;
    if (st.decision.kind === 'TURN_MENU' && st.submitting === null) return;
    if (st.idle && st.submitting === null) await act(page);
  }
}

async function openMenu(page) {
  if (SKIN === 'original') {
    const tb = page.locator('[data-testid="classic-toolbar"] [data-testid="action-cards"]');
    if (await tb.isVisible().catch(() => false)) await tb.click();
    else await page.getByTestId('action-menu').first().click();
  } else await page.getByTestId('action-menu').click();
}

async function openStock(page) {
  if (SKIN === 'original') {
    const tb = page.locator('[data-testid="classic-toolbar"] [data-testid="action-stock"]');
    if (await tb.isVisible().catch(() => false)) await tb.click();
    else {
      await openMenu(page);
      await page.getByTestId('action-stock').first().click();
    }
  } else await page.getByTestId('action-stock').click();
  await page.getByTestId('turn-stock-sheet').waitFor({ timeout: 8000 });
}

/** 分析一个决策的提示音：只在最后 10 秒、每秒至多一次、秒数递减；每一声距截止（本机）多少 ms */
function beepTimeline(rec, decisionId) {
  const samples = rec.samples.filter((s) => s.decision === decisionId || s.storeDecision === decisionId);
  const withDl = samples.find((s) => s.deadlineAt);
  const deadlineLocal = withDl ? withDl.deadlineAt - rec.offset : null;
  const beeps = rec.beeps
    .filter((b) => b.decisionId === decisionId)
    .map((b) => ({ secs: b.secs, level: b.level, audio: b.audio, toDeadlineMs: deadlineLocal ? deadlineLocal - b.at : null }));
  const secs = beeps.map((b) => b.secs);
  const shapeOk =
    secs.every((s) => s <= 10) &&
    new Set(secs).size === secs.length &&
    secs.every((s, i) => i === 0 || s < secs[i - 1]) &&
    beeps.every((b) => b.level === (b.secs <= 3 ? 'final' : 'tick'));
  // 每一声应在「剩 secs 秒」的整秒边界之后不久：secs×1000 − 距截止 ∈ [0, 150)
  const aligned = beeps.every((b) => b.toDeadlineMs === null || (b.secs * 1000 - b.toDeadlineMs >= -30 && b.secs * 1000 - b.toDeadlineMs < 150));
  const shown = samples.filter((s) => s.decision === decisionId);
  const firstRed = shown.find((s) => s.urgent === 'true');
  const lastCalm = [...shown].reverse().find((s) => s.urgent === 'false');
  const engine = deadlineLocal
    ? rec.audio
        .filter((a) => a.at <= deadlineLocal + 500 && a.at >= deadlineLocal - 11_000)
        .map((a) => `${a.op}:${a.key}@${deadlineLocal - a.at}`)
    : [];
  const centers = [...new Set(shown.map((s) => s.center?.join(',')).filter(Boolean))];
  return {
    decisionId,
    kind: shown[0]?.kind ?? samples[0]?.kind ?? null,
    deadlineLocal,
    secsShown: shown.map((s) => `${s.secs}${s.urgent === 'true' ? 'R' : ''}`),
    firstRed: firstRed ? { secs: firstRed.secs, color: firstRed.color, remainingMs: firstRed.remainingMs } : null,
    lastCalm: lastCalm ? { secs: lastCalm.secs, color: lastCalm.color } : null,
    centers,
    beeps,
    shapeOk,
    aligned,
    engine,
  };
}

try {
  // ═════════════ a：一名真人 + 3 电脑，fast 档 ═════════════
  if (ONLY.includes('a')) {
    const A = await newPage('solo', true);
    const pa = A.page;
    const shots = [];
    await home(pa, '單人');
    const code = await createRoom(pa, { timer: 'fast', ais: 3 });
    log(`a: solo room ${code}`);
    await pa.getByTestId('screen-room').waitFor();
    await pa.waitForTimeout(600);
    const hint = pa.locator('[data-testid="set-timer-hint"], [data-testid="room-timer-hint"]').first();
    const hintInfo = { text: await hint.textContent().catch(() => null), active: await hint.getAttribute('data-active').catch(() => null) };
    log(`a: lobby hint ${JSON.stringify(hintInfo)} effective=${(await state(pa)).effective}`);
    await shot(pa, 'a', 'lobby-solo', 300, shots);
    await pick(pa, 2);
    await pa.getByTestId('room-start').click();
    await enterGame(pa);
    await installRecorder(pa);
    const first = await waitDecision(pa, ['TURN_MENU']);
    const seat = first.seat;
    // 等回合菜单时遇到别的本人决策（如电脑出拍卖卡问竞拍）：每种先截一张，再按默认应答
    const seenKinds = new Set();
    const soloDrive = async () => {
      const s = await state(pa);
      if (!s.idle || !s.decision || s.submitting !== null || s.decision.kind === 'TURN_MENU') return;
      if (!seenKinds.has(s.decision.kind)) {
        seenKinds.add(s.decision.kind);
        await shot(pa, 'a', `other-${s.decision.kind}`, 900, shots);
      }
      await act(pa);
    };
    await pa.waitForTimeout(1200);
    await shot(pa, 'a', 'turn', 0, shots);
    // fast 档回合菜单 15 秒 + 0.8 秒宽限：计时的话早就超时代决了
    await pa.waitForTimeout(17_000);
    const after = await state(pa);
    if (after.decision?.id !== first.decision.id || after.seq !== first.seq)
      problem(`a: 17 秒后决策变了 ${JSON.stringify({ before: first.decision, after: after.decision })}`);
    await shot(pa, 'a', 'turn-after-17s', 0, shots);
    try {
      await openMenu(pa);
      await shot(pa, 'a', 'menu-open', 700, shots);
      await escape(pa, 1);
    } catch (e) {
      log(`a: menu 失败 ${e.message}`);
      await escape(pa, 2);
    }
    // 买地：58（来路 59）掷 1 → 57 L17（无主住宅）
    await debug(pa, { op: 'teleport', seat, node: 58, prev: 59 });
    await debug(pa, { op: 'forceNext', purpose: 'dice', values: [1] });
    await waitDecision(pa, ['TURN_MENU']);
    await roll(pa);
    const buy = await waitDecision(pa, ['BUY_LAND', 'UPGRADE_LAND'], 30_000);
    await shot(pa, 'a', `buy-${buy.decision.kind}`, 900, shots);
    await pa.waitForTimeout(9_000); // fast 档确认类 7.5 秒：计时的话早就超时
    const buy2 = await state(pa);
    if (buy2.decision?.id !== buy.decision.id) problem(`a: 买地 9 秒后决策变了 ${JSON.stringify(buy2.decision)}`);
    await shot(pa, 'a', 'buy-after-9s', 0, shots);
    await act(pa);
    await finishTurn(pa);
    // 银行：下一回合 56（来路 55）掷 1 → 银行
    await waitDecision(pa, ['TURN_MENU'], 180_000, soloDrive);
    await debug(pa, { op: 'teleport', seat, node: 56, prev: 55 });
    await debug(pa, { op: 'forceNext', purpose: 'dice', values: [1] });
    await waitDecision(pa, ['TURN_MENU']);
    await roll(pa);
    const bank = await waitDecision(pa, ['BANK_ATM', 'BANK_COUNTER'], 30_000);
    await shot(pa, 'a', `bank-${bank.decision.kind}`, 900, shots);
    await act(pa);
    await finishTurn(pa);
    await waitDecision(pa, ['TURN_MENU'], 180_000, soloDrive);
    await pa.waitForTimeout(800);
    await shot(pa, 'a', 'turn3', 0, shots);
    const rec = await collect(pa);
    const shown = rec.samples.filter((s) => s.decision !== null);
    const deadlines = rec.samples.filter((s) => s.deadlineAt !== null);
    const railBad = shots.filter((s) => s.decision && SKIN === 'original' && !/不限時/.test(s.rail ?? ''));
    report.a = {
      hint: hintInfo,
      shots: shots.map((s) => ({ name: s.name, rail: s.rail, ring: s.ring, countdown: s.countdown, decision: s.decision })),
      samples: rec.samples.length,
      countdownEverShown: shown.length,
      deadlinesSeen: deadlines.length,
      beeps: rec.beeps.length,
      engineCountdownSfx: rec.audio.length,
      audioState: rec.audioState,
      errors: A.errors,
    };
    log(`a: 采样 ${rec.samples.length} 次，出现中央倒计时 ${shown.length} 次，有截止时间 ${deadlines.length} 次，提示音请求 ${rec.beeps.length}，引擎 countdown 音效 ${rec.audio.length}，音频 ${JSON.stringify(rec.audioState)}`);
    if (shown.length || deadlines.length || rec.beeps.length || rec.audio.length) problem('a: 单真人房间出现了倒计时 / 截止时间 / 提示音');
    if (railBad.length) problem(`a: 侧栏不是「不限時」: ${JSON.stringify(railBad.map((s) => [s.name, s.rail]))}`);
    if (hintInfo.active !== 'true') problem(`a: 大厅说明没高亮 ${JSON.stringify(hintInfo)}`);
    if (A.errors.length) problem(`a: 控制台错误 ${JSON.stringify(A.errors.slice(0, 5))}`);
    await A.ctx.close();
  }

  // ═════════════ b + c：两名真人，normal 档 ═════════════
  if (ONLY.includes('b') || ONLY.includes('c')) {
    const A = await newPage('P1', true);
    const B = await newPage('P2');
    const pa = A.page;
    const pb = B.page;
    const shots = report.b.shots;
    const driveB = driver(pb);
    await home(pa, '測試甲');
    const code = await createRoom(pa, { timer: 'normal', ais: 0 });
    log(`b: duo room ${code}`);
    await home(pb, '測試乙');
    await pb.goto(`${BASE}/r/${code}?test=1`);
    await pb.getByTestId('screen-room').waitFor();
    await pick(pa, 2);
    await pick(pb, 9);
    await pb.getByTestId('room-ready').click();
    await pa.waitForTimeout(600);
    await pa.getByTestId('room-start').click();
    await enterGame(pa);
    await installRecorder(pa);
    const seatA = (await state(pa)).seat;
    const seatB = (await state(pb)).seat;
    log(`b: seats A=${seatA} B=${seatB}`);
    const myTurn = () =>
      waitDecision(pa, ['TURN_MENU'], 180_000, async () => {
        await driveB();
        const s = await state(pa);
        if (s.idle && s.decision && s.submitting === null && s.decision.kind !== 'TURN_MENU') await act(pa);
      });
    const scene = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        problem(`b: 场景 ${name} 失败 ${e.message.split('\n')[0]}`);
        await pa.screenshot({ path: `${OUT}/b-fail-${name}.png` }).catch(() => {});
        await escape(pa, 2);
      }
    };
    const timeline = [];

    // ── 回合菜单（等掷骰）：平静 → 展开回合菜单 → 股市 → 最后 10 秒 → 最后 3 秒 → 掷骰 ──
    const t1 = await myTurn();
    timeline.push(t1.decision.id);
    await pa.waitForTimeout(1200);
    await shot(pa, 'b', 'roll', 0, shots);
    await scene('menu', async () => {
      await openMenu(pa);
      const m = await shot(pa, 'b', 'menu-open', 700, shots);
      // 数字下面若压着「關閉」，就真的点在数字上把菜单关掉；否则按 Esc
      const c = await clickThrough(pa, m, /turn-close/);
      if (!c) await escape(pa, 1);
      else await pa.waitForTimeout(400);
    });
    await scene('stock', async () => {
      await openStock(pa);
      const m = await shot(pa, 'b', 'stock', 700, shots);
      await clickThrough(pa, m, /stock-pick|stock-row/);
      await escape(pa, 2);
    });
    await waitRemainingBelow(pa, 9_500);
    await shot(pa, 'b', 'roll-urgent', 0, shots);
    await scene('menu-urgent', async () => {
      await openMenu(pa);
      await shot(pa, 'b', 'menu-open-urgent', 500, shots);
      await escape(pa, 1);
    });
    await waitRemainingBelow(pa, 2_600);
    await shot(pa, 'b', 'roll-final', 0, shots);
    await roll(pa);
    await finishTurn(pa, driveB);

    // ── 买地：对话框在中央；数字压在对话框上，用鼠标点数字所在处的按钮作答（点击穿透） ──
    await scene('buy', async () => {
      const t = await myTurn();
      await debug(pa, { op: 'teleport', seat: seatA, node: 58, prev: 59 });
      await debug(pa, { op: 'forceNext', purpose: 'dice', values: [1] });
      await myTurn();
      timeline.push(t.decision.id);
      await roll(pa);
      const d = await waitDecision(pa, ['BUY_LAND', 'UPGRADE_LAND'], 30_000);
      timeline.push(d.decision.id);
      const m = await shot(pa, 'b', `buy-${d.decision.kind}`, 900, shots);
      await waitRemainingBelow(pa, 9_500);
      const mu = await shot(pa, 'b', 'buy-urgent', 0, shots);
      // 点击穿透：数字外框里若压着对话框按钮，就在相交处用鼠标点它；否则点对话框里数字正中那一点，再用测试钩子作答
      const target = [...(mu.under ?? []), ...(m.under ?? [])].find((u) => /buy-|upgrade-/.test(u.ctrl ?? ''));
      if (target) {
        const s0 = (await state(pa)).seq;
        await pa.mouse.click(target.at[0], target.at[1]);
        await pa.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 5000 }).then(
          () => log(`b: 在数字上点击 ${target.ctrl} (${target.at}) → 已作答`),
          () => problem(`b: 在数字上点击 ${target.ctrl} (${target.at}) 没有作答`),
        );
        report.b.clickThrough = { ctrl: target.ctrl, at: target.at };
      } else {
        log('b: 买地时数字外框里没有压着对话框按钮，改用命中测试结果');
        await act(pa);
      }
      await finishTurn(pa, driveB);
    });

    // ── 银行 ──
    await scene('bank', async () => {
      await myTurn();
      await debug(pa, { op: 'teleport', seat: seatA, node: 56, prev: 55 });
      await debug(pa, { op: 'forceNext', purpose: 'dice', values: [1] });
      await myTurn();
      await roll(pa);
      const d = await waitDecision(pa, ['BANK_ATM', 'BANK_COUNTER'], 30_000);
      timeline.push(d.decision.id);
      await shot(pa, 'b', `bank-${d.decision.kind}`, 900, shots);
      await waitRemainingBelow(pa, 9_500);
      const mu = await shot(pa, 'b', 'bank-urgent', 0, shots);
      // ATM 键盘的「8」「9」在数字下面：真的点在数字上按一个键（随后仍按默认应答）
      await clickThrough(pa, mu, /atm-key|bank-calc-key|bank-op/);
      await act(pa);
      const d2 = await waitDecision(pa, ['BANK_COUNTER', 'TURN_MENU'], 15_000).catch(() => null);
      if (d2?.decision.kind === 'BANK_COUNTER') {
        timeline.push(d2.decision.id);
        await shot(pa, 'b', 'bank-counter', 900, shots);
        await act(pa);
      }
      await finishTurn(pa, driveB);
    });

    // ── 魔法屋 ──
    await scene('magic', async () => {
      await myTurn();
      await debug(pa, { op: 'setCash', seat: seatB, cash: 900000, deposit: null });
      await debug(pa, { op: 'forceNext', purpose: 'magicCond', values: [3] });
      await debug(pa, { op: 'teleport', seat: seatA, node: 96, prev: 95 });
      await debug(pa, { op: 'forceNext', purpose: 'dice', values: [1] });
      await myTurn();
      await roll(pa);
      const d = await waitDecision(pa, ['MAGIC_CAST'], 30_000);
      timeline.push(d.decision.id);
      await shot(pa, 'b', 'magic', 900, shots);
      await waitRemainingBelow(pa, 9_500);
      const mu = await shot(pa, 'b', 'magic-urgent', 0, shots);
      // 程序化：魔法效果按钮在数字下面，点在数字上选一个效果（只是选中，随后仍按默认应答）
      await clickThrough(pa, mu, /magic-effect/);
      await act(pa);
      await finishTurn(pa, driveB);
    });

    // ── 拍卖：P2 的回合站到无主的 L20（节点 60），出拍卖卡 → P1 被问竞拍 ──
    await scene('auction', async () => {
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
      log(`b: use auction card ${JSON.stringify(used)}`);
      const d = await waitDecision(pa, ['AUCTION_BID'], 30_000);
      timeline.push(d.decision.id);
      await shot(pa, 'b', 'auction', 900, shots);
      await waitRemainingBelow(pa, 2_400);
      await shot(pa, 'b', 'auction-last3', 0, shots);
      await act(pa);
      // 拍卖可能再问一轮：都按默认
      for (let i = 0; i < 6; i++) {
        await pa.waitForTimeout(800);
        const s = await state(pa);
        if (s.decision?.kind === 'AUCTION_BID' && s.idle && s.submitting === null) await act(pa);
        await driveB();
      }
    });

    // ═════════════ c：P1 的回合菜单进入最后 10 秒后 P2 离开 ═════════════
    if (ONLY.includes('c')) {
      const t = await myTurn();
      await pa.waitForTimeout(800);
      await shot(pa, 'c', 'before-leave', 0, shots);
      await waitRemainingBelow(pa, 7_500);
      await shot(pa, 'c', 'before-leave-urgent', 0, shots);
      const beepsBefore = (await collect(pa)).beeps.filter((b) => b.decisionId === t.decision.id).length;
      const leftAt = Date.now();
      await pb.evaluate(() => window.__rich4.client.leaveRoom());
      await pa.waitForFunction(() => window.__rich4.store.room.getState().room?.effectiveTimerPreset === 'off', null, {
        timeout: 10_000,
      });
      const goneAt = Date.now();
      await pa.waitForTimeout(600);
      const afterShot = await shot(pa, 'c', 'after-leave', 0, shots);
      // 再等过原来的截止时间：不超时、不再响
      await pa.waitForTimeout(9_000);
      const later = await state(pa);
      await shot(pa, 'c', 'after-leave-9s', 0, shots);
      const rec = await collect(pa);
      const beepsAfter = rec.beeps.filter((b) => b.decisionId === t.decision.id && b.at > goneAt);
      const cdSamplesAfter = rec.samples.filter((s) => s.at > goneAt + 300 && s.decision !== null);
      report.c = {
        decision: t.decision,
        beepsBefore,
        beepsAfterLeave: beepsAfter.length,
        effectiveOffAfterMs: goneAt - leftAt,
        afterLeave: { countdown: afterShot.countdown, rail: afterShot.rail, ring: afterShot.ring, decision: afterShot.decision },
        after9s: later,
        countdownSamplesAfter: cdSamplesAfter.length,
      };
      log(`c: ${JSON.stringify(report.c)}`);
      if (afterShot.countdown) problem('c: P2 离开后中央倒计时还在');
      if (afterShot.decision?.deadlineAt !== null) problem('c: P2 离开后截止时间没取消');
      if (SKIN === 'original' && !/不限時/.test(afterShot.rail ?? '')) problem(`c: 侧栏不是「不限時」: ${afterShot.rail}`);
      if (beepsAfter.length) problem(`c: P2 离开后还有提示音 ${JSON.stringify(beepsAfter)}`);
      if (later.decision?.id !== t.decision.id) problem(`c: 过了原截止时间后决策变了 ${JSON.stringify(later.decision)}`);
      if (cdSamplesAfter.length) problem(`c: 离开后又采到中央倒计时 ${cdSamplesAfter.length} 次`);
    }

    // ── b 汇总：位置、命中测试、提示音时间线 ──
    const rec = await collect(pa);
    report.b.audioState = rec.audioState;
    report.b.offset = rec.offset;
    report.b.timelines = timeline.map((id) => beepTimeline(rec, id));
    for (const tl of report.b.timelines) {
      log(`b: 时间线 ${tl.kind} ${tl.decisionId.slice(-8)} 显示 ${tl.secsShown.join(' ')}；首次变红 ${JSON.stringify(tl.firstRed)}；中心 ${JSON.stringify(tl.centers)}`);
      log(`   提示音 ${tl.beeps.map((b) => `${b.secs}${b.level === 'final' ? 'F' : ''}@${b.toDeadlineMs}`).join(' ')} shapeOk=${tl.shapeOk} aligned=${tl.aligned}`);
      log(`   引擎 ${tl.engine.join(' ')}`);
      if (!tl.shapeOk) problem(`b: ${tl.kind} 提示音形状不对`);
      if (!tl.aligned) problem(`b: ${tl.kind} 提示音没对齐整秒`);
      if (tl.centers.length > 1) problem(`b: ${tl.kind} 中心不止一个 ${JSON.stringify(tl.centers)}`);
      if (tl.firstRed && tl.firstRed.secs > 10) problem(`b: ${tl.kind} 在 ${tl.firstRed.secs} 秒就变红`);
      if (tl.lastCalm && tl.lastCalm.secs <= 10) problem(`b: ${tl.kind} 剩 ${tl.lastCalm.secs} 秒还没变红`);
    }
    const withCd = shots.filter((s) => s.countdown && s.name && !s.file.includes('/c-'));
    const centers = [...new Set(withCd.map((s) => s.countdown.center.join(',')))];
    const fonts = [...new Set(withCd.map((s) => s.countdown.fontPx))];
    report.b.centers = centers;
    report.b.fonts = fonts;
    log(`b: 截图里的中心 ${JSON.stringify(centers)} 字号 ${JSON.stringify(fonts)}`);
    for (const s of withCd) {
      if (Math.abs(s.delta[0]) > 1 || Math.abs(s.delta[1]) > 1) problem(`b: ${s.name} 偏离画面正中 ${JSON.stringify(s.delta)}`);
      if (s.cdInStack) problem(`b: ${s.name} 命中测试命中了倒计时`);
      if (s.countdown.pointerEvents !== 'none') problem(`b: ${s.name} pointer-events=${s.countdown.pointerEvents}`);
      for (const u of s.under) if (u.hitIsCountdown) problem(`b: ${s.name} ${u.ctrl} 被倒计时挡住`);
    }
    const noCd = shots.filter((s) => !s.countdown && !s.file.includes('/c-'));
    for (const s of noCd) problem(`b: ${s.name} 截图时没有中央倒计时`);
    if (centers.length > 1) problem(`b: 各场景中心不一致 ${JSON.stringify(centers)}`);
    if (fonts.length > 1) problem(`b: 各场景字号不一致 ${JSON.stringify(fonts)}`);
    report.b.errors = { A: A.errors, B: B.errors };
    if (A.errors.length || B.errors.length) problem(`b: 控制台错误 ${JSON.stringify([...A.errors, ...B.errors].slice(0, 5))}`);
    await A.ctx.close();
    await B.ctx.close();
  }
} catch (e) {
  problem(`失败 ${e?.stack ?? e}`);
  process.exitCode = 1;
} finally {
  log(`问题 ${report.problems.length} 条`);
  writeFileSync(`${OUT}/log.txt`, `${LOG.join('\n')}\n`);
  writeFileSync(`${OUT}/result.json`, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
