// 调研（交通工具「收起载具、变回步行」的现状，只读）：两个真人（P2 另开页面，轮到自己时按默认应答），
// 分三局：开局机车、开局汽车、开局步行后用机车 / 汽车道具换车。每一步截图整页、GO 钮骰子数竖槽、道具欄，
// 并记录 view 里的 vehicle / diceCount / items 与 TURN_MENU 的 options.dice / options.items，
// 写到 .cache/vehicle/current/<皮肤>/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；端口 3912 / 5912）：
//   (apps/server) PORT=3912 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5912 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=<repo>/rich4-assets RICH4_DATA_DIR=<repo>/rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=<repo>/.cache/vehicle/current/data npx tsx src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:3912 npx vite --port 5912 --strictPort
// 用法：node test/vehicle-current-shots.mjs [宽x高=1280x960] [--skin=original|procedural] [--only=moto,car,walk]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.VEHICLE_BASE ?? 'http://localhost:5912';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x960').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const ONLY = (args.find((a) => a.startsWith('--only='))?.slice(7) ?? 'moto,car,walk').split(',');
const OUT = `.cache/vehicle/current/${SKIN}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, skin: SKIN, games: {} };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  if (SKIN !== 'original') {
    await ctx.addInitScript((skin) => {
      try {
        if (!localStorage.getItem('rich4.settings'))
          localStorage.setItem('rich4.settings', JSON.stringify({ state: { skin }, version: 2 }));
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
      decision: d ? { kind: d.kind, id: d.decisionId, seat: d.seat } : null,
      submitting: g?.submitting ?? null,
      skin: h?.skin ?? null,
    };
  });
}

/** view 里本人的交通工具 / 骰子数 / 背包，TURN_MENU 的骰子与道具行，界面上的道具格、GO 竖槽与棋子姿态 */
async function probe(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h.store.game.getState();
    const room = h.store.room.getState().room;
    const me = room?.you?.seat ?? null;
    const p = g.view?.players?.find((x) => x.seat === me);
    const d = g.decision;
    const o = d && d.kind === 'TURN_MENU' && d.seat === me ? d.options : null;
    const cells = [...document.querySelectorAll('[data-testid^="inv-item-"]')].map((el) => ({
      id: el.getAttribute('data-testid'),
      disabled: el.disabled ?? el.getAttribute('aria-disabled') === 'true',
      label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 60),
    }));
    const cnt = document.querySelector('[data-testid="action-dice-count"]');
    const diceBtns = [1, 2, 3]
      .map((n) => document.querySelector(`[data-testid="dice-${n}"],[data-testid="action-dice-${n}"]`))
      .filter(Boolean)
      .map((b) => `${b.getAttribute('data-testid')}:${b.getAttribute('aria-pressed') ?? ''}:${b.disabled ? 'off' : 'on'}`);
    const actors = (h.renderer?.board?.allActors?.() ?? []).map((a) => ({ seat: a.seat, pose: a.poseKey ?? null }));
    const invVehicle = document.querySelector('[data-testid="inv-vehicle"]')?.textContent ?? null;
    const plates = [...document.querySelectorAll('[data-testid^="turn-"]')].map((el) => el.getAttribute('data-testid'));
    return {
      me,
      vehicle: p?.vehicle ?? null,
      diceCount: p?.diceCount ?? null,
      bag: p ? Object.fromEntries(Object.entries(p.items ?? {}).filter(([, n]) => n > 0)) : null,
      engineer: p?.engineer ?? null,
      options: o
        ? {
            dice: o.dice,
            items: o.items.map((r) => `${r.item}×${r.count}${r.usable ? '' : `(${r.reason})`}`),
          }
        : null,
      ui: {
        itemCells: cells,
        diceCount: cnt
          ? {
              value: cnt.getAttribute('data-value'),
              slots: cnt.querySelectorAll('[data-testid="dice-count-die"]').length,
            }
          : null,
        diceBtns,
        invVehicle,
        plates,
      },
      actors,
    };
  });
}

async function rect(page, testId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }, testId);
}

async function clipShot(page, file, testId, pad = 16) {
  const r = await rect(page, testId);
  if (!r || r.w === 0) return false;
  await page.screenshot({
    path: file,
    clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + pad * 2, height: r.h + pad * 2 },
  });
  return true;
}

let shotN = 0;
let game = null;
async function shot(page, name, extra = {}) {
  shotN++;
  const base = `${OUT}/${String(shotN).padStart(2, '0')}-${name}`;
  const p = await probe(page);
  await page.screenshot({ path: `${base}.png` });
  await clipShot(page, `${base}.go.png`, 'action-roll', 24);
  game.steps.push({ name, file: `${base}.png`, probe: p, ...extra });
  log(`shot ${base}.png ${JSON.stringify(p)} ${JSON.stringify(extra)}`);
  return p;
}

async function debug(page, op) {
  const s0 = (await state(page)).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
}

async function act(page, intent = null) {
  return page.evaluate((it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(it ?? d.defaultIntent, d.decisionId) : null;
  }, intent);
}

async function waitDecision(page, kinds, timeout, other) {
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

/** 收起回合菜单：原版皮肤点「關閉」木框钮，程序化皮肤点对话框的 × */
async function closeMenu(page) {
  const close = page.getByTestId('turn-close');
  if ((await close.count()) > 0) await close.click({ timeout: 3000 }).catch(() => {});
  else {
    const x = page.getByRole('dialog').getByRole('button', { name: /关闭|關閉/ });
    if ((await x.count()) > 0) await x.first().click({ timeout: 3000 }).catch(() => {});
    else await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(600);
}

/** 打开道具欄（工具列 / 行动区的「道具」），截图整页与道具欄；可选悬停某个道具格看说明与不可用原因 */
async function itemBar(page, name, hoverItem = null) {
  await page.getByTestId('action-items').click({ timeout: 5000 });
  await page.waitForTimeout(700);
  if (hoverItem !== null) {
    const cell = page.getByTestId(`inv-item-${hoverItem}`);
    if ((await cell.count()) > 0) {
      await cell.hover({ force: true });
      await page.waitForTimeout(400);
    }
  }
  const p = await shot(page, name, { hoverItem });
  await clipShot(page, `${OUT}/${String(shotN).padStart(2, '0')}-${name}.bar.png`, SKIN === 'original' ? 'turn-items' : 'inventory-panel', SKIN === 'original' ? 220 : 16).catch(() => {});
  // 收起回合菜单
  await closeMenu(page);
  return p;
}

/** 原版皮肤开局的飞行动画（FlyVideo，testid=fly）：出现就按 Esc 跳过 */
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

async function playGame(vehicle) {
  shotN = 0;
  game = { vehicle, steps: [] };
  report.games[vehicle] = game;
  const A = await newPage('P1');
  const B = await newPage('P2');
  const pa = A.page;
  const pb = B.page;
  const driveB = async () => {
    const st = await state(pb);
    if (!st.idle || !st.decision || st.submitting !== null) return;
    await act(pb);
  };
  const myTurn = () =>
    waitDecision(pa, ['TURN_MENU'], 180_000, async () => {
      await driveB();
      const s = await state(pa);
      if (s.idle && s.decision && s.submitting === null && s.decision.kind !== 'TURN_MENU') await act(pa);
    });

  // ── 建房：P1 建台湾图、慢速、不补电脑、开局交通工具；P2 进房 ──
  const startVehicle = vehicle === 'car-roll1' ? 'car' : vehicle;
  await pa.goto(`${BASE}/?test=1`);
  await pa.getByTestId('home-nickname').fill('測試甲');
  await pa.getByTestId('home-nickname').blur();
  await pa.getByTestId('home-create').click();
  await pa.getByTestId('set-map').selectOption('taiwan');
  await pa.getByTestId('set-timer').selectOption('slow');
  await pa.getByTestId('set-ai-count').selectOption('0');
  await pa.getByTestId('set-vehicle').selectOption(startVehicle);
  await pa.screenshot({ path: `${OUT}/${vehicle}-00-create.png` });
  await pa.getByTestId('create-submit').click();
  await pa.waitForURL(/\/r\/\d{6}/);
  const code = /\/r\/(\d{6})/.exec(pa.url())[1];
  log(`[${vehicle}] room ${code}`);
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
    if ((await p.getByTestId('screen-room').getAttribute('data-screen')) !== 'select') await p.getByTestId('char-select').click();
  }
  await pb.getByTestId('room-ready').click();
  await pa.waitForTimeout(500);
  await pa.getByTestId('room-start').click();
  await pa.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  await pb.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  log(`[${vehicle}] skin ${JSON.stringify((await state(pa)).skin)}`);
  await Promise.all([skipFly(pa), skipFly(pb)]);

  await myTurn();
  await pa.waitForTimeout(1500);
  const seat = (await state(pa)).seat;
  await shot(pa, `${vehicle}-turn1`);

  if (vehicle === 'car-roll1') {
    // 开车时只能在 GO 竖槽里选 1 颗骰子（仍是汽车：油费、塞车 / 超速等按汽车算），选择会写回 diceCount
    const icon = await pa.evaluate(() => {
      const el = document.querySelector('[data-testid="dice-count-die"][data-index="0"]');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    if (icon) await pa.mouse.click(icon.x, icon.y);
    else await pa.getByTestId('action-dice-1').click({ timeout: 3000 });
    await pa.waitForTimeout(500);
    await shot(pa, 'car-roll1-picked-1');
    await pa.getByTestId('action-roll').click({ timeout: 5000 });
    await pa.waitForTimeout(300);
    await myTurn();
    await pa.waitForTimeout(1500);
    await shot(pa, 'car-roll1-next-turn');
  } else if (vehicle === 'moto' || vehicle === 'car') {
    // ① 开局有车：道具欄里没有任何能「收起」的东西（背包里的开局道具只有 1/2/3/4/8/9）
    await itemBar(pa, `${vehicle}-itembar`);
    // ② 给一台同款车：道具格置灰「已经装备了」，点不下去（想「再点一次收起」也不行）
    const same = vehicle === 'moto' ? 5 : 6;
    await debug(pa, { op: 'give', seat, cards: [], items: [{ item: same, qty: 1 }] });
    await myTurn();
    await pa.waitForTimeout(800);
    await itemBar(pa, `${vehicle}-itembar-same-${same}`, same);
    // 点一下置灰的同款车：只看说明（不提交）
    await pa.getByTestId('action-items').click({ timeout: 5000 });
    await pa.waitForTimeout(500);
    await pa.getByTestId(`inv-item-${same}`).click({ force: true, timeout: 3000 }).catch((e) => log(`click same: ${e.message.split('\n')[0]}`));
    await pa.waitForTimeout(600);
    await shot(pa, `${vehicle}-click-same-${same}`);
    await closeMenu(pa);
    // ③ 给另一种车：只能在机车 / 汽车之间互换，原车退回背包
    const other = vehicle === 'moto' ? 6 : 5;
    await debug(pa, { op: 'give', seat, cards: [], items: [{ item: other, qty: 1 }] });
    await myTurn();
    await pa.waitForTimeout(800);
    await itemBar(pa, `${vehicle}-itembar-other-${other}`, other);
    await act(pa, { type: 'USE_ITEM', item: other, target: { t: 'none' } });
    await myTurn();
    await pa.waitForTimeout(2500);
    await shot(pa, `${vehicle}-after-use-${other}`);
    await itemBar(pa, `${vehicle}-itembar-after-use-${other}`);
    // ④ GO 竖槽：选 1 颗（仍是车，只是少掷），截图
    const pick1 = await pa.evaluate(() => !!document.querySelector('[data-testid="dice-1"],[data-testid="action-dice-1"]'));
    game.steps.push({ name: 'dice-1-button-present', value: pick1 });
  } else {
    // 步行开局：给机车 → 使用 → 背包里的机车没了（装备中不计入背包），道具欄没有「步行」
    await itemBar(pa, 'walk-itembar');
    await debug(pa, { op: 'give', seat, cards: [], items: [{ item: 5, qty: 1 }] });
    await myTurn();
    await pa.waitForTimeout(800);
    await itemBar(pa, 'walk-itembar-got-5', 5);
    await act(pa, { type: 'USE_ITEM', item: 5, target: { t: 'none' } });
    await myTurn();
    await pa.waitForTimeout(2500);
    await shot(pa, 'walk-after-use-5');
    await itemBar(pa, 'walk-itembar-after-use-5');
    // 再给汽车 → 使用 → 机车退回背包
    await debug(pa, { op: 'give', seat, cards: [], items: [{ item: 6, qty: 1 }] });
    await myTurn();
    await pa.waitForTimeout(800);
    await act(pa, { type: 'USE_ITEM', item: 6, target: { t: 'none' } });
    await myTurn();
    await pa.waitForTimeout(2500);
    await shot(pa, 'walk-after-use-6');
    await itemBar(pa, 'walk-itembar-after-use-6', 5);
  }
  game.errors = { P1: A.errors, P2: B.errors };
  await A.ctx.close();
  await B.ctx.close();
}

for (const v of ONLY) {
  try {
    await playGame(v);
  } catch (e) {
    log(`[${v}] FAILED ${e.stack ?? e}`);
    report.games[v] = { ...(report.games[v] ?? {}), failed: String(e) };
  }
}
writeFileSync(`${OUT}/report-${ONLY.join('+')}.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/log-${ONLY.join('+')}.txt`, LOG.join('\n'));
log(`done → ${OUT}/report-${ONLY.join('+')}.json`);
await browser.close();
