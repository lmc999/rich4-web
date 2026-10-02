// 验证（收起交通工具、变回步行）：原版皮肤 + 真实素材包，两个真人（P2 另开页面当陪练，由脚本代答），台湾图、不限时。
// 三种情况：
//   moto   机车开局 → 道具欄右下角「收起」→ 步行 → 掷骰
//   car    汽车开局 → 收起 → 步行 → 掷骰；另外让 P2 买下 F1 盖加油站，P1 步行停上去不收费；
//          再用道具把汽车装回、竖槽只选 1 颗停上去 → 照收（1 颗骰子不等于步行）
//   switch 步行开局 → 中途用道具换乘机车 → 汽车（机车退回背包）→ 收起 → 步行 → 掷骰
// 收起后检查：GO 竖槽 1 颗、掷骰颗数 1（DICE_ROLLED 与骰子覆盖层）、人物外观（掷骰前 / 持骰 / 行走的姿态库都是步行的
// char.<c>.stand / dice / walk，没有 moto / car）、背包里多一台车。每步截整页、GO 钮与道具欄，
// 写到 .cache/vehicle/verify/<名字>/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；端口按 VEHICLE_BASE，缺省 5937 / 3937）：
//   (apps/server) PORT=3937 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5937 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=<repo>/rich4-assets RICH4_DATA_DIR=<repo>/rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=<repo>/.cache/vehicle/verify/data npx tsx src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:3937 npx vite --port 5937 --strictPort
// 用法：node test/vehicle-verify-shots.mjs [宽x高=1920x1080] [--mobile] [--name=desktop] [--only=moto,car,switch]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.VEHICLE_BASE ?? 'http://localhost:5937';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const MOBILE = args.includes('--mobile');
const NAME = args.find((a) => a.startsWith('--name='))?.slice(7) ?? `${size[0]}x${size[1]}`;
const ONLY = (args.find((a) => a.startsWith('--only='))?.slice(7) ?? 'moto,car,switch').split(',');
const OUT = `.cache/vehicle/verify/${NAME}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, mobile: MOBILE, games: {} };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function newPage(name, primary) {
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

/** 本人的交通工具 / 骰子数 / 背包 / 现金，TURN_MENU 的 vehicle 与颗数，界面上的收起格、GO 竖槽与棋子姿态 */
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
      character: p?.character ?? null,
      node: p?.node ?? null,
      cash: p?.cash ?? null,
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
        diceCount: cnt
          ? {
              value: cnt.getAttribute('data-value'),
              slots: cnt.getAttribute('data-slots'),
              on: [...cnt.querySelectorAll('[data-testid="dice-count-die"]')].map((x) => x.getAttribute('data-on')),
            }
          : null,
        roll: document.querySelector('[data-testid="action-roll"]')?.textContent?.trim() ?? null,
      },
      pose: a?.poseKey ?? null,
      statusVehicle: a?.currentStatus?.vehicle ?? null,
    };
  });
}

/** 页面里常驻的追踪器（只记变化）：本人棋子的姿态库、骰子覆盖层的颗数 */
async function installTracer(page) {
  await page.evaluate(() => {
    if (window.__vtrace) return;
    const trace = [];
    window.__vtrace = trace;
    let last = '';
    const tick = () => {
      const h = window.__rich4;
      const me = h?.store?.room?.getState().room?.you?.seat ?? null;
      const a = me === null ? null : h?.renderer?.board?.actor?.(me);
      const ov = document.querySelector('[data-testid="dice-overlay"]');
      const snap = {
        pose: a?.poseKey ?? null,
        walking: a?.isWalking ?? false,
        dice: ov ? { seat: Number(ov.getAttribute('data-seat')), count: Number(ov.getAttribute('data-count')) } : null,
      };
      const k = JSON.stringify(snap);
      if (k !== last) {
        last = k;
        trace.push({ t: Math.round(performance.now()), ...snap });
      }
    };
    setInterval(tick, 30);
  });
}

async function traceSince(page, i0) {
  return page.evaluate((i) => window.__vtrace.slice(i), i0);
}

async function traceLen(page) {
  return page.evaluate(() => window.__vtrace.length);
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
  const vw = page.viewportSize();
  const x = Math.max(0, r.x - pad);
  const y = Math.max(0, r.y - pad);
  await page.screenshot({
    path: file,
    clip: { x, y, width: Math.min(r.w + pad * 2, vw.width - x), height: Math.min(r.h + pad * 2, vw.height - y) },
  });
  return true;
}

let shotN = 0;
let game = null;
async function shot(page, name, extra = {}) {
  shotN++;
  const base = `${OUT}/${game.vehicle}-${String(shotN).padStart(2, '0')}-${name}`;
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

async function waitDecision(page, kinds, timeout, other) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await state(page);
    if (st.idle && st.decision && st.submitting === null && kinds.includes(st.decision.kind)) return st;
    if (other) await other();
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: `${OUT}/${game?.vehicle ?? 'x'}-fail-${kinds[0]}.png` }).catch(() => {});
  throw new Error(`wait ${kinds} timeout: ${JSON.stringify(await state(page))}`);
}

async function closeMenu(page) {
  const close = page.getByTestId('turn-close');
  if ((await close.count()) > 0 && (await close.isVisible())) await close.click({ timeout: 3000 }).catch(() => {});
  else await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

/** 打开道具欄（工具列「道具」）；hover 为 testid 时悬停该格看消息框（手机上没有悬停，跳过） */
async function openItems(page, hover = null) {
  await page.getByTestId('action-items').click({ timeout: 5000 });
  await page.waitForTimeout(700);
  if (hover && !MOBILE) {
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
  const base = `${OUT}/${game.vehicle}-${String(shotN).padStart(2, '0')}-${name}`;
  await clipShot(page, `${base}.bar.png`, 'turn-inventory', 8).catch(() => {});
  if (!MOBILE) await clipShot(page, `${base}.info.png`, 'turn-info', 8).catch(() => {});
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

function check(cond, msg, detail) {
  game.checks.push({ ok: !!cond, msg, detail });
  log(`${cond ? 'PASS' : 'FAIL'} [${game.vehicle}] ${msg}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  if (!cond) game.failed = (game.failed ?? 0) + 1;
}

/** 日志里某座位的事件（原事件），从下标 i0 起 */
async function eventsOf(page, seat, types, i0 = 0) {
  return page.evaluate(
    ({ s, ts, i }) =>
      window.__rich4.store.game
        .getState()
        .log.slice(i)
        .filter((l) => ts.includes(l.type))
        .map((l) => ({ type: l.type, ...l.src?.event }))
        .filter((e) => e.seat === s || e.payer === s),
    { s: seat, ts: types, i: i0 },
  );
}

async function logLen(page) {
  return page.evaluate(() => window.__rich4.store.game.getState().log.length);
}

async function playGame(kind) {
  shotN = 0;
  const vehicle = kind === 'switch' ? 'walk' : kind;
  game = { vehicle: kind, steps: [], checks: [] };
  report.games[kind] = game;
  const A = await newPage('P1', true);
  const B = await newPage('P2', false);
  const pa = A.page;
  const pb = B.page;
  /** P2 的回合计划：TURN_MENU 时取一项（传送 + 强制点数），落点决策按 answers 回答，其余按默认 */
  const bPlans = [];
  let bPlan = null;
  const driveB = async () => {
    const st = await state(pb);
    if (!st.idle || !st.decision || st.submitting !== null || st.decision.seat !== st.seat) return;
    if (st.decision.kind === 'TURN_MENU') {
      bPlan = bPlans.shift() ?? null;
      if (bPlan) {
        await debug(pb, { op: 'teleport', seat: st.seat, node: bPlan.node, prev: bPlan.prev });
        await debug(pb, { op: 'forceNext', purpose: 'dice', values: [bPlan.dice] });
        const chk = await pb.evaluate(() => {
          const g = window.__rich4.store.game.getState();
          const me = window.__rich4.store.room.getState().room.you.seat;
          return { me, node: g.view.players.find((x) => x.seat === me)?.node, d: g.decision && { k: g.decision.kind, seat: g.decision.seat, id: g.decision.decisionId } };
        });
        log(`[${kind}] P2 plan ${JSON.stringify(bPlan)} after debug ${JSON.stringify(chk)}`);
      }
      // 开局交通工具对所有人生效（P2 也坐车）：按计划走时只掷 1 颗
      const r = await act(pb, bPlan ? { type: 'ROLL', dice: 1 } : { type: 'ROLL' });
      if (bPlan) log(`[${kind}] P2 roll → ${JSON.stringify(r)}`);
      return;
    }
    const answer = bPlan?.answers?.[st.decision.kind];
    const info = bPlan
      ? await pb.evaluate(() => {
          const g = window.__rich4.store.game.getState();
          const me = window.__rich4.store.room.getState().room.you.seat;
          const p = g.view.players.find((x) => x.seat === me);
          return { node: p.node, options: g.decision?.options };
        })
      : null;
    const r = await act(pb, answer ?? null);
    if (bPlan)
      log(
        `[${kind}] P2 answer ${st.decision.kind} ${JSON.stringify(answer ?? 'default')} → ${JSON.stringify(r)} ${JSON.stringify(info).slice(0, 300)}`,
      );
  };
  /** 等到 P1 的回合菜单；途中 P1 的其他决策按默认（买地一类默认不买） */
  const myTurn = () =>
    waitDecision(pa, ['TURN_MENU'], 240_000, async () => {
      await driveB();
      const s = await state(pa);
      if (s.idle && s.decision && s.submitting === null && s.decision.seat === s.seat && s.decision.kind !== 'TURN_MENU')
        await act(pa);
    });

  await pa.goto(`${BASE}/?test=1`);
  await pa.getByTestId('home-nickname').fill('測試甲');
  await pa.getByTestId('home-nickname').blur();
  await pa.getByTestId('home-create').click();
  await pa.getByTestId('set-map').selectOption('taiwan');
  await pa.getByTestId('set-timer').selectOption('off');
  await pa.getByTestId('set-ai-count').selectOption('0');
  await pa.getByTestId('set-vehicle').selectOption(vehicle);
  await pa.getByTestId('create-submit').click();
  await pa.waitForURL(/\/r\/\d{6}/);
  const code = /\/r\/(\d{6})/.exec(pa.url())[1];
  log(`[${kind}] room ${code}`);
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
  const skin = (await state(pa)).skin;
  log(`[${kind}] skin ${JSON.stringify(skin)}`);
  await Promise.all([skipFly(pa), skipFly(pb)]);
  await installTracer(pa);
  // 收走路上的神明与物件（财神 / 穷神附身会改过路费、油费，路障会挡住强制路线）
  await debug(pa, { op: 'clearBoard' });
  if (kind === 'car') {
    // P2 两个回合：从 10 号（公园，来路 82）走 1 步停到 F1（85 号）→ 买地；再来一次 → 盖加油站
    bPlans.push(
      { node: 10, prev: 82, dice: 1, answers: { BUY_FACILITY: { type: 'CONFIRM' } } },
      { node: 10, prev: 82, dice: 1, answers: { BUILD_FACILITY: { type: 'BUILD_FACILITY', facility: 'gas' } } },
    );
  }

  await myTurn();
  await pa.waitForTimeout(1500);
  const p0 = await shot(pa, 'turn1');
  const C = p0.character;
  check(p0.vehicle === vehicle, `开局交通工具 ${vehicle}`, p0.vehicle);
  const itemOf = { moto: 5, car: 6 };

  if (kind === 'switch') {
    // 中途换乘：给机车、汽车各一台 → 用机车 → 用汽车（机车退回背包）
    check(p0.options?.vehicle?.canStow === false && p0.ui.diceCount?.slots === '1', '步行开局：不能收起、竖槽 1 颗', p0);
    await debug(pa, {
      op: 'give',
      seat: p0.me,
      cards: [],
      items: [
        { item: 5, qty: 1 },
        { item: 6, qty: 1 },
      ],
    });
    await myTurn();
    const pw = await barShot(pa, 'itembar-walk', 'inv-item-5');
    check(pw.ui.stow === null, '步行时道具欄没有收起格', pw.ui.stow);
    for (const [item, v, slots] of [
      [5, 'moto', '2'],
      [6, 'car', '3'],
    ]) {
      if ((await pa.getByTestId('turn-inventory').count()) === 0) await openItems(pa);
      await pa.getByTestId(`inv-item-${item}`).click({ timeout: 5000 });
      await pa.waitForTimeout(500);
      await pa.getByTestId('target-confirm').click({ timeout: 5000 });
      await myTurn();
      await pa.waitForTimeout(2000);
      const pv = await shot(pa, `equip-${v}`);
      check(
        pv.vehicle === v && pv.ui.diceCount?.slots === slots && pv.pose === `char.${C}.${v}.stand`,
        `换乘 ${v}：竖槽 ${slots} 颗、姿态 ${v}`,
        { vehicle: pv.vehicle, slots: pv.ui.diceCount?.slots, pose: pv.pose },
      );
    }
    const pb2 = await probe(pa);
    check((pb2.bag?.[5] ?? 0) === 1 && (pb2.bag?.[6] ?? 0) === 0, '换成汽车后机车退回背包', pb2.bag);
  }

  const cur = kind === 'switch' ? 'car' : kind;
  const item = itemOf[cur];
  const bag0 = (await probe(pa)).bag?.[item] ?? 0;
  const pre = await probe(pa);
  check(
    pre.options?.vehicle?.canStow === true &&
      pre.ui.diceCount?.slots === String(cur === 'moto' ? 2 : 3) &&
      pre.pose === `char.${C}.${cur}.stand`,
    `收起前：${cur}、菜单可收起、竖槽 ${cur === 'moto' ? 2 : 3} 颗、姿态 char.${C}.${cur}.stand`,
    { canStow: pre.options?.vehicle, slots: pre.ui.diceCount, pose: pre.pose },
  );

  // ① 道具欄：右下角「收起」格
  const p1 = await barShot(pa, 'itembar-stow', 'inv-stow-vehicle');
  check(
    p1.ui.stow !== null && !p1.ui.stow.disabled && p1.ui.stow.sprite === `ui.itemBar/${cur === 'moto' ? 15 : 16}`,
    `道具欄右下角收起格可点，画 ui.itemBar/${cur === 'moto' ? 15 : 16}`,
    p1.ui.stow,
  );
  const cellBox = await rect(pa, 'inv-stow-vehicle');
  const barBox = await rect(pa, 'turn-inventory');
  if (cellBox && barBox) {
    // 右下角：格子的右边、下边都在欄的右下部（5×3 的最后一格）
    const rx = (cellBox.x + cellBox.w / 2 - barBox.x) / barBox.w;
    const ry = (cellBox.y + cellBox.h / 2 - barBox.y) / barBox.h;
    check(rx > 0.75 && ry > 0.6, '收起格位于道具欄右下角', { rx: +rx.toFixed(3), ry: +ry.toFixed(3), cellBox, barBox });
  }

  // ② 点下去：收起、改回步行（道具欄随即收起）
  await pa.getByTestId('inv-stow-vehicle').click({ timeout: 5000 });
  await myTurn();
  await pa.waitForTimeout(1500);
  const p2 = await shot(pa, 'after-stow');
  check(p2.vehicle === 'walk' && p2.diceCount === 1, '收起后步行、1 颗骰子', { v: p2.vehicle, d: p2.diceCount });
  check((p2.bag?.[item] ?? 0) === bag0 + 1, `背包里 ${item} 号 +1`, { before: bag0, after: p2.bag });
  check(p2.ui.stow === null && (await pa.getByTestId('turn-inventory').count()) === 0, '道具欄已收起');
  check(
    p2.ui.diceCount?.slots === '1' && p2.ui.diceCount?.value === '1',
    'GO 竖槽 1 颗',
    p2.ui.diceCount,
  );
  check(p2.pose === `char.${C}.stand` && p2.statusVehicle === 'walk', `姿态 char.${C}.stand`, {
    pose: p2.pose,
    st: p2.statusVehicle,
  });
  check(
    p2.options?.dice?.allowed?.length === 1 && p2.options?.vehicle?.canStow === false,
    '菜单：只能 1 颗、不能再收起',
    p2.options,
  );
  // 另一名玩家的页面：P1 的棋子同样换成步行姿态，座位信息里的交通工具也是步行
  const other = await pb.evaluate((seat) => {
    const h = window.__rich4;
    const a = h.renderer?.board?.actor?.(seat);
    const p = h.store.game.getState().view.players.find((x) => x.seat === seat);
    return { pose: a?.poseKey ?? null, statusVehicle: a?.currentStatus?.vehicle ?? null, vehicle: p?.vehicle, dice: p?.diceCount };
  }, p2.me);
  check(
    other.pose === `char.${C}.stand` && other.vehicle === 'walk' && other.dice === 1,
    'P2 页面上 P1 也是步行（姿态、view）',
    other,
  );

  // ③ 掷骰：强制 4，只掷出 1 颗（步数 4）；追踪持骰 / 行走姿态与骰子覆盖层
  // 缺省从 5 号（卡片格，来路 42）出发：43–46 都是地产格，走 4 步停在 46，不经过新闻 / 命运
  const rollOnce = async (tag, o = {}) => {
    await myTurn();
    const me = (await probe(pa)).me;
    await debug(pa, { op: 'teleport', seat: me, node: o.node ?? 5, prev: o.prev ?? 42 });
    // 强制值按次入队（多出来的会留给下一次掷骰），所以只给实际要掷的颗数
    await debug(pa, { op: 'forceNext', purpose: 'dice', values: o.faces ?? [4] });
    await myTurn();
    if (o.pickOne) {
      await pa.getByTestId('dice-count-die').first().click({ timeout: 5000 });
      await pa.waitForTimeout(300);
    }
    const before = await shot(pa, `${tag}-before-roll`);
    const l0 = await logLen(pa);
    const t0 = await traceLen(pa);
    const cash0 = before.cash;
    await pa.getByTestId('action-roll').click({ timeout: 5000 });
    // 等本人的掷骰事件出现、演出走完
    const tRoll = Date.now();
    let rolls = [];
    while (Date.now() - tRoll < 30_000) {
      rolls = await eventsOf(pa, me, ['DICE_ROLLED'], l0);
      if (rolls.length > 0) break;
      await pa.waitForTimeout(100);
    }
    await pa.waitForTimeout(1200);
    await shot(pa, `${tag}-rolling`);
    // 走完、落点（不需要本人决策的）：等到演出空闲
    const tIdle = Date.now();
    while (Date.now() - tIdle < 30_000) {
      const st = await state(pa);
      if (st.idle && (st.decision === null || st.decision.seat !== st.seat || st.decision.kind !== 'TURN_MENU')) break;
      await pa.waitForTimeout(150);
    }
    await pa.waitForTimeout(800);
    const landed = await shot(pa, `${tag}-landed`);
    const tr = await traceSince(pa, t0);
    const fees = await eventsOf(pa, me, ['FEE_PAID', 'COMPANY_FEE', 'TOLL_EXEMPT'], l0);
    return { rolls, trace: tr, fees, landed, cash0 };
  };

  const r1 = await rollOnce('walk-roll', { faces: [4] });
  const ev = r1.rolls[0];
  check(ev && ev.diceCount === 1 && ev.dice?.length === 1 && ev.dice[0] === 4, '掷骰 1 颗（DICE_ROLLED dice=[4]）', ev);
  const overlays = r1.trace.filter((x) => x.dice && x.dice.seat === p2.me).map((x) => x.dice.count);
  check(overlays.length > 0 && overlays.every((n) => n === 1), '骰子覆盖层 1 颗', [...new Set(overlays)]);
  const poses = [...new Set(r1.trace.map((x) => x.pose).filter(Boolean))];
  check(
    poses.length > 0 && poses.every((k) => !/\.(moto|car|engineer)\./.test(k)) && poses.some((k) => k === `char.${C}.walk` || k.endsWith('.boat.walk')),
    '掷骰 / 行走姿态都是步行（无 moto / car）',
    poses,
  );
  game.rollTrace = r1.trace.slice(0, 200);

  if (kind === 'car') {
    // 加油站：上一轮 P2 买下 F1；P1 再走一回合（7 号来路 97 → 96 号地产），让 P2 再轮一次盖加油站
    const me = p2.me;
    const rf = await rollOnce('filler', { node: 7, prev: 97, faces: [1] });
    check(rf.rolls[0]?.diceCount === 1, '下一回合仍是步行、1 颗', rf.rolls[0]);
    await myTurn();
    const fac = await pa.evaluate(() => window.__rich4.store.game.getState().view.facilities?.[0] ?? null);
    log(`[car] F1 ${JSON.stringify(fac)}`);
    check(fac && fac.owner !== null && fac.owner !== me && fac.type === 'gas' && fac.level >= 1, 'P2 已在 F1 盖了加油站', fac);

    const g1 = await rollOnce('gas-walk', { node: 10, prev: 82, faces: [1] });
    check(g1.landed.node === 85, '步行停在 F1（85 号）', g1.landed.node);
    check(
      g1.fees.every((e) => e.type !== 'FEE_PAID') && g1.landed.cash === g1.cash0,
      '步行停在别人的加油站：不收费、现金不变',
      { fees: g1.fees, cash0: g1.cash0, cash1: g1.landed.cash },
    );

    // 再把汽车装回，竖槽只选 1 颗：还是按汽车收油费（1 颗骰子不等于步行）
    await myTurn();
    await openItems(pa);
    await pa.getByTestId('inv-item-6').click({ timeout: 5000 });
    await pa.waitForTimeout(500);
    await pa.getByTestId('target-confirm').click({ timeout: 5000 });
    await myTurn();
    await pa.waitForTimeout(1500);
    const pc = await shot(pa, 'reequip-car');
    check(pc.vehicle === 'car' && pc.ui.diceCount?.slots === '3' && pc.pose === `char.${C}.car.stand`, '汽车装回：竖槽 3 颗、汽车姿态', {
      v: pc.vehicle,
      slots: pc.ui.diceCount,
      pose: pc.pose,
    });
    const g2 = await rollOnce('gas-car1', { node: 10, prev: 82, faces: [1], pickOne: true });
    const fee = g2.fees.find((e) => e.type === 'FEE_PAID');
    check(g2.rolls[0]?.diceCount === 1 && g2.landed.node === 85, '汽车选 1 颗停在 F1', { roll: g2.rolls[0], node: g2.landed.node });
    const econ = await pa.evaluate(() => {
      const g = window.__rich4.store.game.getState().view;
      const me = window.__rich4.store.room.getState().room.you.seat;
      return { pi: g.econ?.priceIndex ?? null, god: g.players.find((x) => x.seat === me)?.god ?? null };
    });
    check(fee && fee.feeKind === 'gas' && fee.amount > 0, '汽车（1 颗）停在加油站照收油费', { fee, econ });
    if (econ.god === null && econ.pi !== null)
      check(fee?.amount === 500 * 2 * 1 * econ.pi, '油费 = 500 × 2（汽车）× 1 步 × 物价指数', { amount: fee?.amount, pi: econ.pi });
    const carPoses = [...new Set(g2.trace.map((x) => x.pose).filter(Boolean))];
    check(carPoses.some((k) => k.includes('.car.')), '汽车行走姿态是 car', carPoses);
  }

  game.errors = { P1: A.errors, P2: B.errors };
  check(A.errors.length === 0 && B.errors.length === 0, '没有控制台错误', game.errors);
  await A.ctx.close();
  await B.ctx.close();
}

for (const k of ONLY) {
  try {
    await playGame(k);
  } catch (e) {
    log(`[${k}] FAILED ${e.stack ?? e}`);
    report.games[k] = { ...(report.games[k] ?? {}), crashed: String(e) };
  }
}
const summary = Object.fromEntries(
  Object.entries(report.games).map(([k, g]) => [
    k,
    { pass: (g.checks ?? []).filter((c) => c.ok).length, fail: (g.checks ?? []).filter((c) => !c.ok).length, crashed: g.crashed ?? null },
  ]),
);
report.summary = summary;
writeFileSync(`${OUT}/report-${ONLY.join('+')}.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/log-${ONLY.join('+')}.txt`, LOG.join('\n'));
log(`summary ${JSON.stringify(summary)}`);
log(`done → ${OUT}/report-${ONLY.join('+')}.json`);
await browser.close();
