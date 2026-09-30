// 整体验证（卡片插画不透明 + 原版亮卡；验证阶段目视）：连本机真实素材包实例（缺省 http://localhost:5731，vite 开发服务器），
// 开一局台湾图：P1 = 桌面 1920×1080，P2 = 手机横屏 844×390（isMobile + hasTouch，点击走 tap），1 名电脑（大老奸，
// 个性闸门对所有卡放行）。截图与记录写到 .cache/card/verify/。
// 1) 卡片欄：P1 拿 1–15、P2 拿 16–30，逐格悬停读资料栏位置亮出的插画（素材键、位置、截图）；两页各把视口换成另一种尺寸
//    （P1 → 844×390，P2 → 1920×1080）再悬停一遍，30 张 × 两种尺寸；
// 2) 电脑用卡：发给电脑 均贫 + 查税，电脑现金压低、真人现金抬高，它自己的回合会出卡（P2 持嫁祸卡时接受嫁祸 → 被动卡）；
// 3) 买地：全体掷 1 点（forceNext），P2 从 39 号格起步买下 L2、L3；
// 4) P1 出卡（桌面出卡人、手机观看）：站在 L2（40 号格）上依次出 1–14 能出的卡；
// 5) P2 出卡（手机出卡人、桌面观看）：请神符（必要时传到路上神明附近）、送神符、红卡、黑卡、涨价、查封、同盟、乌龟、查税、
//    陷害电脑（电脑持免罪 → 被动卡）、再一张陷害 P1（P1 持免罪 → 被动卡）、梦游电脑（电脑持复仇 → 被动卡）；
// 6) P1 下一回合出冬眠卡；
// 7) 始终没真出过的卡：在两页把同一份出卡弹窗 spec 注入 popupStore（同一个 CardCast 组件、同一张素材），另注入一例「没有效果」；
// 8) 在页面里逐张下载 30 张插画，数透明像素（应为 0）、核对尺寸 165×256。
// 全程有一个观察循环：任一页出现亮卡弹窗，开出约 350 ms 后读插画的素材键 / 背景图 URL → 逻辑键、位置，并截舞台。
// 用法：node test/card-verify.mjs [站点]（服务器须 RICH4_TEST_MODE=1、RICH4_ASSETS_DIR=./rich4-assets）
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://localhost:5731';
/** all = 完整流程；god = 只验送神符（先用请神符请来路上的坏神附身，再送走），输出带 -god 后缀 */
const MODE = process.argv[3] ?? 'all';
const SUFFIX = MODE === 'all' ? '' : `-${MODE}`;
const OUT = '.cache/card/verify';
const SHOTS = `${OUT}/shots${SUFFIX}`;
mkdirSync(SHOTS, { recursive: true });
writeFileSync(`${OUT}/verify${SUFFIX}.log`, '');

const DESK = { width: 1920, height: 1080 };
const MOBILE = { width: 844, height: 390 };

const manifest = JSON.parse(readFileSync('rich4-assets/manifest.json', 'utf8'));
/** 包内路径 → 逻辑键（整图） */
const URL_KEY = {};
for (const [k, e] of Object.entries(manifest.entries)) {
  if (e.type === 'image' && manifest.files[e.file]) URL_KEY[`/pack/${manifest.files[e.file].path}`] = k;
}
const map = JSON.parse(readFileSync('rich4-data/maps/taiwan.map.json', 'utf8'));
const TILE = new Map(map.tiles.map((t) => [t.id, t]));

function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  appendFileSync(`${OUT}/verify${SUFFIX}.log`, `${line}\n`);
}

const result = {
  base: BASE,
  packId: manifest.packId,
  hover: [],
  casts: [],
  inject: [],
  alpha: null,
  errors: {},
  plan: {},
  notes: [],
};
const save = () => writeFileSync(`${OUT}/verify${SUFFIX}.json`, JSON.stringify(result, null, 2));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const pages = {};
const vp = {};
for (const [name, opts] of [
  ['P1', { viewport: DESK, deviceScaleFactor: 1 }],
  ['P2', { viewport: MOBILE, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
]) {
  const ctx = await browser.newContext(opts);
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
  vp[name] = `${opts.viewport.width}x${opts.viewport.height}`;
}
const A = pages.P1;
const B = pages.P2;
const whoOf = (page) => (page === A ? 'P1' : 'P2');
/** P2 是触屏：点按走 tap */
const press = (page, loc) => (page === B ? loc.tap() : loc.click());

async function setVp(page, size) {
  await page.setViewportSize(size);
  vp[whoOf(page)] = `${size.width}x${size.height}`;
  await page.waitForTimeout(600);
  // 棋盘画布（Pixi resizeTo 宿主）只在 window resize 事件的下一帧读宿主尺寸，这时经典舞台还没按新视口重排，
  // 放大后画布停在旧尺寸（只画出左上角一块）。再触发一次 resize 让它读到重排后的宿主尺寸（测试绕行，问题见报告）
  await page.setViewportSize({ width: size.width + 1, height: size.height });
  await page.waitForTimeout(200);
  await page.setViewportSize(size);
  await page.waitForTimeout(600);
}

/** 棋盘画布的 CSS 尺寸与宿主（棋盘视窗）尺寸：两者不一致说明画布没跟上视口 */
async function boardCanvasFit(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="classic-board-slot"]');
    const c = host?.querySelector('canvas');
    if (!host || !c) return null;
    const h = host.getBoundingClientRect();
    const r = c.getBoundingClientRect();
    return { host: [Math.round(h.width), Math.round(h.height)], canvas: [Math.round(r.width), Math.round(r.height)] };
  });
}

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

async function decisionFull(page) {
  return page.evaluate(() => window.__rich4.store.game.getState().decision);
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
    return {
      players: v.players.map((p) => ({
        seat: p.seat,
        name: p.name,
        node: p.node,
        cards: p.cards,
        controller: p.controller,
        cash: p.cash,
        placed: p.placed,
        returning: p.returning ?? null,
        st: p.st,
      })),
      lands: v.lands.map((l) => ({ id: l.id, owner: l.owner, level: l.level, chain: l.chain })),
      gods: (v.gods ?? []).map((g) => ({ slot: g.slot, kind: g.kind, where: g.where })),
    };
  });
}

let shotN = 0;
/** 截经典舞台（640×480 等比缩放后的区域）；full=true 截整个视口 */
async function shot(page, name, { full = false } = {}) {
  shotN++;
  const file = `${SHOTS}/${String(shotN).padStart(3, '0')}-${name}-${whoOf(page)}-${vp[whoOf(page)]}.png`;
  const r = full
    ? null
    : await page.evaluate(() => {
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

/** 元素在舞台 640×480 坐标里的矩形 */
const STAGE_RECT_FN = `(el) => {
  const st = document.querySelector('[data-testid="classic-stage"]');
  if (!st || !el) return null;
  const [sx, sy] = (st.getAttribute('data-stage') ?? '0,0').split(',').map(Number);
  const k = Number(st.getAttribute('data-scale'));
  const b = st.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const f = (v) => Math.round(v * 10) / 10;
  return { x: f((r.left - b.left - sx) / k), y: f((r.top - b.top - sy) / k), w: f(r.width / k), h: f(r.height / k), scale: k };
}`;

/** 现场的亮卡弹窗与插画（背景图 URL → 逻辑键、舞台坐标矩形） */
async function probeCast(page) {
  return page.evaluate(
    ({ urlKey, rectFn }) => {
      const stageRect = eval(rectFn);
      const el = document.querySelector('[data-testid="card-cast-popup"]');
      if (!el) return null;
      const art = el.querySelector('[data-testid="card-cast-art"]');
      const cs = art ? getComputedStyle(art) : null;
      const m = cs ? /url\("?(.*?)"?\)$/.exec(cs.backgroundImage) : null;
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
        art: stageRect(art),
        frame: stageRect(el.querySelector('[data-testid="card-cast-frame"]')),
        filter: cs?.filter ?? null,
        transform: cs?.transform ?? null,
        opacity: cs?.opacity ?? null,
      };
    },
    { urlKey: URL_KEY, rectFn: STAGE_RECT_FN },
  );
}

/** 在页面里记下每个打开的出卡弹窗（dev 服务器同一模块实例）：window.__castOpen[popupId] = 打开时刻 */
async function installCastLog(page) {
  await page.evaluate(async () => {
    const { usePopupStore } = await import('/src/ui/popups/popupStore.ts');
    window.__castOpen = {};
    usePopupStore.subscribe((st, prev) => {
      const c = st.current;
      if (c && c !== prev.current && c.kind === 'cardCast') window.__castOpen[c.popupId] = Date.now();
    });
  });
}

async function currentCast(page) {
  return page.evaluate(async () => {
    const { usePopupStore } = await import('/src/ui/popups/popupStore.ts');
    const c = usePopupStore.getState().current;
    return c && c.kind === 'cardCast'
      ? {
          id: c.popupId,
          seat: c.player.seat,
          card: c.card,
          variant: c.variant,
          openedAt: window.__castOpen?.[c.popupId] ?? null,
        }
      : null;
  });
}

// ───────────────────────── 观察循环：亮卡弹窗 ─────────────────────────

let phase = 'setup';
let seats = null;
const seenCast = new Map();
function actorName(seat) {
  if (!seats) return String(seat);
  if (seat === seats.P1) return 'P1';
  if (seat === seats.P2) return 'P2';
  if (seat === seats.ai) return 'AI';
  return String(seat);
}

async function watchTick() {
  for (const page of [A, B]) {
    const who = whoOf(page);
    const c = await currentCast(page).catch(() => null);
    if (!c) continue;
    const id = `${who}:${c.id}`;
    let rec = seenCast.get(id);
    if (!rec) {
      rec = {
        page: who,
        viewport: vp[who],
        phase,
        popupId: c.id,
        seat: c.seat,
        actor: actorName(c.seat),
        card: c.card,
        variant: c.variant,
        seenAt: Date.now(),
        openedAt: c.openedAt,
      };
      seenCast.set(id, rec);
      result.casts.push(rec);
    }
    if (rec.probe) continue;
    const age = Date.now() - (rec.openedAt ?? rec.seenAt);
    if (age < 350) continue;
    rec.probeAgeMs = age;
    rec.probe = await probeCast(page);
    rec.shot = await shot(page, `${phase}-${rec.actor}-card${c.card}-${c.variant}`);
    log(
      `亮卡 ${who}@${rec.viewport} 出卡人 ${rec.actor} 卡 ${c.card}/${c.variant}`,
      rec.probe && { key: rec.probe.key, bg: rec.probe.bgKey, classic: rec.probe.classic, art: rec.probe.art, line: rec.probe.line },
    );
    save();
  }
}

// ───────────────────────── 自动应答 ─────────────────────────

/** 这些页上的买地 / 升级按 CONFIRM 应答（缺省是 DECLINE） */
const buyPages = new Set();
/** 这些页上的嫁祸决策接受（转嫁给第一个候选） */
const scapegoatPages = new Set(['P2']);
/** 各页还要用到的卡（弃牌时不弃这些） */
const keepCards = { P1: new Set(), P2: new Set() };

async function autoAnswer(page) {
  const who = whoOf(page);
  const d = await decisionFull(page);
  if (!d) return;
  switch (d.kind) {
    case 'BUY_LAND':
    case 'UPGRADE_LAND':
      if (buyPages.has(who)) {
        log(`${who} ${d.kind} → CONFIRM`);
        await act(page, { type: 'CONFIRM' });
        return;
      }
      break;
    case 'SCAPEGOAT':
      if (scapegoatPages.has(who) && d.options.candidates?.length) {
        log(`${who} 嫁祸 → 座位 ${d.options.candidates[0]}`);
        await act(page, { type: 'SCAPEGOAT', target: d.options.candidates[0] });
        return;
      }
      break;
    case 'DISCARD_CARD': {
      const spare = d.options.hand
        .filter((h) => !keepCards[who].has(h.card))
        .sort((a, b) => a.price - b.price)[0];
      if (spare) {
        log(`${who} 弃牌 → 卡 ${spare.card}（新到 ${d.options.incoming}）`);
        await act(page, { type: 'DISCARD', slot: spare.slot });
        return;
      }
      break;
    }
    default:
      break;
  }
  await act(page);
}

/** 两页都自动应答（除了 keep 页上 keepKinds 里的决策），同时跑观察循环，直到 until() 为真 */
async function pump(until, { timeout = 180_000, keep = null, keepKinds = [], onTick = null } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await watchTick();
    if (await until()) return true;
    for (const page of [A, B]) {
      const st = await state(page).catch(() => null);
      if (!st?.idle || !st.decision || st.submitting !== null || st.decision.seat === undefined) continue;
      if (page === keep && keepKinds.includes(st.decision.kind)) continue;
      await autoAnswer(page);
    }
    if (onTick) await onTick();
    await A.waitForTimeout(100);
  }
  return false;
}

async function waitTurnMenu(page, timeout = 240_000) {
  const ok = await pump(
    async () => {
      const st = await state(page);
      return st.idle && st.decision?.kind === 'TURN_MENU' && st.submitting === null;
    },
    { keep: page, keepKinds: ['TURN_MENU'], timeout },
  );
  if (!ok) throw new Error(`${whoOf(page)} 等不到回合菜单`);
}

/** 两页都空闲、没有亮卡弹窗一阵子（quietMs）且 page 回到回合菜单或轮到别人 */
async function settle(page, { quietMs = 1200, timeout = 40_000 } = {}) {
  let quietSince = null;
  await pump(
    async () => {
      const ca = await currentCast(A).catch(() => null);
      const cb = await currentCast(B).catch(() => null);
      const sa = await state(A);
      const sb = await state(B);
      const sp = page === A ? sa : sb;
      const calm = !ca && !cb && sa.idle && sb.idle && sp.decision?.kind === 'TURN_MENU';
      if (!calm) {
        quietSince = null;
        return false;
      }
      quietSince ??= Date.now();
      return Date.now() - quietSince >= quietMs;
    },
    { keep: page, keepKinds: ['TURN_MENU'], timeout },
  );
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
  await A.getByTestId('set-ai-preset')
    .selectOption('cunning')
    .catch((e) => log('选电脑个性失败', String(e).slice(0, 200)));
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
    await press(p, p.getByTestId(`char-${c}`));
    if ((await p.getByTestId('screen-room').getAttribute('data-screen')) !== 'select')
      await press(p, p.getByTestId('char-select'));
  }
  await press(B, B.getByTestId('room-ready'));
  await A.waitForTimeout(500);
  await A.getByTestId('room-start').click();
  for (const p of [A, B]) {
    await p.getByTestId('classic-stage').waitFor({ timeout: 90_000 });
    await p.waitForFunction(() => window.__rich4?.store?.game?.getState().view != null, undefined, { timeout: 60_000 });
  }
  result.room = code;
  result.skin = await A.evaluate(() => window.__rich4.skin);
  result.pacing = await A.evaluate(() => window.__rich4.store.game.getState().view?.config?.pacing ?? null);
  log('room', code, result.skin, result.pacing);
}

// ───────────────────────── 卡片欄悬停 ─────────────────────────

async function openInventory(page) {
  if (!(await page.getByTestId('turn-inventory').isVisible().catch(() => false))) {
    await press(page, page.getByTestId('action-cards'));
    await page.getByTestId('turn-inventory').waitFor();
  }
}

/** 在 page 的回合菜单里逐格悬停 cards，读资料栏位置亮出的插画并截图 */
async function hoverShots(page, cards, tag) {
  await openInventory(page);
  const d = await decisionFull(page);
  let first = true;
  for (const card of cards) {
    const row = d.options.cards.find((r) => r.card === card);
    if (!row) {
      log(`悬停：${whoOf(page)} 手里没有卡 ${card}`);
      result.hover.push({ page: whoOf(page), viewport: vp[whoOf(page)], card, missing: true });
      continue;
    }
    const cell = page.getByTestId(`inv-card-${row.slot}`);
    await cell.hover().catch((e) => log(`悬停失败：${String(e).slice(0, 160)}`));
    await page.waitForTimeout(250);
    let art = await readHoverArt(page);
    if (!art) {
      // 触屏上没有悬停：退到键盘焦点（卡片格 onFocus 同样亮插画）
      await cell.focus();
      await page.waitForTimeout(250);
      art = await readHoverArt(page);
      if (art) art.via = 'focus';
    }
    const rec = {
      page: whoOf(page),
      viewport: vp[whoOf(page)],
      tag,
      card,
      ...art,
      shot: await shot(page, `hover-${tag}-card${card}`),
    };
    if (first) {
      rec.fullShot = await shot(page, `hover-${tag}-card${card}-viewport`, { full: true });
      first = false;
    }
    result.hover.push(rec);
  }
  const ok = result.hover.filter(
    (h) => h.page === whoOf(page) && h.tag === tag && h.bgKey === `card.${h.card}`,
  ).length;
  log(`悬停 ${tag} ${whoOf(page)}@${vp[whoOf(page)]}：${ok}/${cards.length} 对上`);
  await page.mouse.move(5, 5);
  await page.keyboard.press('Escape');
  save();
}

async function readHoverArt(page) {
  return page.evaluate(
    ({ urlKey, rectFn }) => {
      const stageRect = eval(rectFn);
      const el = document.querySelector('[data-testid="turn-card-art"]');
      if (!el) return null;
      const m = /url\("?(.*?)"?\)$/.exec(getComputedStyle(el).backgroundImage);
      const path = m ? new URL(m[1], location.href).pathname : null;
      return {
        dataCard: Number(el.getAttribute('data-card')),
        bgKey: path ? (urlKey[path] ?? `?${path}`) : null,
        rect: stageRect(el),
        classic: !!el.closest('[data-classic="true"]'),
      };
    },
    { urlKey: URL_KEY, rectFn: STAGE_RECT_FN },
  );
}

// ───────────────────────── 出卡 ─────────────────────────

/** 发卡：逐张给，牌堆里没有的跳过 */
async function giveCards(seat, cards) {
  const got = [];
  for (const c of cards) {
    try {
      await debug(A, { op: 'give', seat, cards: [c], items: [] });
      got.push(c);
    } catch (e) {
      log(`发卡 ${c} → 座位 ${seat} 失败：${String(e).slice(0, 160)}`);
    }
  }
  return got;
}

async function waitCardsInMenu(page, cards) {
  await pump(
    async () => {
      const d = await decisionFull(page);
      return d?.kind === 'TURN_MENU' && cards.every((c) => d.options.cards.some((r) => r.card === c));
    },
    { keep: page, keepKinds: ['TURN_MENU'], timeout: 30_000 },
  );
}

const teleport = (seat, node, prev) => debug(A, { op: 'teleport', seat, node, ...(prev !== undefined ? { prev } : {}) });
/** 改点券让服务器重发回合菜单（目标候选按新位置重算） */
const refreshMenu = async (seat) => debug(A, { op: 'setPoints', seat, points: 900 + Math.floor(Math.random() * 90) });

/**
 * page 经卡片欄出一张卡：点卡 → 目标面板依次点 picks（找不到时点第一个候选）→ YES；等这一串演出结束。
 * picks 可以是函数 (row) => testid[]（按回合菜单里这张卡的候选现算）
 */
async function castViaUi(page, card, picks0 = []) {
  const who = whoOf(page);
  await waitTurnMenu(page);
  const d = await decisionFull(page);
  const row = d.options.cards.find((r) => r.card === card && r.usable);
  const picks = typeof picks0[0] === 'function' ? picks0[0](row) : picks0;
  if (!row) {
    const any = d.options.cards.filter((r) => r.card === card);
    log(`${who} 卡 ${card} 不可用`, any.map((r) => ({ slot: r.slot, usable: r.usable, reason: r.reason ?? null })));
    return false;
  }
  await page
    .locator('[data-scene][data-testid$="-exit"]')
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => {});
  await openInventory(page);
  await press(page, page.getByTestId(`inv-card-${row.slot}`));
  const picker = page.getByTestId('target-picker');
  await picker.waitFor({ timeout: 5000 });
  for (const p of picks) {
    const el = page.getByTestId(p);
    if ((await el.count()) === 0) {
      log(`${who} 卡 ${card}：没有目标 ${p}，改点第一个候选`);
      break;
    }
    await press(page, el.first());
    await page.waitForTimeout(120);
  }
  for (let k = 0; k < 4 && !(await page.getByTestId('target-confirm').isEnabled()); k++) {
    const btn = picker.locator('button[aria-pressed="false"]:not([disabled])').first();
    if ((await btn.count()) === 0) break;
    await press(page, btn);
    await page.waitForTimeout(150);
  }
  if (!(await page.getByTestId('target-confirm').isEnabled())) {
    log(`${who} 卡 ${card}：YES 不可用，取消`);
    await press(page, page.getByTestId('target-cancel')).catch(() => {});
    return false;
  }
  const kind = await picker.getAttribute('data-target-kind');
  await press(page, page.getByTestId('target-confirm'));
  log(`${who} 出卡 ${card}（目标形态 ${kind}）`);
  keepCards[who].delete(card);
  await settle(page);
  return true;
}

/** 按顺序出一串卡：[卡, 目标 testid…] */
async function castList(page, list) {
  for (const [card, ...picks] of list) {
    try {
      await castViaUi(page, card, picks);
    } catch (e) {
      log(`${whoOf(page)} 出卡 ${card} 出错：${String(e.stack ?? e).slice(0, 400)}`);
    }
    save();
  }
}

/** 离某节点最近的、有地产的路格（传过去后「脚下」有地） */
function neighborTiles(node) {
  return (TILE.get(node)?.links ?? []).map((l) => l.to);
}

// ───────────────────────── 注入与透明检查 ─────────────────────────

async function injectCast(page, card, variant, names) {
  await page.evaluate(
    async ({ k, variant, names }) => {
      const { usePopupStore } = await import('/src/ui/popups/popupStore.ts');
      usePopupStore.getState().open(
        {
          kind: 'cardCast',
          player: { seat: names.seat, character: names.character, name: names.name },
          card: k,
          cardName: names.cardName,
          desc: '',
          title: '注入',
          targetText: variant === 'cast' ? names.target : null,
          variant,
        },
        1500,
        1500,
        1,
      );
    },
    { k: card, variant, names },
  );
  await page.waitForTimeout(450);
  const p = await probeCast(page);
  const rec = {
    page: whoOf(page),
    viewport: vp[whoOf(page)],
    card,
    variant,
    probe: p,
    shot: await shot(page, `inject-card${card}-${variant}`),
  };
  await page.evaluate(async () => {
    const { usePopupStore } = await import('/src/ui/popups/popupStore.ts');
    usePopupStore.getState().clear();
  });
  await page.waitForTimeout(150);
  return rec;
}

/** 在页面里下载 30 张插画，数透明像素、读尺寸 */
async function alphaCheck(page) {
  return page.evaluate(async (entries) => {
    const out = {};
    for (const [key, url] of entries) {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      let transparent = 0;
      let partial = 0;
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] === 0) transparent++;
        else if (px[i] < 255) partial++;
      }
      out[key] = { w: img.naturalWidth, h: img.naturalHeight, transparent, partial };
    }
    return out;
  }, Array.from({ length: 30 }, (_, i) => {
    const key = `card.${i + 1}`;
    return [key, `/pack/${manifest.files[manifest.entries[key].file].path}`];
  }));
}

// ───────────────────────── 流程 ─────────────────────────

/** 卡名（繁体，注入时当 cardName 用；与 cards.json 的 zh-TW 名一致） */
const NAMES = [
  '',
  '均富卡',
  '均貧卡',
  '購地卡',
  '換地卡',
  '換屋卡',
  '轉向卡',
  '改建卡',
  '拍賣卡',
  '天使卡',
  '惡魔卡',
  '怪獸卡',
  '拆除卡',
  '搶奪卡',
  '停留卡',
  '冬眠卡',
  '夢遊卡',
  '陷害卡',
  '復仇卡',
  '嫁禍卡',
  '免費卡',
  '免罪卡',
  '送神符',
  '請神符',
  '紅卡',
  '黑卡',
  '查稅卡',
  '漲價卡',
  '查封卡',
  '同盟卡',
  '烏龜卡',
];

/** 坏神（小 / 大穷神、小 / 大衰神、恶魔；死神不可附身）：请来附身后送神符才可用 */
const BAD_GODS = [5, 6, 7, 8, 10];

/** 送神符真出卡：P1 拿请神符 + 送神符，传到路上坏神旁边，先请神（附身），再送神；P2 页同步看 */
async function godFlow() {
  const { P1: aSeat } = seats;
  phase = 'god';
  await waitTurnMenu(A);
  log('P1 拿到', await giveCards(aSeat, [23, 22]));
  const v = await view(A);
  const gods = v.gods.filter((g) => g.where.t === 'road' && BAD_GODS.includes(g.kind));
  log('路上坏神', gods, '全部', v.gods);
  for (const g of gods) {
    for (const nb of neighborTiles(g.where.node)) {
      await teleport(aSeat, nb);
      await refreshMenu(aSeat);
      await waitTurnMenu(A);
      const d = await decisionFull(A);
      if (!d.options.cards.find((r) => r.card === 23 && r.usable)) continue;
      log('P1 传到坏神旁边', { god: g, node: nb });
      await castList(A, [[23]]);
      const after = await view(A);
      log('请神后', after.gods.filter((x) => x.where.t !== 'road'));
      const d2 = await decisionFull(A);
      if (d2.options.cards.find((r) => r.card === 22 && r.usable)) {
        await castList(A, [[22]]);
        return;
      }
      log('送神符仍不可用', d2.options.cards.filter((r) => r.card === 22));
      // 送神符还在手里：换下一只坏神再试（请神符用掉了就再拿一张）
      await giveCards(aSeat, [23]);
      break;
    }
  }
}

try {
  await setupRoom();
  for (const p of [A, B]) await installCastLog(p);
  const v0 = await view(A);
  const aSeat = await A.evaluate(() => window.__rich4.store.room.getState().room?.you?.seat ?? null);
  const bSeat = await B.evaluate(() => window.__rich4.store.room.getState().room?.you?.seat ?? null);
  const aiSeat = v0.players.find((p) => p.controller === 'ai').seat;
  seats = { P1: aSeat, P2: bSeat, ai: aiSeat };
  result.seats = seats;
  result.names = Object.fromEntries(v0.players.map((p) => [actorName(p.seat), p.name]));
  log('座位', seats, result.names);
  if (MODE === 'god') {
    await godFlow();
    await settle(A, { quietMs: 1500, timeout: 20_000 }).catch(() => {});
  } else {

  // ── 0) 经济与站位：全体掷 1 点；真人现金抬高、电脑压低；电脑拿均贫 + 查税（它的回合会对有钱人出卡） ──
  phase = 'setup';
  await waitTurnMenu(A);
  await debug(A, { op: 'forceNext', purpose: 'dice', values: Array(64).fill(1) });
  await debug(A, { op: 'setCash', seat: aSeat, cash: 500000, deposit: null });
  await debug(A, { op: 'setCash', seat: bSeat, cash: 500000, deposit: null });
  await debug(A, { op: 'setCash', seat: aiSeat, cash: 1000, deposit: null });
  log('电脑拿到', await giveCards(aiSeat, [2, 26]));
  await teleport(aiSeat, 44, 43);

  // ── 1) 卡片欄悬停：P1 拿 1–15（桌面，再换 844×390），P2 拿 16–30（手机，再换 1920×1080） ──
  phase = 'hover';
  const p1Cards = Array.from({ length: 15 }, (_, i) => i + 1);
  const p2Cards = Array.from({ length: 15 }, (_, i) => i + 16);
  for (const c of p1Cards) keepCards.P1.add(c);
  for (const c of p2Cards) keepCards.P2.add(c);
  log('P1 拿到', await giveCards(aSeat, p1Cards));
  await waitCardsInMenu(A, p1Cards);
  await hoverShots(A, p1Cards, 'desk');
  await setVp(A, MOBILE);
  await hoverShots(A, p1Cards, 'mobile');
  await setVp(A, DESK);
  log('P1 放大回桌面后棋盘画布', await boardCanvasFit(A));
  // P1 从 43 号格走 1 步到 L6（不买）
  await teleport(aSeat, 43, 5);
  await waitTurnMenu(A);
  await act(A, { type: 'ROLL' });

  phase = 'hover';
  await waitTurnMenu(B);
  log('P2 拿到', await giveCards(bSeat, p2Cards));
  await waitCardsInMenu(B, p2Cards);
  await hoverShots(B, p2Cards, 'mobile');
  await setVp(B, DESK);
  await hoverShots(B, p2Cards, 'desk');
  await setVp(B, MOBILE);
  log('P2 缩回手机后棋盘画布', await boardCanvasFit(B));
  save();

  // ── 2)+3) 买地（P2 从 39 号格起步，两回合买下 L2、L3）；其间电脑的回合会出卡 ──
  phase = 'buy';
  buyPages.add('P2');
  await teleport(bSeat, 39, 6);
  await waitTurnMenu(B);
  await act(B, { type: 'ROLL' });
  const owned = async () => {
    const v = await view(A);
    const own = (id) => v.lands.find((l) => l.id === id)?.owner;
    return own('L2') === bSeat && own('L3') === bSeat;
  };
  let rounds = 0;
  while (!(await owned()) && rounds < 4) {
    await waitTurnMenu(A);
    rounds++;
    log('买地回合', rounds, (await view(A)).lands.slice(0, 4));
    // P1 继续在 S02 上走 1 步；P2 下一回合 40 → 41
    await act(A, { type: 'ROLL' });
    await waitTurnMenu(B);
    await act(B, { type: 'ROLL' });
  }
  buyPages.delete('P2');
  log('买地结束', (await view(A)).lands.slice(0, 4));
  save();

  const players = async (tag) => log(`${tag} 玩家`, (await view(A)).players.map((p) => ({ s: p.seat, node: p.node, placed: p.placed, st: Object.fromEntries(Object.entries(p.st ?? {}).filter(([, v]) => v)), cards: p.cards })));

  // ── 4) P1 出卡：站在 L2（40 号格），P2 在 41、电脑在 42；转向 / 停留对 P2，抢夺抢 P2 的免费卡 ──
  phase = 'p1cast';
  await waitTurnMenu(A);
  await teleport(aSeat, 40, 39);
  await teleport(bSeat, 41, 40);
  await teleport(aiSeat, 42, 41);
  await refreshMenu(aSeat);
  await players('P1 出卡前');
  const robFree = (row) => {
    const v = row?.targets?.victims?.find((x) => x.seat === bSeat);
    const c = v?.cards.find((x) => x.card === 20) ?? v?.cards.find((x) => ![16, 17, 18, 21].includes(x.card));
    return [`target-rob-${bSeat}`, `target-rob-card-${c?.slot ?? 0}`];
  };
  await castList(A, [
    [1],
    [2, `target-seat-${bSeat}`],
    [6, `target-actor-seat-${bSeat}`],
    [14, `target-actor-seat-${bSeat}`],
    [13, robFree],
    [9, 'target-lot-L2'],
    [7],
    [12, 'target-lot-L3'],
    [11, 'target-lot-L2'],
    [3],
    [5, 'target-pair-L3'],
    [4, 'target-pair-L3'],
    [8],
    [10, 'target-lot-L1'],
  ]);
  log('P1 出卡后地产', (await view(A)).lands.slice(0, 4));
  // P1 拿免罪、复仇（P2 出陷害、梦游时生效），最后出冬眠卡（P2、电脑冬眠 5 回合，之后才轮到 P2 出卡）
  keepCards.P1.add(21);
  keepCards.P1.add(18);
  log('P1 拿到（免罪 / 复仇）', await giveCards(aSeat, [21, 18]));
  await castList(A, [[15]]);
  await waitTurnMenu(A);
  await act(A, { type: 'ROLL' });

  // ── 5) P2 出卡：请神符（范围内没有路上神明时传过去）、送神符，再回 41 号格出其余的卡 ──
  phase = 'p2cast';
  await waitTurnMenu(B, 420_000);
  await players('P2 出卡前');
  let d = await decisionFull(B);
  if (!d.options.cards.find((r) => r.card === 23 && r.usable)) {
    const v = await view(A);
    const gods = v.gods.filter((g) => g.where.t === 'road' && ![11, 15].includes(g.kind));
    log('路上神明', gods);
    for (const g of gods) {
      const nb = neighborTiles(g.where.node)[0];
      if (nb === undefined) continue;
      await teleport(bSeat, nb);
      await refreshMenu(bSeat);
      await waitTurnMenu(B);
      d = await decisionFull(B);
      if (d.options.cards.find((r) => r.card === 23 && r.usable)) {
        log('P2 传到神明附近', { god: g, node: nb });
        break;
      }
    }
  }
  await castList(B, [[23], [22]]);
  await waitTurnMenu(B);
  await teleport(bSeat, 41, 40);
  await teleport(aSeat, 40, 39);
  await teleport(aiSeat, 42, 41);
  await refreshMenu(bSeat);
  await players('P2 出卡（回 41）');
  await castList(B, [
    [24, 'target-stock-0'],
    [25, 'target-stock-1'],
    [27, 'target-lot-L3'],
    [28, 'target-lot-L2'],
    [29, `target-seat-${aSeat}`],
    [30, `target-actor-seat-${aSeat}`],
    [22],
    [26, `target-seat-${aiSeat}`],
    [17, `target-actor-seat-${aSeat}`], // P1 持免罪 → 被动卡生效
    [16, `target-actor-seat-${aSeat}`], // P1 持复仇 → 被动卡生效，出卡人 P2 也梦游
  ]);

  // ── 6) 电脑用卡：电脑回到身边，发给它均贫 / 查税 / 抢夺，现金压低、真人抬高；等它自己出两张以上 ──
  phase = 'ai';
  await waitTurnMenu(B);
  await teleport(aiSeat, 42, 41);
  await debug(A, { op: 'setCash', seat: aiSeat, cash: 1000, deposit: null });
  await debug(A, { op: 'setCash', seat: aSeat, cash: 600000, deposit: null });
  await debug(A, { op: 'setCash', seat: bSeat, cash: 600000, deposit: null });
  log('电脑拿到', await giveCards(aiSeat, [2, 26, 13, 1]));
  await players('电脑出卡前');
  await act(B, { type: 'ROLL' });
  const aiCasts = () => result.casts.filter((c) => c.actor === 'AI' && c.page === 'P1').length;
  const before = aiCasts();
  await pump(async () => aiCasts() - before >= 2 && !(await currentCast(A)) && !(await currentCast(B)), {
    timeout: 300_000,
  });
  await settle(A, { quietMs: 1500, timeout: 60_000 }).catch(() => {});
  log('电脑出卡', result.casts.filter((c) => c.actor === 'AI').map((c) => `${c.page}:${c.card}/${c.variant}`));
  await players('收尾');
  save();
  }
} catch (e) {
  log(`ERROR ${e.stack ?? e}`);
  process.exitCode = 1;
}

// ── 7) 注入：始终没在两页都真出现过的卡（出卡弹窗 spec 同真实 handler），另注入一例「没有效果」 ──
try {
  if (MODE !== 'all') throw new Error('skip');
  phase = 'inject';
  const realOn = (page, k) =>
    result.casts.some((c) => c.page === page && c.card === k && c.probe && c.probe.bgKey === `card.${k}`);
  for (let k = 1; k <= 30; k++) {
    for (const page of [A, B]) {
      if (realOn(whoOf(page), k)) continue;
      const passive = k >= 18 && k <= 21;
      const rec = await injectCast(page, k, passive ? 'passive' : 'cast', {
        seat: seats?.P1 ?? 0,
        character: 2,
        name: result.names?.P1 ?? '測試甲',
        cardName: NAMES[k],
        target: result.names?.P2 ?? '測試乙',
      });
      result.inject.push(rec);
    }
  }
  for (const page of [A, B]) {
    result.inject.push(
      await injectCast(page, 16, 'fizzle', {
        seat: seats?.P2 ?? 0,
        character: 9,
        name: result.names?.P2 ?? '測試乙',
        cardName: '夢遊卡',
        target: null,
      }),
    );
  }
  log(
    '注入',
    result.inject.map((r) => `${r.page}:${r.card}/${r.variant}=${r.probe?.bgKey}`),
  );
  // ── 8) 素材本身：30 张插画的透明像素与尺寸 ──
  result.alpha = await alphaCheck(A);
  log(
    '透明像素',
    Object.entries(result.alpha)
      .filter(([, a]) => a.transparent || a.partial || a.w !== 165 || a.h !== 256)
      .map(([k, a]) => ({ k, ...a })),
  );
} catch (e) {
  if (String(e?.message) !== 'skip') {
    log(`ERROR(inject) ${e.stack ?? e}`);
    process.exitCode = 1;
  }
} finally {
  save();
  await browser.close();
}
