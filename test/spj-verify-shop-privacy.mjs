// 验证（道具店按原版 + 联机隐藏对手手牌）：真实素材包、原版皮肤、台湾图，两名真人（P1 房主、P2）+ 1 电脑 + 1 观战者。
// 桌面 1920×1080 与手机横屏 844×390 各跑一遍：
//   1. 开局锁定私密（room.settings.handVisibility === 'private'）；
//   2. 给 P1 发卡与道具；P2 与观战者看 P1：座位条、资料栏「其他」页、资产屏（工具列「查询」，含资产屏里左右切换玩家）——
//      只有张数与总数，没有卡片格与道具格；P1 看自己的资产屏看得到；
//   3. P1 进百货（传送到 35 号格、来向 36、强制掷 1 → 15 号百货）：道具页没有库存、没有数量钮；改过的客户端发 qty 2 被拒；
//      买 1 个后这一行变灰、再买被拒；下发给 P1 的 SHOP 选项里共享库存只有 0 / 1（私密模式不下发真实库存）；
//      P1 在店里时截 P2 与观战者的画面（看不到货架）；
//   4. 轮到 P2：传送到 P1 所在格，P2 的回合菜单：查税卡（选人）目标面板只列玩家名；抢夺卡目标面板列出 P1 的手牌
//      （按原版只给出卡人，设计如此）；P2 抢 P1 一件道具后，观战者的日志里看不到被抢道具的种类；
//   5. 抓 P2 与观战者收到的全部 socket.io 帧，用 shared 的 findHandLeaks 深度扫描；另外按名字扫描两人的页面文字。
// 先起本机服务（本机例外：未设门禁的素材包、只监听回环；端口 4031 / 6031）：
//   PORT=4031 HOST=127.0.0.1 PUBLIC_URL=http://localhost:6031 TRUST_PROXY=0 RICH4_ASSETS_ALLOW_UNGATED=1 \
//   RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_TEST_MODE=1 DATA_DIR=.cache/spj/verify/data \
//   npx tsx apps/server/src/main.ts
//   （apps/client）npx vite build --outDir ../../.cache/spj/verify/dist --emptyOutDir && \
//     RICH4_API_TARGET=http://127.0.0.1:4031 npx vite preview --outDir ../../.cache/spj/verify/dist --port 6031 --strictPort
// 用法：npx tsx test/spj-verify-shop-privacy.mjs [desktop|mobile|both=both]
// 截图与记录写到 .cache/spj/verify/（VERIFY_OUT 可改；含原版素材，不入库）；VERIFY_BASE 改客户端地址；有断言失败时退出码 1。
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { findHandLeaks } from '../packages/shared/src/view/handLeaks.ts';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:6031';
const which = process.argv[2] ?? 'both';
const OUT = process.env.VERIFY_OUT ?? '.cache/spj/verify';
mkdirSync(OUT, { recursive: true });
const Q = 'audio=off&test=1&anim=instant';
const LOG = [];
const report = { runs: [], problems: [] };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};
let prefix = '';
const check = (ok, what) => {
  log(`${ok ? 'OK  ' : 'FAIL'} [${prefix}] ${what}`);
  if (!ok) report.problems.push(`[${prefix}] ${what}`);
};

const VIEWPORTS = {
  desktop: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const P1_CARDS = [18, 1, 29]; // 复仇、均富、同盟
const P1_ITEMS = [
  { item: 8, qty: 3 }, // 遥控骰子
  { item: 10, qty: 1 }, // 时光机
];
const P2_CARDS = [13, 26]; // 抢夺、查税
const P2_ITEMS = [{ item: 2, qty: 1 }]; // 路障

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function newActor(vp, nickname, tag) {
  const ctx = await browser.newContext(VIEWPORTS[vp]);
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('rich4.introSeen', '1');
    } catch {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebGL|favicon/.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  const frames = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      const text = typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8');
      const m = /^4([23])\d*(\[.*)$/s.exec(text);
      if (!m) return;
      try {
        const arr = JSON.parse(m[2]);
        frames.push(m[1] === '2' ? { event: String(arr[0]), payload: arr[1] } : { event: 'ack', payload: arr[0] });
      } catch {}
    });
  });
  await page.goto(`${BASE}/?${Q}`);
  await page.getByTestId('home-nickname').fill(nickname);
  await page.getByTestId('home-nickname').blur();
  return { ctx, page, errors, frames, tag, nickname };
}

const idle = (page, timeout = 90_000) =>
  page.waitForFunction(
    () => {
      const h = window.__rich4;
      return !!h?.store?.game && h.store.game.getState().view !== null && h.eventPlayer.idle;
    },
    undefined,
    { timeout },
  );

async function st(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const d = g?.decision;
    return {
      seq: g?.seq ?? 0,
      idle: h?.eventPlayer?.idle ?? false,
      decision: d ? { kind: d.kind, id: d.decisionId } : null,
      submitting: g?.submitting ?? null,
    };
  });
}

async function debug(page, op, others = []) {
  const s0 = (await st(page)).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  for (const p of [page, ...others]) {
    await p.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
  }
}

async function act(page, intent = null) {
  return page.evaluate(async (it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    if (!d) return null;
    const r = await h.client.act(it ?? d.defaultIntent, d.decisionId);
    return r.ok ? { ok: true } : { ok: false, code: r.error.code, rule: r.error.details?.rule ?? null };
  }, intent);
}

/** 两名真人的决策都按默认应答，直到 who 出现 want 里的决策 */
async function drive(humans, who, want, timeout = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    for (const h of humans) {
      const s = await st(h.page);
      if (!s.idle || !s.decision || s.submitting !== null) continue;
      if (h === who && want.includes(s.decision.kind)) return s;
      log(`  ${h.tag} 默认应答 ${s.decision.kind}`);
      await act(h.page);
    }
    await who.page.waitForTimeout(200);
  }
  throw new Error(`drive ${who.tag} ${want} timeout ${JSON.stringify(await st(who.page))}`);
}

/** 工具列按钮：窄屏收进「更多」时从菜单里点 */
async function tool(page, id) {
  const direct = page.locator(`[data-testid="classic-toolbar"] [data-testid="${id}"]:visible`).first();
  if ((await direct.count()) > 0) return direct.click();
  await page.getByTestId('tool-more').click();
  await page.getByTestId('tool-more-menu').getByTestId(id).click();
}

/** 选中查看对象：左栏座位条可见时点它，否则先拉开左侧抽屉（手机横屏） */
async function inspect(page, seat) {
  // 点座位条是切换：已经选中时再点会取消选中
  if ((await page.evaluate(() => window.__rich4.store.ui.getState().inspectSeat)) === seat) return;
  const chip = page.getByTestId(`chip-${seat}`);
  if (!(await chip.isVisible().catch(() => false))) {
    await page.getByTestId('classic-drawer-left-btn').click();
    await chip.waitFor({ state: 'visible', timeout: 10_000 });
  }
  await chip.click();
  const close = page.getByTestId('classic-drawer-left-close');
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function shot(a, name, wait = 500) {
  if (wait) await a.page.waitForTimeout(wait);
  const file = `${OUT}/${prefix}-${a.tag}-${name}.png`;
  await a.page.screenshot({ path: file });
  log(`shot ${file}`);
  return file;
}

async function seatOf(page) {
  return page.evaluate(() => window.__rich4.store.room.getState().room.you.seat ?? null);
}

async function playerSeen(page, seat) {
  return page.evaluate((s) => {
    const v = window.__rich4.store.game.getState().view;
    const p = v.players.find((x) => x.seat === s);
    return { cards: p.cards, items: p.items, cardCount: p.cardCount, itemCount: p.itemCount, poolsNull: v.pools === null };
  }, seat);
}

/** 资产屏：打开、断言、截图；返回 DOM 里的卡片格 / 道具格 */
async function assetSheet(a, seat, name, expectHidden) {
  await inspect(a.page, seat);
  await tool(a.page, 'action-info');
  const sheet = a.page.getByTestId('classic-assets');
  await sheet.waitFor({ state: 'visible', timeout: 15_000 });
  await a.page.waitForTimeout(600);
  const dom = await a.page.evaluate(() => {
    const root = document.querySelector('[data-testid="classic-assets"]');
    return {
      seat: root?.getAttribute('data-seat'),
      cards: [...root.querySelectorAll('[data-testid^="assets-card-"]')].map((e) => e.textContent),
      items: [...root.querySelectorAll('[data-testid^="assets-item-"]')].map(
        (e) => `${e.getAttribute('data-testid')}×${e.getAttribute('data-count')}`,
      ),
      itemNames: [...root.querySelectorAll('[data-testid^="assets-item-"]')].map((e) => e.getAttribute('title')),
      cardCount: root.querySelector('[data-testid="assets-cards"]')?.getAttribute('data-value'),
      itemCount: root.querySelector('[data-testid="assets-items"]')?.getAttribute('data-value'),
    };
  });
  const file = await shot(a, name, 200);
  if (expectHidden) {
    check(
      dom.seat === String(seat) && dom.cards.length === 0 && dom.items.length === 0,
      `${a.tag} 看座位 ${seat} 的资产屏没有卡片格与道具格（卡 ${dom.cardCount} / 道具 ${dom.itemCount}）${JSON.stringify(dom)}`,
    );
  } else {
    check(dom.cards.length > 0 && dom.items.length > 0, `${a.tag} 看自己的资产屏有卡片格与道具格 ${JSON.stringify(dom)}`);
  }
  return { dom, file };
}

async function closeSheet(page) {
  await page.keyboard.press('Escape');
  await page.getByTestId('classic-assets').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
}

/** 资产屏里用左右箭头切到每个座位，记录可见的卡片格 / 道具格 */
async function cycleSheet(a, seats, own) {
  const seen = {};
  for (let i = 0; i < seats.length + 1; i++) {
    const dom = await a.page.evaluate(() => {
      const root = document.querySelector('[data-testid="classic-assets"]');
      return {
        seat: Number(root?.getAttribute('data-seat')),
        cards: root.querySelectorAll('[data-testid^="assets-card-"]').length,
        items: root.querySelectorAll('[data-testid^="assets-item-"]').length,
      };
    });
    seen[dom.seat] = dom;
    const next = a.page.getByTestId('assets-next');
    if ((await next.count()) === 0) break;
    await next.click();
    await a.page.waitForTimeout(250);
  }
  const bad = Object.values(seen).filter((x) => x.seat !== own && (x.cards > 0 || x.items > 0));
  check(
    Object.keys(seen).length >= 2 && bad.length === 0,
    `${a.tag} 资产屏左右切换：别人的卡片格 / 道具格都不画 ${JSON.stringify(seen)}`,
  );
}

/** 页面文字里不应出现的名字（P1 独有的卡名、道具名） */
async function textScan(a, names, where) {
  const text = await a.page.evaluate(() => document.body.innerText);
  const hit = names.filter((n) => text.includes(n));
  check(hit.length === 0, `${a.tag} ${where}页面文字里没有 P1 手牌的名字（命中 ${JSON.stringify(hit)}）`);
}

async function run(vp) {
  prefix = vp;
  const rec = { vp, steps: {} };
  report.runs.push(rec);
  const p1 = await newActor(vp, 'P1甲', 'p1');
  const p2 = await newActor(vp, 'P2乙', 'p2');
  let w = null;
  const humans = [p1, p2];
  try {
    // ── 建房、进房、观战、开局
    await p1.page.getByTestId('home-create').click();
    await p1.page.getByTestId('set-timer').waitFor();
    await p1.page.waitForFunction(() =>
      [...document.querySelectorAll('[data-testid="set-map"] option')].some((o) => o.value === 'taiwan'),
    );
    await p1.page.getByTestId('set-map').selectOption('taiwan');
    await p1.page.getByTestId('set-timer').selectOption('off');
    await p1.page.getByTestId('set-ai-count').selectOption('1');
    await p1.page.getByTestId('create-submit').click();
    await p1.page.waitForURL(/\/r\/\d{6}/);
    const code = /\/r\/(\d{6})/.exec(p1.page.url())[1];
    log(`[${vp}] room ${code}`);
    for (const [a, ch] of [
      [p1, 9],
      [p2, 3],
    ]) {
      if (a === p2) await p2.page.goto(`${BASE}/r/${code}?${Q}`);
      await a.page.getByTestId('screen-room').waitFor();
      await a.page.getByTestId(`char-${ch}`).click();
      await a.page.waitForTimeout(300);
      const txt = await a.page.getByTestId('char-select').textContent();
      if (!/^已(选择|選擇)$/.test(txt ?? '')) await a.page.getByTestId('char-select').click();
    }
    await p2.page.getByTestId('room-ready').click();
    w = await newActor(vp, '觀眾丙', 'w');
    await w.page.goto(`${BASE}/r/${code}?${Q}&watch=1`);
    await w.page.getByTestId('screen-room').waitFor();
    await p1.page.waitForFunction(() => !document.querySelector('[data-testid="room-start"]')?.disabled);
    await p1.page.getByTestId('room-start').click();
    for (const a of [p1, p2, w]) {
      await a.page.getByTestId('screen-game').waitFor({ timeout: 90_000 });
      await idle(a.page);
    }
    await p1.page
      .waitForFunction(() => window.__rich4?.skin?.boardInUse === 'original', undefined, { timeout: 30_000 })
      .catch(() => {});
    rec.skin = await p1.page.evaluate(() => window.__rich4.skin);
    check(rec.skin?.boardInUse === 'original' && rec.skin?.applied === 'original', `原版皮肤 ${JSON.stringify(rec.skin)}`);
    const hv = [];
    for (const a of [p1, p2, w]) hv.push(await a.page.evaluate(() => window.__rich4.store.room.getState().room.settings.handVisibility));
    check(hv.every((x) => x === 'private'), `开局锁定私密手牌 ${JSON.stringify(hv)}`);
    const s1 = await seatOf(p1.page);
    const s2 = await seatOf(p2.page);
    const sw = await seatOf(w.page);
    rec.seats = { s1, s2, sw };
    log(`[${vp}] seats P1=${s1} P2=${s2} W=${sw}`);
    await debug(p1.page, { op: 'clearBoard' }, [p2.page, w.page]);

    // ── 发卡与道具
    await debug(p1.page, { op: 'give', seat: s1, cards: P1_CARDS, items: P1_ITEMS }, [p2.page, w.page]);
    await debug(p1.page, { op: 'give', seat: s2, cards: P2_CARDS, items: P2_ITEMS }, [p2.page, w.page]);
    for (const a of [p1, p2, w]) await idle(a.page);
    const own1 = await playerSeen(p1.page, s1);
    const own2 = await playerSeen(p2.page, s2);
    rec.steps.own1 = own1;
    const p2sees = await playerSeen(p2.page, s1);
    const wsees = await playerSeen(w.page, s1);
    const p1sees2 = await playerSeen(p1.page, s2);
    rec.steps.seen = { p2sees, wsees, p1sees2 };
    check(own1.cards?.length === 3 && own1.items !== null, `P1 看自己：卡 ${JSON.stringify(own1.cards)}`);
    for (const [who, x, c, n] of [
      ['p2→P1', p2sees, 3, own1.itemCount],
      ['w→P1', wsees, 3, own1.itemCount],
      ['p1→P2', p1sees2, own2.cardCount, own2.itemCount],
    ]) {
      check(
        x.cards === null && x.items === null && x.cardCount === c && x.itemCount === n && x.poolsNull,
        `${who} 只拿到张数与总数、牌堆为 null ${JSON.stringify(x)}`,
      );
    }

    // P1 独有的卡名、道具名（从 P1 自己的资产屏读出来；排除 P2 手上也有的）
    const p1Own = await assetSheet(p1, s1, '01-own-assets', false);
    await closeSheet(p1.page);
    const p2Own = await assetSheet(p2, s2, '01-own-assets', false);
    await closeSheet(p2.page);
    const p2OwnNames = new Set([...p2Own.dom.cards, ...p2Own.dom.itemNames]);
    const exclusive = [...p1Own.dom.cards, ...p1Own.dom.itemNames].filter((n) => n && !p2OwnNames.has(n));
    rec.steps.exclusiveNames = exclusive;
    log(`[${vp}] P1 独有的卡名、道具名 ${JSON.stringify(exclusive)}`);

    // ── P2、观战者看 P1：座位条、资料栏「其他」页、资产屏
    for (const a of [p2, w]) {
      // 手机横屏：座位条在左侧抽屉里，先拉开抽屉截一张
      if (!(await a.page.getByTestId(`chip-${s1}`).isVisible().catch(() => false))) {
        await a.page.getByTestId('classic-drawer-left-btn').click();
        await a.page.getByTestId(`chip-${s1}`).waitFor({ state: 'visible', timeout: 10_000 });
        await a.page.getByTestId('player-chips').scrollIntoViewIfNeeded();
        await shot(a, '02a-seat-drawer');
        await a.page.getByTestId('classic-drawer-left-close').click();
        await a.page.waitForTimeout(400);
      }
      await inspect(a.page, s1);
      await a.page.waitForTimeout(300);
      const chipText = await a.page.evaluate(
        (s) => document.querySelector(`[data-testid="chip-${s}"]`)?.innerText ?? null,
        s1,
      );
      rec.steps[`${a.tag}ChipText`] = chipText;
      check(!exclusive.some((n) => chipText?.includes(n)), `${a.tag} 座位条 P1 只有现金 / 存款 / 点券：${JSON.stringify(chipText)}`);
      await shot(a, '02-seatbar-profile');
      const other = a.page.getByTestId('classic-tab-other');
      if (await other.isVisible().catch(() => false)) {
        await other.click();
        await a.page.waitForTimeout(300);
        const inv = await a.page
          .getByTestId('classic-val-other-inventory')
          .getAttribute('data-value')
          .catch(() => null);
        check(inv === `3/${own1.itemCount}`, `${a.tag} 资料栏「其他」页 P1 卡片 / 道具 = ${inv}（应为 3/${own1.itemCount}）`);
        await shot(a, '03-profile-other');
      } else {
        log(`[${vp}] ${a.tag} 资料栏在此布局不可见（跳过「其他」页）`);
      }
      await assetSheet(a, s1, '04-views-p1-assets', true);
      await cycleSheet(a, [s1, s2], a === w ? null : s2);
      await closeSheet(a.page);
      await textScan(a, exclusive, '查看后');
    }

    // ── P1 的回合：百货公司道具店
    await drive(humans, p1, ['TURN_MENU']);
    // P1 自己的回合菜单：卡片欄照常列出
    await p1.page.getByTestId('action-cards').click();
    await p1.page.getByTestId('inv-card-0').waitFor({ state: 'attached', timeout: 15_000 });
    await shot(p1, '05-own-turnmenu-cards');
    await p1.page.keyboard.press('Escape');
    await p1.page.waitForTimeout(600);
    await debug(p1.page, { op: 'setPoints', seat: s1, points: 500 }, [p2.page, w.page]);
    await debug(p1.page, { op: 'teleport', seat: s1, node: 35, prev: 36 }, [p2.page, w.page]);
    await debug(p1.page, { op: 'forceNext', purpose: 'dice', values: [1] });
    await drive(humans, p1, ['TURN_MENU']);
    await p1.page.waitForFunction(() => document.querySelectorAll('[data-scene][data-testid$="-exit"]').length === 0);
    await p1.page.getByTestId('action-roll').click();
    await drive(humans, p1, ['SHOP']);
    const scene = p1.page.getByTestId('decision-SHOP');
    await scene.waitFor();
    check((await scene.getAttribute('data-scene')) === 'classic', '百货是原版场景');
    const shopInfo = () =>
      p1.page.evaluate(() => {
        const h = window.__rich4;
        const d = h.store.game.getState().decision;
        const root = document.querySelector('[data-testid="decision-SHOP"]');
        return {
          decisionId: d?.decisionId ?? null,
          points: d?.options?.points ?? null,
          items: d?.options?.items ?? null,
          trades: d?.options?.visit?.trades ?? null,
          text: root?.textContent ?? '',
          rows: [...document.querySelectorAll('[data-testid^="shop-item-"]')].map((e) => ({
            id: e.getAttribute('data-testid'),
            disabled: e.hasAttribute('disabled') || e.getAttribute('aria-disabled') === 'true',
          })),
          qty: document.querySelectorAll(
            '[data-testid="shop-qty"],[data-testid="shop-qty-inc"],[data-testid="shop-qty-dec"],[data-testid="decision-SHOP"] input[type="number"]',
          ).length,
        };
      });
    await shot(p1, '06-shop-card-page', 1000);
    // 别人此时看不到货架（SHOP_OPENED.shelf 只给进店的人）
    for (const a of [p2, w]) {
      const shelf = await a.page.evaluate(() => document.querySelectorAll('[data-testid="decision-SHOP"]').length);
      check(shelf === 0, `${a.tag} 画面上没有 P1 的百货场景`);
      await shot(a, '07-while-p1-shopping');
    }
    await scene.getByTestId('shop-page-item').click();
    await p1.page.waitForTimeout(400);
    let info = await shopInfo();
    rec.steps.shopItems = info.items;
    check(!/庫存|库存/.test(info.text), '道具页没有库存字样');
    // 货架行只写名称与价格：P1 持有 3 颗遥控骰子，货架上也不能出现持有数「×3」（原版货架不画数量）
    const shelfText = await scene.getByTestId('shop-shelf').innerText();
    check(!shelfText.includes('×'), `道具货架没有持有数「×n」：${JSON.stringify(shelfText.slice(0, 160))}`);
    check(
      info.items.every((r) => r.pool === 0 || r.pool === 1),
      `下发给 P1 的共享库存只有 0 / 1：${JSON.stringify(info.items.map((r) => [r.item, r.pool]))}`,
    );
    await shot(p1, '08-shop-item-page');
    await scene.getByTestId('shop-item-8').click();
    await p1.page.waitForTimeout(300);
    info = await shopInfo();
    check(info.qty === 0, `选遥控骰子后没有数量控件（${info.qty}）`);
    await shot(p1, '09-shop-remote-dice-selected');
    const hack1 = await act(p1.page, { type: 'SHOP_BUY_ITEM', item: 8, qty: 2 });
    check(hack1?.ok === false && hack1.rule === 'OUT_OF_RANGE', `改过的客户端 qty 2 被拒绝 ${JSON.stringify(hack1)}`);
    await p1.page.waitForTimeout(500);
    const before = await shopInfo();
    await scene.getByTestId('shop-buy-item').click();
    await p1.page.waitForFunction(
      (id) => {
        const g = window.__rich4.store.game.getState();
        return g.decision?.kind === 'SHOP' && g.decision.decisionId !== id && g.submitting === null;
      },
      before.decisionId,
      { timeout: 30_000 },
    );
    await p1.page.waitForTimeout(400);
    info = await shopInfo();
    rec.steps.afterBuy = { trades: info.trades, rows: info.rows };
    check(
      JSON.stringify(info.trades) === JSON.stringify([{ op: 'buyItem', card: null, item: 8, qty: 1, points: 30 }]),
      `交易记录只有 qty 1：${JSON.stringify(info.trades)}`,
    );
    check(info.points === 470, `点券 500 → ${info.points}`);
    check(info.rows.find((r) => r.id === 'shop-item-8')?.disabled === true, '买后遥控骰子这一行禁用');
    await shot(p1, '10-shop-after-buy');
    const hack2 = await act(p1.page, { type: 'SHOP_BUY_ITEM', item: 8, qty: 1 });
    check(hack2?.ok === false && hack2.rule === 'NOT_ALLOWED', `再买一次被拒绝 ${JSON.stringify(hack2)}`);
    await p1.page.waitForTimeout(500);
    await scene.getByTestId('shop-leave').click();
    await p1.page.waitForTimeout(800);
    for (const a of [p2, w]) await textScan(a, exclusive, 'P1 购物后');

    // ── P2 的回合：选目标
    await drive(humans, p2, ['TURN_MENU']);
    const p1node = await p2.page.evaluate((s) => window.__rich4.store.game.getState().view.players.find((p) => p.seat === s).node, s1);
    await debug(p2.page, { op: 'teleport', seat: s2, node: p1node }, [p1.page, w.page]);
    await debug(p2.page, { op: 'give', seat: s2, cards: [], items: [{ item: 2, qty: 1 }] }, [p1.page, w.page]);
    await drive(humans, p2, ['TURN_MENU']);
    for (const a of [p1, p2, w]) await idle(a.page);
    const slotOf = (card) =>
      p2.page.evaluate((c) => {
        const d = window.__rich4.store.game.getState().decision;
        const row = d?.kind === 'TURN_MENU' ? d.options.cards.find((r) => r.card === c) : null;
        return row ? { slot: row.slot, usable: row.usable } : null;
      }, card);
    const tax = await slotOf(26);
    const rob = await slotOf(13);
    rec.steps.p2Menu = { tax, rob, p1node };
    await p2.page.waitForFunction(() => document.querySelectorAll('[data-scene][data-testid$="-exit"]').length === 0);
    // 查税卡：选人，面板里只有玩家名与所在格
    if (tax?.usable) {
      await p2.page.getByTestId('action-cards').click();
      await p2.page.getByTestId(`inv-card-${tax.slot}`).click();
      const picker = p2.page.getByTestId('target-picker');
      await picker.waitFor({ state: 'visible', timeout: 15_000 });
      const txt = await picker.innerText();
      check(!exclusive.some((n) => txt.includes(n)), `P2 查税卡目标面板没有 P1 手牌：${JSON.stringify(txt.slice(0, 200))}`);
      await shot(p2, '11-target-tax-seat');
      await p2.page.getByTestId('target-cancel').click();
      await p2.page.waitForTimeout(800);
      await p2.page.keyboard.press('Escape');
      await p2.page.waitForTimeout(800);
    } else check(false, `P2 查税卡不可用 ${JSON.stringify(tax)}`);
    // 抢夺卡：原版出卡人先看到对方的卡片与道具（设计如此，只发给出卡人本人）
    if (rob?.usable) {
      await p2.page.waitForFunction(() => document.querySelectorAll('[data-scene][data-testid$="-exit"]').length === 0);
      await p2.page.getByTestId('action-cards').click();
      await p2.page.getByTestId(`inv-card-${rob.slot}`).click();
      const picker = p2.page.getByTestId('target-picker');
      await picker.waitFor({ state: 'visible', timeout: 15_000 });
      await picker.getByTestId(`target-rob-${s1}`).click();
      await p2.page.waitForTimeout(400);
      const robItems = await picker.locator('[data-testid^="target-rob-item-"]').count();
      rec.steps.robPicker = { robItems };
      log(`[${vp}] P2 抢夺卡目标面板列出 P1 的道具 ${robItems} 种（原版如此：只给出卡人）`);
      await shot(p2, '12-target-rob-p1-hand-by-design');
      await picker.getByTestId('target-rob-item-8').click();
      await p2.page.getByTestId('target-confirm').click();
      await drive(humans, p2, ['TURN_MENU']);
      for (const a of [p1, p2, w]) await idle(a.page);
      // 观战者的日志：看不到被抢道具的种类
      const openLog = async (a) => {
        const btn = a.page.getByTestId('top-log');
        if (!(await btn.isVisible().catch(() => false))) {
          const d = a.page.getByTestId('classic-drawer-right-btn');
          if (await d.isVisible().catch(() => false)) await d.click();
        }
        if (await btn.isVisible().catch(() => false)) await btn.click();
        await a.page.waitForTimeout(500);
      };
      await openLog(w);
      await shot(w, '13-log-after-rob');
      const wText = await w.page.evaluate(() => document.body.innerText);
      rec.steps.wLogHasRemoteDice = wText.includes('遙控骰子');
      check(!wText.includes('遙控骰子'), '观战者页面没有被抢道具的名字（遙控骰子）');
      await openLog(p1);
      await shot(p1, '14-log-after-rob-victim');
      // 被抢人 P1 对出卡人 P2 的敌意 += 遥控骰子标价：P1 看自己完整，P2 只看到对自己的一项，观战者全为 0
      const hateOf = (a) =>
        a.page.evaluate((s) => window.__rich4.store.game.getState().view.players.find((p) => p.seat === s).hostility, s1);
      const [h1, h2, hw] = [await hateOf(p1), await hateOf(p2), await hateOf(w)];
      rec.steps.hostilityAfterRob = { p1: h1, p2: h2, w: hw };
      check(h1[s2] > 0, `P1 看自己对 P2 的敌意 ${JSON.stringify(h1)}`);
      check(
        h2.every((x, j) => (j === s2 ? x === h1[s2] : x === 0)),
        `P2 看 P1 的敌意只有对自己的一项 ${JSON.stringify(h2)}`,
      );
      check(hw.every((x) => x === 0), `观战者看 P1 的敌意全为 0 ${JSON.stringify(hw)}`);
    } else check(false, `P2 抢夺卡不可用 ${JSON.stringify(rob)}`);

    // ── 深度扫描帧
    const leaksP2 = p2.frames.flatMap((f) => findHandLeaks(f.payload, s2).map((l) => `${f.event} ${l}`));
    const leaksW = w.frames.flatMap((f) => findHandLeaks(f.payload, null).map((l) => `${f.event} ${l}`));
    const leaksP1 = p1.frames.flatMap((f) => findHandLeaks(f.payload, s1).map((l) => `${f.event} ${l}`));
    rec.frames = { p1: p1.frames.length, p2: p2.frames.length, w: w.frames.length };
    check(leaksP2.length === 0, `P2 收到 ${p2.frames.length} 帧没有泄漏 ${JSON.stringify(leaksP2.slice(0, 5))}`);
    check(leaksW.length === 0, `观战者收到 ${w.frames.length} 帧没有泄漏 ${JSON.stringify(leaksW.slice(0, 5))}`);
    check(leaksP1.length === 0, `P1 收到 ${p1.frames.length} 帧没有泄漏 ${JSON.stringify(leaksP1.slice(0, 5))}`);
    // 本人决策（yourDecision 不在 findHandLeaks 扫描范围）：SHOP 选项里的共享库存只有 0 / 1
    const shopPools = p1.frames
      .map((f) => f.payload?.yourDecision)
      .filter((d) => d?.kind === 'SHOP')
      .flatMap((d) => d.options.items.map((r) => r.pool));
    check(shopPools.length > 0 && shopPools.every((x) => x === 0 || x === 1), `P1 的 SHOP 选项帧里库存只有 0 / 1（${shopPools.length} 个值）`);
    const ydOthers =
      p2.frames.filter((f) => f.payload?.yourDecision && f.payload.yourDecision.seat !== s2).length +
      w.frames.filter((f) => f.payload?.yourDecision).length;
    check(ydOthers === 0, `P2 / 观战者没有收到别人的 yourDecision（${ydOthers}）`);
    for (const a of [p1, p2, w]) check(a.errors.length === 0, `${a.tag} 页面没有错误 ${JSON.stringify(a.errors.slice(0, 3))}`);
  } catch (e) {
    report.problems.push(`[${vp}] ${e.message}`);
    log(`[${vp}] ERROR ${e.stack}`);
    for (const a of [p1, p2, w].filter(Boolean)) await a.page.screenshot({ path: `${OUT}/${vp}-${a.tag}-error.png` }).catch(() => {});
  } finally {
    for (const a of [p1, p2, w].filter(Boolean)) {
      await a.page.evaluate(() => window.__rich4?.client?.leaveRoom?.()).catch(() => {});
      await a.ctx.close();
    }
  }
}

try {
  if (which === 'desktop' || which === 'both') await run('desktop');
  if (which === 'mobile' || which === 'both') await run('mobile');
} finally {
  await browser.close();
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${OUT}/log.txt`, `${LOG.join('\n')}\n`);
  log(report.problems.length === 0 ? '验证通过' : `问题 ${report.problems.length} 个`);
  process.exitCode = report.problems.length === 0 ? 0 : 1;
}
