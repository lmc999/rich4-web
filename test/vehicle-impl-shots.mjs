// 目视（交通工具「收起载具、变回步行」的实现）：两个真人（P2 另开页面，轮到自己时按默认应答），台湾图、真实素材包，
// 分别以机车 / 汽车开局：道具欄右下角「收起」格（悬停看说明）→ 点下去收起 → 步行（姿态、GO 竖槽 1 颗、背包里多一台车）
// → 再用道具把车装回去（再换乘）。每步截图整页、GO 钮、道具欄，并记录 view 与 TURN_MENU 的 options，
// 写到 .cache/vehicle/impl/<皮肤>/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；端口 3921 / 5921）：
//   (apps/server) PORT=3921 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5921 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=<repo>/rich4-assets RICH4_DATA_DIR=<repo>/rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=<repo>/.cache/vehicle/impl/data npx tsx src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:3921 npx vite --port 5921 --strictPort
// 用法：node test/vehicle-impl-shots.mjs [宽x高=1280x960] [--skin=original|procedural] [--only=moto,car] [--timer=slow|off]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.VEHICLE_BASE ?? 'http://localhost:5921';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x960').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const ONLY = (args.find((a) => a.startsWith('--only='))?.slice(7) ?? 'moto,car').split(',');
/** 决策限时（off 时没有大号倒计时数字挡住道具欄） */
const TIMER = args.find((a) => a.startsWith('--timer='))?.slice(8) ?? 'slow';
const OUT = `.cache/vehicle/impl/${SKIN}`;
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

/** 本人的交通工具 / 骰子数 / 背包，TURN_MENU 的 vehicle 与颗数，界面上的收起格、GO 竖槽与棋子姿态 */
async function probe(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h.store.game.getState();
    const me = h.store.room.getState().room?.you?.seat ?? null;
    const p = g.view?.players?.find((x) => x.seat === me);
    const d = g.decision;
    const o = d && d.kind === 'TURN_MENU' && d.seat === me ? d.options : null;
    const stow = document.querySelector('[data-testid="inv-stow-vehicle"]');
    const cnt = document.querySelector('[data-testid="action-dice-count"]');
    const a = h.renderer?.board?.actor?.(me);
    return {
      me,
      vehicle: p?.vehicle ?? null,
      diceCount: p?.diceCount ?? null,
      bag: p ? Object.fromEntries(Object.entries(p.items ?? {}).filter(([, n]) => n > 0)) : null,
      options: o ? { vehicle: o.vehicle ?? null, dice: o.dice, menuActions: o.menuActions } : null,
      ui: {
        stow: stow
          ? {
              label: stow.getAttribute('aria-label') ?? stow.textContent,
              sprite: stow.querySelector('[data-sprite]')?.getAttribute('data-sprite') ?? null,
              disabled: stow.disabled ?? false,
            }
          : null,
        diceCount: cnt ? { value: cnt.getAttribute('data-value'), slots: cnt.getAttribute('data-slots') } : null,
        roll: document.querySelector('[data-testid="action-roll"]')?.textContent?.trim() ?? null,
        info: document.querySelector('[data-testid="turn-info"]')?.textContent?.trim() ?? null,
      },
      pose: a?.poseKey ?? null,
      statusVehicle: a?.currentStatus?.vehicle ?? null,
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

/** 打开道具欄（工具列 / 行动区的「道具」）；hover 为 testid 时悬停该格看消息框 */
async function openItems(page, hover = null) {
  await page.getByTestId('action-items').click({ timeout: 5000 });
  await page.waitForTimeout(700);
  if (hover) {
    const cell = page.getByTestId(hover);
    if ((await cell.count()) > 0) {
      await cell.hover({ force: true });
      await page.waitForTimeout(400);
    }
  }
}

async function barShot(page, name, hover = null) {
  await openItems(page, hover);
  const p = await shot(page, name, { hover });
  const base = `${OUT}/${String(shotN).padStart(2, '0')}-${name}`;
  if (SKIN === 'original') {
    await clipShot(page, `${base}.bar.png`, 'turn-inventory', 8).catch(() => {});
    await clipShot(page, `${base}.info.png`, 'turn-info', 8).catch(() => {});
  } else await clipShot(page, `${base}.bar.png`, 'inventory-panel', 16).catch(() => {});
  return p;
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

function check(cond, msg) {
  if (!cond) throw new Error(`check failed: ${msg}`);
  game.checks.push(msg);
}

async function playGame(vehicle) {
  shotN = 0;
  game = { vehicle, steps: [], checks: [] };
  report.games[vehicle] = game;
  const item = vehicle === 'moto' ? 5 : 6;
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

  await pa.goto(`${BASE}/?test=1`);
  await pa.getByTestId('home-nickname').fill('測試甲');
  await pa.getByTestId('home-nickname').blur();
  await pa.getByTestId('home-create').click();
  await pa.getByTestId('set-map').selectOption('taiwan');
  await pa.getByTestId('set-timer').selectOption(TIMER);
  await pa.getByTestId('set-ai-count').selectOption('0');
  await pa.getByTestId('set-vehicle').selectOption(vehicle);
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
    if ((await p.getByTestId('screen-room').getAttribute('data-screen')) !== 'select')
      await p.getByTestId('char-select').click();
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
  const p0 = await shot(pa, `${vehicle}-turn1`);
  check(p0.vehicle === vehicle && p0.options?.vehicle?.canStow === true, `开局 ${vehicle}，菜单可收起`);

  // ① 道具欄：右下角「收起」格，悬停看说明
  const p1 = await barShot(pa, `${vehicle}-itembar-stow`, 'inv-stow-vehicle');
  check(p1.ui.stow !== null && !p1.ui.stow.disabled, '道具欄里有收起格且可点');
  if (SKIN === 'original') check(p1.ui.stow.sprite === `ui.itemBar/${vehicle === 'moto' ? 15 : 16}`, '收起格画图15/16');

  // ② 点下去：收起、改回步行（原版点完道具欄随即关闭）
  await pa.getByTestId('inv-stow-vehicle').click({ timeout: 5000 });
  await myTurn();
  await pa.waitForTimeout(1500);
  const p2 = await shot(pa, `${vehicle}-after-stow`);
  check(p2.vehicle === 'walk' && p2.diceCount === 1, '收起后步行、1 颗骰子');
  check((p2.bag?.[item] ?? 0) === 1, `背包里多一台 ${item} 号`);
  check(p2.ui.stow === null, '道具欄已收起');
  if (SKIN === 'original') check(p2.ui.diceCount?.slots === '1', 'GO 竖槽 1 颗');

  // ③ 再打开道具欄：右下角空着，车在格子里
  const p3 = await barShot(pa, `${vehicle}-itembar-after-stow`, `inv-item-${item}`);
  check(p3.ui.stow === null, '步行时没有收起格');

  // ④ 再换乘：点车的格子 → 目标面板（无目标）→ 确认
  await pa.getByTestId(`inv-item-${item}`).click({ timeout: 5000 });
  await pa.waitForTimeout(500);
  await pa.getByTestId('target-confirm').click({ timeout: 5000 });
  await myTurn();
  await pa.waitForTimeout(2500);
  const p4 = await shot(pa, `${vehicle}-reequip`);
  check(p4.vehicle === vehicle && p4.diceCount === (vehicle === 'moto' ? 2 : 3), '再换乘：车装回、骰子数回到上限');
  check((p4.bag?.[item] ?? 0) === 0, '背包里的车用掉');
  const p5 = await barShot(pa, `${vehicle}-itembar-reequip`, 'inv-stow-vehicle');
  check(p5.ui.stow !== null, '再换乘后收起格回来');
  await closeMenu(pa);

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
