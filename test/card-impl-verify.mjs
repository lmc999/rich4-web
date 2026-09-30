// 验证（卡片插画不透明 + 原版亮卡版式；实现阶段目视）：连本机真实素材包实例（缺省 http://localhost:5721），开一局台湾图
// （P1、P2 两名真人 + 1 名电脑），截图到 .cache/card/impl/shots/：
// 1) 电脑用卡：先发给电脑一把卡，几轮之内等它自己出卡，截 P1 / P2 两页的亮卡；
// 2) 卡片欄：30 张卡分两批（1–15、16–30）发给 P1，逐格悬停，截资料栏位置亮出的插画；
// 3) 真出卡：红卡、黑卡、查税、同盟、乌龟、陷害（P2 持免罪 → 被动卡生效）、梦游（P2 持复仇 → 被动卡生效）、均富、均贫、
//    转向、抢夺、停留、冬眠、再一张梦游（对冬眠的人 → 没有效果），截 P1 / P2 两页的亮卡；
// 4) 其余出不了的卡：在 P1 页把同一份出卡弹窗 spec 注入 popupStore（vite 开发服务器同一模块实例），走的是同一个
//    CardCast 组件与同一张素材，截图标 inject。
// 每次亮卡都读插画的 data-asset-key、背景图 URL → 素材包里的逻辑键，写进 verify.json。
// 用法：node test/card-impl-verify.mjs [站点]（服务器须 RICH4_TEST_MODE=1、RICH4_ASSETS_DIR=./rich4-assets）
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://localhost:5721';
const OUT = '.cache/card/impl';
const SHOTS = `${OUT}/shots`;
mkdirSync(SHOTS, { recursive: true });
writeFileSync(`${OUT}/verify.log`, '');

const manifest = JSON.parse(readFileSync('rich4-assets/manifest.json', 'utf8'));
/** 包内路径 → 逻辑键（整图） */
const URL_KEY = {};
for (const [k, e] of Object.entries(manifest.entries)) {
  if (e.type === 'image' && manifest.files[e.file]) URL_KEY[`/pack/${manifest.files[e.file].path}`] = k;
}

function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  appendFileSync(`${OUT}/verify.log`, `${line}\n`);
}

const result = { base: BASE, ai: [], hover: {}, cast: {}, inject: {}, errors: {} };
const save = () => writeFileSync(`${OUT}/verify.json`, JSON.stringify(result, null, 2));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const pages = {};
for (const name of ['P1', 'P2']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  const page = await ctx.newPage();
  result.errors[name] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') result.errors[name].push(`${m.type()}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => result.errors[name].push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) result.errors[name].push(`http ${r.status()} ${r.url()}`);
  });
  pages[name] = page;
}
const A = pages.P1;
const B = pages.P2;

// ───────────────────────── 通用 ─────────────────────────

async function state(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const d = g?.decision;
    const c = g?.view?.clock?.cursor;
    return {
      seq: g?.seq ?? 0,
      idle: h?.eventPlayer?.idle ?? false,
      decision: d ? { kind: d.kind, id: d.decisionId, seat: d.seat } : null,
      submitting: g?.submitting ?? null,
      turn: c && c.t === 'seat' ? c.seat : null,
    };
  });
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

async function view(page) {
  return page.evaluate(() => {
    const v = window.__rich4.store.game.getState().view;
    return v.players.map((p) => ({ seat: p.seat, node: p.node, cards: p.cards, controller: p.controller }));
  });
}

let shotN = 0;
async function shot(page, name) {
  shotN++;
  const file = `${SHOTS}/${String(shotN).padStart(3, '0')}-${name}.png`;
  // 只截经典舞台（640×480 等比缩放后的区域）
  const r = await page.evaluate(() => {
    const st = document.querySelector('[data-testid="classic-stage"]');
    if (!st) return null;
    const [sx, sy] = (st.getAttribute('data-stage') ?? '0,0').split(',').map(Number);
    const k = Number(st.getAttribute('data-scale'));
    const b = st.getBoundingClientRect();
    return { x: b.left + sx, y: b.top + sy, width: 640 * k, height: 480 * k };
  });
  await page.screenshot({ path: file, ...(r ? { clip: r } : {}) });
  return file;
}

/** 现场的亮卡弹窗与插画（背景图 URL → 逻辑键） */
async function probeCast(page) {
  return page.evaluate((urlKey) => {
    const el = document.querySelector('[data-testid="card-cast-popup"]');
    if (!el) return null;
    const art = el.querySelector('[data-testid="card-cast-art"]');
    const m = art ? /url\("?(.*?)"?\)$/.exec(getComputedStyle(art).backgroundImage) : null;
    const path = m ? new URL(m[1], location.href).pathname : null;
    return {
      card: Number(el.getAttribute('data-card')),
      variant: el.getAttribute('data-variant'),
      mode: el.getAttribute('data-mode'),
      classic: !!el.closest('[data-classic="true"]'),
      key: art?.getAttribute('data-asset-key') ?? null,
      bgKey: path ? (urlKey[path] ?? `?${path}`) : null,
      line: el.querySelector('[data-testid="card-cast-line"]')?.textContent ?? '',
      target: el.querySelector('[data-testid="card-cast-target"]')?.textContent ?? null,
      artRect: art ? [art.style.left, art.style.top, art.style.width, art.style.height] : null,
    };
  }, URL_KEY);
}

/** 两页都自动应答（除了 keep 页上 keepKinds 里的决策），直到 until() 为真 */
async function pump(until, { timeout = 180_000, keep = null, keepKinds = [], onTick = null } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await until()) return true;
    for (const page of [A, B]) {
      const st = await state(page).catch(() => null);
      if (!st?.idle || !st.decision || st.submitting !== null || st.decision.seat === undefined) continue;
      if (page === keep && keepKinds.includes(st.decision.kind)) continue;
      await act(page);
    }
    if (onTick) await onTick();
    await A.waitForTimeout(120);
  }
  return false;
}

async function waitTurnMenu(page) {
  const ok = await pump(
    async () => {
      const st = await state(page);
      return st.idle && st.decision?.kind === 'TURN_MENU' && st.submitting === null;
    },
    { keep: page, keepKinds: ['TURN_MENU'] },
  );
  if (!ok) throw new Error('等不到回合菜单');
}

// ───────────────────────── 开局 ─────────────────────────

async function setupRoom() {
  await A.goto(`${BASE}/?test=1`);
  await A.getByTestId('home-nickname').fill('測試甲');
  await A.getByTestId('home-nickname').blur();
  await A.getByTestId('home-create').click();
  await A.getByTestId('set-map').selectOption('taiwan');
  await A.getByTestId('set-timer').selectOption('off');
  await A.getByTestId('set-ai-count').selectOption('1');
  await A.getByTestId('create-submit').click();
  await A.waitForURL(/\/r\/\d{6}/);
  const code = /\/r\/(\d{6})/.exec(A.url())[1];
  await B.goto(`${BASE}/?test=1`);
  await B.getByTestId('home-nickname').fill('測試乙');
  await B.getByTestId('home-nickname').blur();
  await B.goto(`${BASE}/r/${code}?test=1`);
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
  for (const p of [A, B]) {
    await p.getByTestId('classic-stage').waitFor({ timeout: 90_000 });
    await p.waitForFunction(() => window.__rich4?.store?.game?.getState().view != null, undefined, { timeout: 60_000 });
  }
  result.room = code;
  result.skin = await A.evaluate(() => window.__rich4.skin);
  log('room', code, result.skin);
}

// ───────────────────────── 亮卡的截图 ─────────────────────────

/**
 * 出卡之后把这一串演出里的每个亮卡弹窗（出卡、随后的被动卡生效、没有效果）都截下来：P1 页上出现新弹窗约 400 ms 后截 P1，
 * 同时截 P2 页当时的弹窗；P2 的决策（嫁祸问不问、免费卡）按缺省应答。两页都空闲且没有弹窗一阵子后结束
 */
async function captureAll(tag, timeout = 25_000) {
  const got = [];
  const seen = new Set();
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < timeout) {
    const c = await currentCast(A).catch(() => null);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      await A.waitForTimeout(400);
      const rec = { ...c, P1: await probeCast(A), shotP1: await shot(A, `${tag}-card${c.card}-${c.variant}-P1`) };
      const pb = await probeCast(B).catch(() => null);
      if (pb) {
        rec.P2 = pb;
        rec.shotP2 = await shot(B, `${tag}-card${pb.card}-${pb.variant}-P2`);
      }
      got.push(rec);
      quiet = 0;
    } else {
      const sa = await state(A).catch(() => null);
      const sb = await state(B).catch(() => null);
      if (!c && sa?.idle && sb?.idle) quiet++;
      else quiet = 0;
      if (quiet > 12) break;
      if (sb?.idle && sb.decision && sb.submitting === null) await act(B);
    }
    await A.waitForTimeout(60);
  }
  return got;
}

/** P1 经卡片欄出一张卡：点卡 → 目标面板依次点 picks → YES；截这一串亮卡 */
async function castViaUi(card, picks, tag) {
  await waitTurnMenu(A);
  const d = await A.evaluate(() => window.__rich4.store.game.getState().decision);
  const row = d.options.cards.find((r) => r.card === card && r.usable);
  if (!row) {
    log(`卡 ${card} 不可用`, d.options.cards.filter((r) => r.card === card));
    return null;
  }
  await A.locator('[data-scene][data-testid$="-exit"]').waitFor({ state: 'detached' }).catch(() => {});
  if (!(await A.getByTestId('turn-inventory').isVisible().catch(() => false))) {
    await A.getByTestId('action-cards').click();
    await A.getByTestId('turn-inventory').waitFor();
  }
  await A.getByTestId(`inv-card-${row.slot}`).click();
  await A.getByTestId('target-picker').waitFor({ timeout: 5000 });
  for (const p of picks) {
    const el = A.getByTestId(p);
    if ((await el.count()) === 0) {
      log(`卡 ${card}：找不到目标 ${p}`);
      await A.getByTestId('target-cancel').click().catch(() => {});
      return null;
    }
    await el.first().click();
  }
  if (!(await A.getByTestId('target-confirm').isEnabled())) {
    log(`卡 ${card}：YES 不可用`);
    await A.getByTestId('target-cancel').click().catch(() => {});
    return null;
  }
  await A.getByTestId('target-confirm').click();
  return captureAll(tag);
}

// ───────────────────────── 流程 ─────────────────────────

/** 发卡：逐张给，牌堆里没有的（别人手里拿着）跳过 */
async function giveCards(page, seat, cards) {
  const got = [];
  for (const c of cards) {
    try {
      await debug(page, { op: 'give', seat, cards: [c], items: [] });
      got.push(c);
    } catch (e) {
      log(`发卡 ${c} → 座位 ${seat} 失败（牌堆里没有）`);
    }
  }
  return got;
}

/** 在页面里记下每个打开的出卡弹窗 spec（dev 服务器同一模块实例）：window.__castLog */
async function installCastLog(page) {
  await page.evaluate(async () => {
    const { usePopupStore } = await import('/src/ui/popups/popupStore.ts');
    window.__castLog = [];
    usePopupStore.subscribe((st, prev) => {
      const c = st.current;
      if (c && c !== prev.current && c.kind === 'cardCast') {
        window.__castLog.push({ id: c.popupId, seat: c.player.seat, card: c.card, variant: c.variant, t: Date.now() });
      }
    });
  });
}

async function currentCast(page) {
  return page.evaluate(async () => {
    const { usePopupStore } = await import('/src/ui/popups/popupStore.ts');
    const c = usePopupStore.getState().current;
    return c && c.kind === 'cardCast' ? { id: c.popupId, seat: c.player.seat, card: c.card, variant: c.variant } : null;
  });
}

/** 在 page 的回合菜单里逐格悬停 cards，截资料栏位置亮出的插画 */
async function hoverShots(page, cards) {
  if (!(await page.getByTestId('turn-inventory').isVisible().catch(() => false))) {
    await page.getByTestId('action-cards').click();
    await page.getByTestId('turn-inventory').waitFor();
  }
  const d = await page.evaluate(() => window.__rich4.store.game.getState().decision);
  for (const card of cards) {
    const row = d.options.cards.find((r) => r.card === card);
    if (!row) {
      log(`悬停：手里没有卡 ${card}`);
      continue;
    }
    await page.getByTestId(`inv-card-${row.slot}`).hover();
    await page.waitForTimeout(250);
    const art = await page.evaluate((urlKey) => {
      const el = document.querySelector('[data-testid="turn-card-art"]');
      if (!el) return null;
      const m = /url\("?(.*?)"?\)$/.exec(getComputedStyle(el).backgroundImage);
      const path = m ? new URL(m[1], location.href).pathname : null;
      return { card: Number(el.getAttribute('data-card')), bgKey: path ? (urlKey[path] ?? `?${path}`) : null };
    }, URL_KEY);
    result.hover[card] = { ...art, page: page === A ? 'P1' : 'P2', shot: await shot(page, `hover-card${card}`) };
  }
  log('悬停截图', Object.keys(result.hover).length);
  await page.mouse.move(5, 5);
  await page.keyboard.press('Escape');
}

const nodeOf = async (seat) => (await view(A)).find((p) => p.seat === seat).node;
const ones = () => debug(A, { op: 'forceNext', purpose: 'dice', values: Array(16).fill(1) });

/** 本页玩家的座位 */
const seatOf = (page) => page.evaluate(() => window.__rich4.store.room.getState().room?.you?.seat ?? null);

/** 等 page 的回合菜单里出现这些卡（发卡之后菜单会重发） */
async function waitCardsInMenu(page, cards) {
  await pump(
    async () => {
      const d = await page.evaluate(() => window.__rich4.store.game.getState().decision);
      return d?.kind === 'TURN_MENU' && cards.every((c) => d.options.cards.some((r) => r.card === c));
    },
    { keep: page, keepKinds: ['TURN_MENU'], timeout: 30_000 },
  );
}

try {
  await setupRoom();
  for (const p of [A, B]) await installCastLog(p);
  const players0 = await view(A);
  const aSeat = await seatOf(A);
  const bSeat = await seatOf(B);
  const aiSeat = players0.find((p) => p.controller === 'ai').seat;
  result.seats = { P1: aSeat, P2: bSeat, ai: aiSeat };
  log('座位', result.seats);

  // ── 1) 卡片欄悬停：1–15 在 P1 的回合菜单，16–30 在 P2 的回合菜单（手牌上限 15，满手再发会弃掉最便宜的） ──
  await waitTurnMenu(A);
  await giveCards(A, aSeat, Array.from({ length: 15 }, (_, i) => i + 1));
  await waitCardsInMenu(A, Array.from({ length: 15 }, (_, i) => i + 1));
  await hoverShots(A, Array.from({ length: 15 }, (_, i) => i + 1));
  await ones();
  await waitTurnMenu(B);
  await giveCards(A, bSeat, Array.from({ length: 15 }, (_, i) => i + 16));
  await waitCardsInMenu(B, Array.from({ length: 15 }, (_, i) => i + 16));
  await hoverShots(B, Array.from({ length: 15 }, (_, i) => i + 16));
  save();

  // ── 2) 电脑用卡：把 P1 与电脑传到 P2 身边，发给电脑一把卡，每人每次掷 1 点，等电脑自己出卡 ──
  const here = await nodeOf(bSeat);
  await debug(A, { op: 'teleport', seat: aSeat, node: here });
  await debug(A, { op: 'teleport', seat: aiSeat, node: here });
  log('发给电脑', await giveCards(A, aiSeat, [30, 26, 2, 6, 14, 29, 24, 25]));
  await ones();
  const aiSeen = [];
  const shotIds = new Set();
  let lastTurn = null;
  await pump(async () => aiSeen.length > 0, {
    timeout: 420_000,
    onTick: async () => {
      const st = await state(A).catch(() => null);
      if (st && st.turn !== lastTurn) {
        lastTurn = st.turn;
        log('轮到座位', st.turn);
        if (st.turn === aSeat) await ones().catch(() => {});
      }
      const c = await currentCast(A).catch(() => null);
      if (!c || c.seat !== aiSeat || shotIds.has(c.id)) return;
      shotIds.add(c.id);
      await A.waitForTimeout(400);
      const rec = { ...c, P1: await probeCast(A), shotP1: await shot(A, `ai-card${c.card}-P1`) };
      const pb = await probeCast(B).catch(() => null);
      if (pb) {
        rec.P2 = pb;
        rec.shotP2 = await shot(B, `ai-card${pb.card}-P2`);
      }
      aiSeen.push(rec);
      log('电脑出卡', rec);
    },
  });
  result.ai = aiSeen;
  result.castLog = { P1: await A.evaluate(() => window.__castLog), P2: await B.evaluate(() => window.__castLog) };
  save();

  // ── 3) 真出卡（P1，手里是 1–15）：P2 传到身边，改点券刷新回合菜单的目标候选 ──
  await waitTurnMenu(A);
  await debug(A, { op: 'teleport', seat: bSeat, node: await nodeOf(aSeat) });
  await debug(A, { op: 'setPoints', seat: aSeat, points: 500 });
  const castOnce = async (card, picks, tag) => {
    const got = await castViaUi(card, picks, tag);
    if (!got) return;
    for (const rec of got) (result.cast[rec.card] ??= []).push(rec);
    log(`出卡 ${card}`, got.map((r) => ({ card: r.card, seat: r.seat, variant: r.variant, P1: r.P1?.bgKey, P2: r.P2?.bgKey })));
    save();
  };
  for (const [card, picks] of [
    [1, []],
    [2, [`target-seat-${bSeat}`]],
    [6, [`target-actor-seat-${bSeat}`]],
    [13, [`target-rob-${bSeat}`, 'target-rob-card-0']], // 抢 P2 卡槽 0（梦游卡）
    [14, [`target-actor-seat-${bSeat}`]],
  ])
    await castOnce(card, picks, `cast-card${card}`);
  log('P1 拿到', await giveCards(A, aSeat, [24, 25, 26, 29]));
  for (const [card, picks] of [
    [24, ['target-stock-0']],
    [25, ['target-stock-1']],
    [26, [`target-seat-${bSeat}`]],
    [29, [`target-seat-${bSeat}`]],
  ])
    await castOnce(card, picks, `cast-card${card}`);
  log('P1 拿到', await giveCards(A, aSeat, [30, 17, 16]));
  for (const [card, picks, tag] of [
    [30, [`target-actor-seat-${bSeat}`], 'cast-card30'],
    [17, [`target-actor-seat-${bSeat}`], 'cast-card17'], // P2 的免罪卡自动生效
    [16, [`target-actor-seat-${bSeat}`], 'cast-card16'], // P2 不嫁祸（缺省），复仇卡生效，出卡人也梦游
    [15, [], 'cast-card15'],
    [16, [`target-actor-seat-${bSeat}`], 'cast2-card16'], // 对冬眠的人 → 没有效果
  ])
    await castOnce(card, picks, tag);
  result.castLog = { P1: await A.evaluate(() => window.__castLog), P2: await B.evaluate(() => window.__castLog) };
  save();

  // ── 4) 出不了的卡：注入同一份出卡弹窗 spec ──
  const castCards = new Set([...Object.keys(result.cast).map(Number)]);
  for (let card = 1; card <= 30; card++) {
    if (castCards.has(card)) continue;
    await A.evaluate(async (k) => {
      const { usePopupStore } = await import('/src/ui/popups/popupStore.ts');
      const passive = k >= 18 && k <= 21;
      usePopupStore.getState().open(
        {
          kind: 'cardCast',
          player: { seat: 0, character: 2, name: '測試甲' },
          card: k,
          cardName: `卡片 ${k}`,
          desc: '',
          title: '注入',
          targetText: passive ? null : '測試乙',
          variant: passive ? 'passive' : 'cast',
        },
        1500,
        1500,
        1,
      );
    }, card);
    await A.waitForTimeout(450);
    const p = await probeCast(A);
    result.inject[card] = { ...p, shot: await shot(A, `inject-card${card}`) };
    await A.evaluate(async () => {
      const { usePopupStore } = await import('/src/ui/popups/popupStore.ts');
      usePopupStore.getState().clear();
    });
    await A.waitForTimeout(150);
  }
  save();
} catch (e) {
  log(`ERROR ${e.stack ?? e}`);
  process.exitCode = 1;
} finally {
  save();
  await browser.close();
}
