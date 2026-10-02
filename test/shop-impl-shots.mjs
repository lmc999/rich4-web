// 验证：百货公司道具店按原版修复后的样子（真实素材包、台湾图，1 真人 + 1 电脑）。
// 原版皮肤与程序化皮肤各跑一遍：点券 500，把地雷（3）的库存全部发给电脑（进店时卖完 → 不上架），传送到 35 号格（来向 36）、
// 强制骰子 1 → 落在 15 号百货公司格；翻到道具页截图（不应有「庫存」）→ 选遥控骰子（8）截图（不应有数量钮）→
// 改过的客户端直接发 qty 2（应被拒绝）→ 买下 → 截图（这一行变灰）→ 再发一次（应被拒绝）→ 卖道具页卖 1 个路障截图。
// 先起本机服务（本机例外：未设门禁的素材包、只监听回环；端口 4021 / 6021）：
//   PORT=4021 HOST=127.0.0.1 PUBLIC_URL=http://localhost:6021 TRUST_PROXY=0 RICH4_ASSETS_ALLOW_UNGATED=1 \
//   RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_TEST_MODE=1 DATA_DIR=.cache/spj/shop/data-impl \
//   npx tsx apps/server/src/main.ts
//   （apps/client）RICH4_API_TARGET=http://127.0.0.1:4021 npx vite --port 6021 --strictPort
// 用法：node test/shop-impl-shots.mjs [classic|procedural|both=both] [宽x高=1280x960]
// 截图与记录写到 .cache/spj/shop/impl/（SHOP_OUT 可改；含原版素材，不入库）；SHOP_BASE 改客户端地址；有断言失败时退出码 1。
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.SHOP_BASE ?? 'http://localhost:6021';
const args = process.argv.slice(2);
const which = args.find((a) => ['classic', 'procedural', 'both'].includes(a)) ?? 'both';
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x960').split('x').map(Number);
const OUT = process.env.SHOP_OUT ?? '.cache/spj/shop/impl';
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, runs: [], problems: [] };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};
const check = (ok, what) => {
  log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) report.problems.push(what);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function run(skin) {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
  await ctx.addInitScript((sk) => {
    localStorage.setItem('rich4.introSeen', '1');
    if (sk === 'procedural') localStorage.setItem('rich4.settings', JSON.stringify({ state: { skin: 'procedural' }, version: 2 }));
  }, skin);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const rec = { skin, steps: [] };
  report.runs.push(rec);

  let shotN = 0;
  async function shot(name, wait = 500) {
    shotN++;
    if (wait) await page.waitForTimeout(wait);
    const file = `${OUT}/${skin}-${String(shotN).padStart(2, '0')}-${name}.png`;
    await page.screenshot({ path: file });
    log(`shot ${file}`);
    return file;
  }
  async function state() {
    return page.evaluate(() => {
      const h = window.__rich4;
      const g = h?.store?.game?.getState();
      const room = h?.store?.room?.getState().room;
      const d = g?.decision;
      return {
        seq: g?.seq ?? 0,
        idle: h?.eventPlayer?.idle ?? false,
        seat: room?.you?.seat ?? null,
        decision: d ? { kind: d.kind, id: d.decisionId } : null,
        submitting: g?.submitting ?? null,
      };
    });
  }
  async function debug(op) {
    const s0 = (await state()).seq;
    const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
    if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
    await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
  }
  async function act(intent = null) {
    return page.evaluate(async (it) => {
      const h = window.__rich4;
      const d = h.store.game.getState().decision;
      if (!d) return null;
      const r = await h.client.act(it ?? d.defaultIntent, d.decisionId);
      return r.ok ? { ok: true } : { ok: false, code: r.error.code, rule: r.error.details?.rule ?? null };
    }, intent);
  }
  async function waitKind(want, timeout = 240_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const st = await state();
      if (st.idle && st.decision && st.submitting === null) {
        if (want.includes(st.decision.kind)) return st;
        log(`默认应答 ${st.decision.kind}`);
        await act();
      }
      await page.waitForTimeout(150);
    }
    await page.screenshot({ path: `${OUT}/${skin}-fail-wait.png` }).catch(() => {});
    throw new Error(`wait ${want} timeout ${JSON.stringify(await state())}`);
  }
  async function shopInfo() {
    return page.evaluate(() => {
      const h = window.__rich4;
      const g = h.store.game.getState();
      const d = g.decision;
      const me = h.store.room.getState().room.you.seat;
      const p = g.view.players.find((x) => x.seat === me);
      const root = document.querySelector('[data-testid="decision-SHOP"]');
      return {
        decisionId: d?.decisionId ?? null,
        points: d?.options?.points ?? null,
        items: d?.options?.items ?? null,
        trades: d?.options?.visit?.trades ?? null,
        own8: p?.items?.[8] ?? null,
        text: root?.textContent ?? '',
        itemRows: [...document.querySelectorAll('[data-testid^="shop-item-"]')].map((e) => ({
          id: e.getAttribute('data-testid'),
          disabled: e.hasAttribute('disabled') || e.getAttribute('aria-disabled') === 'true',
        })),
        qtyControls: document.querySelectorAll(
          '[data-testid="shop-qty"],[data-testid="shop-qty-inc"],[data-testid="decision-SHOP"] input[type="number"]',
        ).length,
      };
    });
  }
  async function newShopDecision(prevId) {
    await page.waitForFunction(
      (id) => {
        const g = window.__rich4.store.game.getState();
        return g.decision?.kind === 'SHOP' && g.decision.decisionId !== id && g.submitting === null;
      },
      prevId,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(300);
  }

  try {
    await page.goto(`${BASE}/?test=1`);
    await page.getByTestId('home-nickname').fill(skin === 'classic' ? '驗證甲' : '验证乙');
    await page.getByTestId('home-nickname').blur();
    await page.getByTestId('home-create').click();
    await page.getByTestId('set-timer').waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-testid="set-map"] option')].some((o) => o.value === 'taiwan'),
    );
    await page.getByTestId('set-map').selectOption('taiwan');
    await page.getByTestId('set-timer').selectOption('off');
    await page.getByTestId('set-ai-count').selectOption('1');
    await page.getByTestId('create-submit').click();
    await page.waitForURL(/\/r\/\d{6}/);
    await page.getByTestId('screen-room').waitFor();
    await page.getByTestId('char-2').click();
    await page.waitForTimeout(300);
    const txt = await page.getByTestId('char-select').textContent();
    if (!/^已(选择|選擇)$/.test(txt ?? '')) await page.getByTestId('char-select').click();
    await page.waitForTimeout(400);
    await page.getByTestId('room-start').click();
    await page.getByTestId('screen-game').waitFor({ timeout: 60_000 });
    await page.waitForFunction(
      () => window.__rich4?.store?.game?.getState().view !== null && window.__rich4.eventPlayer.idle,
      null,
      { timeout: 60_000 },
    );
    rec.skinInfo = await page.evaluate(() => window.__rich4.skin);
    log(`[${skin}] skin ${JSON.stringify(rec.skinInfo)}`);
    await debug({ op: 'clearBoard' });

    const st = await waitKind(['TURN_MENU']);
    const me = st.seat;
    const ai = me === 0 ? 1 : 0;
    // 地雷（3）的库存全部发给电脑：进店时卖完 → 原版不上架；路障（2）给自己 2 个用来卖
    const pool3 = await page.evaluate(() => window.__rich4.store.game.getState().view.pools?.items?.[3] ?? null);
    log(`[${skin}] 地雷库存 ${pool3}`);
    if (pool3 !== null && pool3 > 0) await debug({ op: 'give', seat: ai, cards: [], items: [{ item: 3, qty: Math.min(9, pool3) }] });
    await debug({ op: 'give', seat: me, cards: [], items: [{ item: 2, qty: 2 }] });
    await debug({ op: 'setPoints', seat: me, points: 500 });
    await debug({ op: 'teleport', seat: me, node: 35, prev: 36 });
    await debug({ op: 'forceNext', purpose: 'dice', values: [1] });
    await waitKind(['TURN_MENU']);
    await act({ type: 'ROLL' });
    await waitKind(['SHOP']);
    const scene = page.getByTestId('decision-SHOP');
    await scene.waitFor();
    rec.scene = await scene.getAttribute('data-scene');
    check(skin === 'classic' ? rec.scene === 'classic' : rec.scene !== 'classic', `[${skin}] 场景 data-scene=${rec.scene}`);
    await shot('card-page', 1200);

    // 道具页
    if (skin === 'classic') await scene.getByTestId('shop-page-item').click();
    else await scene.getByRole('tab', { name: '买道具' }).click();
    await page.waitForTimeout(400);
    let info = await shopInfo();
    rec.steps.push({ step: 'item-page', items: info.items, itemRows: info.itemRows });
    check(!/庫存|库存/.test(info.text), `[${skin}] 道具页没有库存字样`);
    if (skin === 'classic') {
      // 原版货架行只写名称与价格：持有 2 个路障，货架上也不写「×n」
      const shelf = await scene.getByTestId('shop-shelf').innerText();
      check(!shelf.includes('×'), `[${skin}] 买道具货架没有持有数「×n」：${JSON.stringify(shelf.slice(0, 120))}`);
    }
    check(!info.itemRows.some((r) => r.id === 'shop-item-3'), `[${skin}] 进店时卖完的地雷不上架`);
    await shot('item-page');

    await scene.getByTestId('shop-item-8').click();
    await page.waitForTimeout(300);
    info = await shopInfo();
    check(info.qtyControls === 0, `[${skin}] 选遥控骰子后没有数量控件（${info.qtyControls}）`);
    await shot('remote-dice-selected');

    const hack1 = await act({ type: 'SHOP_BUY_ITEM', item: 8, qty: 2 });
    rec.steps.push({ step: 'hack-qty2', result: hack1 });
    check(hack1?.ok === false && hack1.rule === 'OUT_OF_RANGE', `[${skin}] 改过的客户端 qty 2 被拒绝 ${JSON.stringify(hack1)}`);
    await page.waitForTimeout(600);

    const before = await shopInfo();
    await scene.getByTestId('shop-buy-item').click();
    await newShopDecision(before.decisionId);
    info = await shopInfo();
    rec.steps.push({ step: 'after-buy', trades: info.trades, items: info.items, itemRows: info.itemRows });
    check(
      JSON.stringify(info.trades) === JSON.stringify([{ op: 'buyItem', card: null, item: 8, qty: 1, points: 30 }]),
      `[${skin}] 交易记录只有 qty 1：${JSON.stringify(info.trades)}`,
    );
    check(info.points === 470, `[${skin}] 点券 500 → ${info.points}`);
    check(info.itemRows.find((r) => r.id === 'shop-item-8')?.disabled === true, `[${skin}] 买后遥控骰子这一行禁用`);
    await shot('after-buy');

    const hack2 = await act({ type: 'SHOP_BUY_ITEM', item: 8, qty: 1 });
    rec.steps.push({ step: 'hack-again', result: hack2 });
    check(hack2?.ok === false && hack2.rule === 'NOT_ALLOWED', `[${skin}] 再买一次被拒绝 ${JSON.stringify(hack2)}`);
    await page.waitForTimeout(600);

    // 卖道具：一次 1 个
    if (skin === 'classic') await scene.getByTestId('shop-tab-sell').click();
    else await scene.getByRole('tab', { name: '卖道具' }).click();
    await scene.getByTestId('shop-sell-item-2').click();
    await page.waitForTimeout(300);
    info = await shopInfo();
    if (skin === 'classic') {
      const shelf = await scene.getByTestId('shop-shelf').innerText();
      check(shelf.includes('×'), `[${skin}] 卖道具货架写持有数「×n」：${JSON.stringify(shelf.slice(0, 120))}`);
    }
    check(info.qtyControls === 0, `[${skin}] 卖道具没有数量控件`);
    await shot('sell-roadblock-selected');
    const b2 = await shopInfo();
    await scene.getByTestId('shop-sell-item').click();
    await newShopDecision(b2.decisionId);
    info = await shopInfo();
    const last = info.trades?.at(-1);
    check(last?.op === 'sellItem' && last.item === 2 && last.qty === 1, `[${skin}] 卖路障 qty 1：${JSON.stringify(last)}`);

    await scene.getByTestId('shop-leave').click();
    await page.waitForTimeout(800);
    rec.errors = errors;
    check(errors.length === 0, `[${skin}] 页面没有错误 ${JSON.stringify(errors)}`);
  } catch (e) {
    report.problems.push(`[${skin}] ${e.message}`);
    log(`[${skin}] ERROR ${e.stack}`);
    await page.screenshot({ path: `${OUT}/${skin}-error.png` }).catch(() => {});
  } finally {
    await ctx.close();
  }
}

try {
  if (which === 'classic' || which === 'both') await run('classic');
  if (which === 'procedural' || which === 'both') await run('procedural');
} finally {
  await browser.close();
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${OUT}/log.txt`, `${LOG.join('\n')}\n`);
  log(report.problems.length === 0 ? '验证通过' : `问题 ${report.problems.length} 个`);
  process.exitCode = report.problems.length === 0 ? 0 : 1;
}
