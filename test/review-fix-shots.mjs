// 调试：复审修复的真实素材包目视（台湾图）。先起本机服务（本机例外：未设门禁的素材包、只监听回环；端口 3361 / 5361）：
//   PORT=3361 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5361 TRUST_PROXY=0 RICH4_ASSETS_ALLOW_UNGATED=1 \
//   RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_TEST_MODE=1 DATA_DIR=<临时目录> \
//   npx tsx apps/server/src/main.ts
//   （apps/client）npx vite build --outDir <临时目录> && RICH4_API_TARGET=http://127.0.0.1:3361 npx vite preview --outDir <临时目录> --port 5361 --strictPort
// 用法：node test/review-fix-shots.mjs [宽x高=1280x800] [--skin=original|procedural] [--only=lobby,duo]
//   lobby：建房与大厅的计时说明——电脑补满其余三个座位 / 大厅只有一名真人时文字换成「现在只有一名真人：开局后不计时」；
//          原版手机横屏开局设置两列面板里说明的实际字号（逻辑字号 × 舞台缩放）与位置（整行、在下拉框右边，不越出行）；
//   duo：两名真人 + 2 电脑（normal 档），P2 另开页面、轮到自己时按默认应答：
//     wrap（程序化）：P1 等掷骰时把窗口换成几档尺寸（含行动区折成两行的 1100×800、1024×768…），倒计时中心与棋盘视口
//          （顶栏以下、底栏以上、右栏以外，与镜头的有效可视区同一块）中心的偏差；
//     layer：打开系统菜单 / 设置 / 托管设置时数字中心处最上层是谁（临时让倒计时可命中再取 elementFromPoint），
//          以及回合菜单的股市面板（决策面板，数字应在上）；
//     bankrupt：P1 买下一块地，P2 身无分文落到这块地上破产出局（真引擎）→ P1 之后的决策不限时、没有中央倒计时；
//          P2 关掉页面（断线托管）后 P1 仍不限时，过了 normal 档时限也不超时。
// 截图与记录写到 .cache/cs/fix/<皮肤>-<宽x高>/（含原版素材，不入库）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.FIX_BASE ?? 'http://localhost:5361';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x800').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const ONLY = (args.find((a) => a.startsWith('--only='))?.slice(7) ?? 'lobby,duo').split(',');
const TAG = `${SKIN}-${size[0]}x${size[1]}`;
const OUT = `.cache/cs/fix/${TAG}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, skin: SKIN, lobby: null, wrap: [], layer: [], bankrupt: null, problems: [] };
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
      controls: room?.seats?.map((s) => s.control) ?? null,
      decision: d ? { kind: d.kind, id: d.decisionId, deadlineAt: d.deadlineAt } : null,
      pendingDeadlines: (g?.pending ?? []).map((p) => [p.seat, p.kind, p.deadlineAt]),
      submitting: g?.submitting ?? null,
      players: (g?.view?.players ?? []).map((p) => ({ seat: p.seat, alive: p.alive, out: p.out, cash: p.cash })),
      centerCd: document.querySelectorAll('[data-testid="decision-countdown"]').length,
      rail: document.querySelector('[data-testid="classic-my-countdown"]')?.textContent ?? null,
    };
  });
}

/** 中央倒计时的中心与画面正中（程序化：顶栏以下、底栏以上、右栏以外；原版：舞台中心）；行动区 / 底栏高度 */
async function measure(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom };
    };
    const round = (v) => Math.round(v * 10) / 10;
    const cd = document.querySelector('[data-testid="decision-countdown"]');
    const stage = document.querySelector('[data-testid="classic-stage-inner"]');
    let expect = null;
    let bars = null;
    if (stage) {
      const s = rect(stage);
      expect = { x: s.x + s.w / 2, y: s.y + s.h / 2, from: 'stage' };
    } else {
      const top = rect(document.querySelector('[data-testid="top-bar"]'));
      const right = rect(document.querySelector('[data-testid="screen-game"] > aside'));
      const padEl = document.querySelector('[data-testid="action-pad"]');
      const pad = rect(padEl);
      const bottom = rect(padEl?.parentElement ?? null);
      if (top && right && bottom) expect = { x: right.x / 2, y: (top.b + bottom.y) / 2, from: 'viewport' };
      bars = {
        padH: pad ? round(pad.h) : null,
        bottomTop: bottom ? round(bottom.y) : null,
        padTop: pad ? round(pad.y) : null,
        topBottom: top ? round(top.b) : null,
        byPad: top && pad ? round((top.b + pad.y) / 2) : null,
      };
    }
    const layer = document.querySelector('[data-testid="decision-countdown-layer"]');
    const lr = rect(layer);
    if (!cd) return { countdown: null, expect, bars };
    const r = rect(cd);
    const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    return {
      countdown: { center: [round(c.x), round(c.y)], fontPx: getComputedStyle(cd).fontSize, secs: cd.getAttribute('data-secs') },
      expect: expect && { x: round(expect.x), y: round(expect.y), from: expect.from },
      delta: expect ? [round(c.x - expect.x), round(c.y - expect.y)] : null,
      layer: lr && { top: round(lr.y), bottom: round(lr.b), inline: layer.getAttribute('style') },
      bars,
    };
  });
}

/** 数字中心处最上层的元素：临时让倒计时层可命中（它平时 pointer-events: none，elementFromPoint 取不到） */
async function stackProbe(page) {
  return page.evaluate(() => {
    const cd = document.querySelector('[data-testid="decision-countdown"]');
    const layer = document.querySelector('[data-testid="decision-countdown-layer"]');
    if (!cd || !layer) return { onTop: 'no-countdown' };
    const r = cd.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const saved = [layer.style.pointerEvents, cd.style.pointerEvents];
    layer.style.pointerEvents = 'auto';
    cd.style.pointerEvents = 'auto';
    const el = document.elementFromPoint(x, y);
    layer.style.pointerEvents = saved[0];
    cd.style.pointerEvents = saved[1];
    const inCd = !!el && (el === cd || cd.contains(el) || el === layer);
    const tid = el?.closest('[data-testid]')?.getAttribute('data-testid') ?? null;
    const dlg = el?.closest('[role="dialog"]');
    return {
      onTop: inCd ? 'countdown' : `${el?.tagName ?? 'null'}${tid ? `[${tid}]` : ''}`,
      dialog: dlg?.getAttribute('data-testid') ?? null,
      dialogZ: dlg ? getComputedStyle(dlg).zIndex : null,
      layerZ: getComputedStyle(layer).zIndex,
      at: [Math.round(x), Math.round(y)],
    };
  });
}

let shotN = 0;
async function shot(page, name, wait = 300) {
  shotN++;
  if (wait) await page.waitForTimeout(wait);
  const file = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  log(`shot ${file}`);
  return file;
}

async function actIntent(page, intent) {
  return page.evaluate((it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(it ?? d.defaultIntent, d.decisionId) : null;
  }, intent ?? null);
}

async function waitDecision(page, kinds, timeout = 180_000, other = null) {
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

async function home(page, nick) {
  await page.goto(`${BASE}/?test=1`);
  await page.getByTestId('home-nickname').fill(nick);
  await page.getByTestId('home-nickname').blur();
}

async function openCreate(page) {
  await page.getByTestId('home-create').click();
  await page.getByTestId('set-timer').waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="set-map"] option')].some((o) => o.value === 'taiwan'),
  );
  await page.getByTestId('set-map').selectOption('taiwan');
}

async function createRoom(page, o) {
  await openCreate(page);
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

async function escape(page, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
  }
}

async function openSystemMenu(page) {
  const btn = page.getByTestId('top-menu').first();
  if (await btn.isVisible().catch(() => false)) await btn.click();
  else {
    await page.getByTestId('tool-more').click();
    await page.getByTestId('top-menu').last().click();
  }
  await page.getByTestId('system-menu').waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
}

async function hintInfo(page, testId) {
  return page.getByTestId(testId).evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const row = el.closest('label')?.getBoundingClientRect() ?? null;
    const sel = el.closest('label')?.querySelector('select')?.getBoundingClientRect() ?? null;
    const box = el.closest('fieldset')?.getBoundingClientRect() ?? null;
    const stage = document.querySelector('[data-testid="classic-stage-inner"]');
    const m = stage ? /matrix\(([^,]+)/.exec(getComputedStyle(stage).transform) : null;
    const scale = m ? Number(m[1]) : 1;
    const q = (b) => (b ? [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 10) / 10) : null);
    return {
      text: el.textContent,
      active: el.getAttribute('data-active'),
      fontLogical: cs.fontSize,
      stageScale: Math.round(scale * 1000) / 1000,
      fontCss: Math.round(parseFloat(cs.fontSize) * scale * 10) / 10,
      hint: q(r),
      row: q(row),
      select: q(sel),
      panel: q(box),
      insideRow: !row || (r.top >= row.top - 0.5 && r.bottom <= row.bottom + 0.5 && r.right <= row.right + 0.5),
      rightOfSelect: !sel || r.left >= sel.right - 0.5,
      labelText: el.closest('label')?.textContent ?? null,
    };
  });
}

try {
  // ═════════════ lobby：建房与大厅的计时说明 ═════════════
  if (ONLY.includes('lobby')) {
    const A = await newPage('lobby', true);
    const pa = A.page;
    const r = {};
    await home(pa, '說明');
    await openCreate(pa);
    await pa.getByTestId('set-timer').selectOption('fast');
    await pa.getByTestId('set-ai-count').selectOption('2');
    r.create2 = await hintInfo(pa, 'set-timer-hint');
    log(`lobby: 建房 电脑 2 ${JSON.stringify(r.create2)}`);
    await shot(pa, 'create-ai2');
    await pa.getByTestId('set-ai-count').selectOption('3');
    r.create3 = await hintInfo(pa, 'set-timer-hint');
    log(`lobby: 建房 电脑 3 ${JSON.stringify(r.create3)}`);
    await shot(pa, 'create-ai3');
    if (r.create2.active !== 'false' || r.create3.active !== 'true') problem(`lobby: 建房说明高亮不对 ${r.create2.active}/${r.create3.active}`);
    if (!/現在|现在/.test(r.create3.text ?? '') || /現在|现在/.test(r.create2.text ?? '')) problem('lobby: 建房说明文字没换');
    if (SKIN === 'original' && mobile) {
      if (!r.create3.insideRow || !r.create3.rightOfSelect) problem(`lobby: 原版手机横屏说明越出行或不在下拉框右边 ${JSON.stringify(r.create3)}`);
      if (r.create3.fontCss < 10.5) problem(`lobby: 原版手机横屏说明实际字号 ${r.create3.fontCss}px 偏小`);
    }
    await pa.getByTestId('create-submit').click();
    await pa.waitForURL(/\/r\/\d{6}/);
    await pa.getByTestId('screen-room').waitFor();
    await pa.waitForTimeout(800);
    const lobbyId = (await pa.getByTestId('room-timer-hint').count()) > 0 ? 'room-timer-hint' : 'set-timer-hint';
    r.lobby = await hintInfo(pa, lobbyId);
    r.lobbyEffective = (await state(pa)).effective;
    log(`lobby: 大厅 ${lobbyId} ${JSON.stringify(r.lobby)} effective=${r.lobbyEffective}`);
    await shot(pa, 'lobby-solo', 500);
    if (r.lobby.active !== 'true' || !/現在|现在/.test(r.lobby.text ?? '')) problem(`lobby: 大厅说明没换 ${JSON.stringify(r.lobby)}`);
    r.errors = A.errors;
    if (A.errors.length) problem(`lobby: 控制台错误 ${JSON.stringify(A.errors.slice(0, 5))}`);
    report.lobby = r;
    await A.ctx.close();
  }

  // ═════════════ duo：两名真人 + 2 电脑 ═════════════
  if (ONLY.includes('duo')) {
    const A = await newPage('P1', true);
    const B = await newPage('P2');
    const pa = A.page;
    const pb = B.page;
    let holdB = false;
    let bClosed = false;
    const driveB = async () => {
      if (bClosed) return;
      const st = await state(pb);
      if (!st.idle || !st.decision || st.submitting !== null) return;
      if (holdB && st.decision.kind === 'TURN_MENU') return;
      await actIntent(pb);
    };
    const driveAOthers = async () => {
      await driveB();
      const s = await state(pa);
      if (s.idle && s.decision && s.submitting === null && s.decision.kind !== 'TURN_MENU') await actIntent(pa);
    };
    await home(pa, '測試甲');
    const code = await createRoom(pa, { timer: 'normal', ais: 2 });
    log(`duo: room ${code}`);
    await home(pb, '測試乙');
    await pb.goto(`${BASE}/r/${code}?test=1`);
    await pb.getByTestId('screen-room').waitFor();
    await pick(pa, 2);
    await pick(pb, 9);
    await pb.getByTestId('room-ready').click();
    await pa.waitForTimeout(600);
    await pa.getByTestId('room-start').click();
    await enterGame(pa);
    await enterGame(pb);
    const seatA = (await state(pa)).seat;
    const seatB = (await state(pb)).seat;
    log(`duo: seats A=${seatA} B=${seatB}`);
    const first = await waitDecision(pa, ['TURN_MENU'], 180_000, driveAOthers);
    log(`duo: P1 TURN_MENU ${JSON.stringify(first.decision)} effective=${first.effective}`);
    if (first.effective !== 'normal' || first.decision.deadlineAt === null) problem('duo: 两名真人开局应按档位计时');
    await pa.waitForTimeout(1500);

    // ── wrap（程序化）：窗口尺寸 ──
    if (SKIN === 'procedural') {
      const sizes = [
        [1280, 800],
        [1279, 800],
        [1200, 800],
        [1100, 800],
        [1100, 700],
        [1024, 768],
        [1194, 834],
        [1024, 600],
        [844, 390],
        [size[0], size[1]],
      ];
      for (const [w, h] of sizes) {
        await pa.setViewportSize({ width: w, height: h });
        await pa.waitForTimeout(500);
        const m = await measure(pa);
        const file = await shot(pa, `wrap-${w}x${h}`, 0);
        const e = { size: `${w}x${h}`, file, ...m };
        report.wrap.push(e);
        log(`wrap ${JSON.stringify(e)}`);
        if (!m.delta) problem(`wrap ${w}x${h}: 没有中央倒计时`);
        else if (Math.abs(m.delta[0]) > 2 || Math.abs(m.delta[1]) > 2) problem(`wrap ${w}x${h}: 偏离正中 ${JSON.stringify(m.delta)}`);
      }
    } else {
      const m = await measure(pa);
      report.wrap.push({ size: TAG, ...m });
      log(`center ${JSON.stringify(m)}`);
      if (!m.delta || Math.abs(m.delta[0]) > 2 || Math.abs(m.delta[1]) > 2) problem(`center: 偏离正中 ${JSON.stringify(m.delta)}`);
    }

    // ── layer：系统界面盖在数字上；决策面板在数字下 ──
    {
      const probe = async (name) => {
        const p = await stackProbe(pa);
        const file = await shot(pa, `layer-${name}`, 0);
        report.layer.push({ name, file, ...p });
        log(`layer ${name} ${JSON.stringify(p)}`);
        return p;
      };
      await openSystemMenu(pa);
      const p1 = await probe('sysmenu');
      if (p1.onTop === 'countdown') problem('layer: 系统菜单被数字压住');
      await pa.getByTestId('menu-settings').click();
      await pa.getByTestId('settings-dialog').waitFor();
      await pa.waitForTimeout(400);
      const p2 = await probe('settings');
      if (p2.onTop === 'countdown') problem('layer: 设置被数字压住');
      await escape(pa, 1);
      const trustee = pa.getByTestId('menu-trustee');
      if (await trustee.isVisible().catch(() => false)) {
        await trustee.click();
        await pa.getByTestId('trustee-dialog').waitFor();
        await pa.waitForTimeout(400);
        const p3 = await probe('trustee');
        if (p3.onTop === 'countdown') problem('layer: 托管设置被数字压住');
        await escape(pa, 1);
      }
      await escape(pa, 1);
      await pa.waitForTimeout(300);
      if ((await pa.getByTestId('system-menu').count()) > 0) await escape(pa, 1);
      // 决策面板（回合菜单的股市子页）：数字仍在上（不避让）
      try {
        if (SKIN === 'original') {
          const tb = pa.locator('[data-testid="classic-toolbar"] [data-testid="action-stock"]');
          if (await tb.isVisible().catch(() => false)) await tb.click();
          else {
            await pa.getByTestId('tool-more').click();
            await pa.getByTestId('action-stock').last().click();
          }
        } else await pa.getByTestId('action-stock').click();
        await pa.getByTestId('turn-stock-sheet').waitFor({ timeout: 8000 });
        await pa.waitForTimeout(600);
        const p4 = await probe('stock-panel');
        if (p4.onTop !== 'countdown') problem(`layer: 股市面板上数字不在最上层 ${p4.onTop}`);
      } catch (e) {
        log(`layer: 股市面板没打开 ${e.message}`);
      }
      await escape(pa, 2);
      await pa.evaluate(() => window.__rich4.store.ui.getState().openPanel(null));
    }

    // ── bankrupt：P1 买地，P2 身无分文落上去破产 ──
    {
      const r = { steps: [] };
      report.bankrupt = r;
      const note = (k, v) => {
        r.steps.push({ k, v });
        log(`bankrupt ${k} ${JSON.stringify(v)}`);
      };
      await waitDecision(pa, ['TURN_MENU'], 60_000, driveAOthers);
      await debug(pa, { op: 'teleport', seat: seatA, node: 58, prev: 59 });
      await debug(pa, { op: 'forceNext', purpose: 'dice', values: [1] });
      await waitDecision(pa, ['TURN_MENU'], 60_000, driveAOthers);
      await actIntent(pa, { type: 'ROLL' });
      const buy = await waitDecision(pa, ['BUY_LAND'], 30_000, driveB);
      note('P1 买地决策', buy.decision);
      await actIntent(pa, { type: 'CONFIRM' });
      holdB = true;
      // 等 P2 的回合菜单（其间 P1 的其他决策按默认应答）
      await waitDecision(pb, ['TURN_MENU'], 240_000, driveAOthers);
      const before = await state(pa);
      note('P2 回合开始时 P1 看到', { effective: before.effective, controls: before.controls });
      await debug(pa, { op: 'setCash', seat: seatB, cash: 0, deposit: 0 });
      await debug(pa, { op: 'teleport', seat: seatB, node: 58, prev: 59 });
      await debug(pa, { op: 'forceNext', purpose: 'dice', values: [1] });
      await waitDecision(pb, ['TURN_MENU'], 30_000);
      await actIntent(pb, { type: 'ROLL' });
      holdB = false;
      await pa.waitForFunction(
        (s) => window.__rich4.store.game.getState().view?.players?.find((p) => p.seat === s)?.alive === false,
        seatB,
        { timeout: 30_000 },
      );
      const after = await state(pa);
      note('P2 破产后 P1 看到', {
        effective: after.effective,
        controls: after.controls,
        players: after.players,
        pending: after.pendingDeadlines,
      });
      if (after.effective !== 'off') problem(`bankrupt: P2 破产后有效档位不是 off：${after.effective}`);
      if (after.controls?.[seatB] !== 'human') note('P2 的控制方式', after.controls?.[seatB]);
      await shot(pa, 'bankrupt-after', 1500);
      // P1 之后的决策：不限时（途中的拍卖等先截一张再按默认应答）
      const seen = new Set();
      const t0 = Date.now();
      let turn = null;
      while (Date.now() - t0 < 240_000) {
        await driveB();
        const s = await state(pa);
        if (s.idle && s.decision && s.submitting === null) {
          if (s.decision.deadlineAt !== null) problem(`bankrupt: P1 的决策 ${s.decision.kind} 仍有截止时间`);
          if (s.centerCd > 0) problem(`bankrupt: P1 的决策 ${s.decision.kind} 仍有中央倒计时`);
          if (s.decision.kind === 'TURN_MENU') {
            turn = s;
            break;
          }
          if (!seen.has(s.decision.kind)) {
            seen.add(s.decision.kind);
            note(`P1 途中决策 ${s.decision.kind}`, { deadlineAt: s.decision.deadlineAt, centerCd: s.centerCd, rail: s.rail });
            await shot(pa, `bankrupt-other-${s.decision.kind}`, 800);
          }
          await actIntent(pa);
        }
        await pa.waitForTimeout(250);
      }
      if (!turn) throw new Error('bankrupt: 等不到 P1 的回合菜单');
      note('P1 回合菜单', { decision: turn.decision, centerCd: turn.centerCd, rail: turn.rail, effective: turn.effective });
      await shot(pa, 'bankrupt-p1-turn', 1500);
      // P2 关掉页面：断线宽限（15 秒）后转托管；P1 仍不限时，过了 normal 档回合菜单时限（30 秒 + 0.8 秒）也不超时
      await B.ctx.close();
      bClosed = true;
      await pa.waitForTimeout(33_000);
      const later = await state(pa);
      note('P2 关页面 33 秒后', {
        effective: later.effective,
        controlB: later.controls?.[seatB],
        decision: later.decision,
        seqSame: later.seq === turn.seq,
        centerCd: later.centerCd,
        rail: later.rail,
      });
      if (later.decision?.id !== turn.decision.id || later.seq !== turn.seq) problem('bankrupt: P1 的回合菜单超时被代决了');
      if (later.effective !== 'off') problem(`bankrupt: P2 断线后有效档位 ${later.effective}`);
      if (later.controls?.[seatA] !== 'human') problem(`bankrupt: P1 被转成 ${later.controls?.[seatA]}`);
      await shot(pa, 'bankrupt-p2-closed', 0);
    }
    report.errors = { A: A.errors, B: B.errors };
    if (A.errors.length) problem(`duo: P1 控制台错误 ${JSON.stringify(A.errors.slice(0, 5))}`);
    if (B.errors.length) problem(`duo: P2 控制台错误 ${JSON.stringify(B.errors.slice(0, 5))}`);
    await A.ctx.close();
  }
} catch (e) {
  problem(`脚本异常：${e.stack ?? e.message}`);
} finally {
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${OUT}/log.txt`, LOG.join('\n'));
  await browser.close();
  log(`problems: ${report.problems.length}`);
  process.exitCode = report.problems.length ? 1 : 0;
}
