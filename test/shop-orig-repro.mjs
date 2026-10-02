// 调研：百货公司道具店现状复现（原版皮肤、真实素材包、台湾图，1 真人 + 1 电脑）。
// 复现用户反馈：道具页货架每行显示「庫存 n」，同一道具可以一次买多个（数量 +/−，一次买 9 颗遥控骰子）。
// 做法：真人回合用 debug:act 设点券 500、传送到 35 号格（来向 36）、强制骰子 1 → 落在 15 号百货公司格；
// 进店后翻到道具页截图，先卖 1 颗遥控骰子（让自己持有 0、库存回到 9），再选遥控骰子把数量加到 9 一次买下。
// 先起本机服务（本机例外：未设门禁的素材包、只监听回环；端口 4011 / 6011）：
//   PORT=4011 HOST=127.0.0.1 PUBLIC_URL=http://localhost:6011 TRUST_PROXY=0 RICH4_ASSETS_ALLOW_UNGATED=1 \
//   RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_TEST_MODE=1 DATA_DIR=.cache/spj/shop/data \
//   npx tsx apps/server/src/main.ts
//   （apps/client）RICH4_API_TARGET=http://127.0.0.1:4011 npx vite --port 6011 --strictPort
// 用法：node test/shop-orig-repro.mjs [宽x高=1280x960]
// 截图与记录写到 .cache/spj/shop/repro/（含原版素材，不入库）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.SHOP_BASE ?? 'http://localhost:6011';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x960').split('x').map(Number);
const OUT = '.cache/spj/shop/repro';
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, steps: [], problems: [] };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

let shotN = 0;
async function shot(name, wait = 400) {
  shotN++;
  if (wait) await page.waitForTimeout(wait);
  const file = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
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
  return page.evaluate((it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(it ?? d.defaultIntent, d.decisionId) : null;
  }, intent);
}

/** 等本人出现 want 里的决策（其余决策按默认应答） */
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
  await page.screenshot({ path: `${OUT}/fail-wait.png` }).catch(() => {});
  throw new Error(`wait ${want} timeout ${JSON.stringify(await state())}`);
}

/** 当前 SHOP 决策的 options（道具行）与本人持有 */
async function shopInfo() {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h.store.game.getState();
    const d = g.decision;
    const me = h.store.room.getState().room.you.seat;
    const p = g.view.players.find((x) => x.seat === me);
    return {
      decisionId: d?.decisionId ?? null,
      kind: d?.kind ?? null,
      points: d?.options?.points ?? null,
      items: d?.options?.items ?? null,
      myItems: p?.items ?? null,
      page: document.querySelector('[data-testid="decision-SHOP"]')?.getAttribute('data-page') ?? null,
      mode: document.querySelector('[data-testid="decision-SHOP"]')?.getAttribute('data-mode') ?? null,
      shelfText: [...document.querySelectorAll('[data-testid="shop-shelf"] > div')].map((e) => e.textContent),
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

async function toItemPage() {
  const scene = page.getByTestId('decision-SHOP');
  if ((await scene.getAttribute('data-page')) !== 'item') await scene.getByTestId('shop-page-item').click();
  await page.waitForTimeout(300);
}

try {
  await page.goto(`${BASE}/?test=1`);
  await page.getByTestId('home-nickname').fill('調研甲');
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
  const skin = await page.evaluate(() => window.__rich4.skin);
  log(`skin ${JSON.stringify(skin)}`);
  report.skin = skin;
  await debug({ op: 'clearBoard' });

  const st = await waitKind(['TURN_MENU']);
  const me = st.seat;
  log(`me=${me}`);
  await debug({ op: 'setPoints', seat: me, points: 500 });
  await debug({ op: 'teleport', seat: me, node: 35, prev: 36 });
  await debug({ op: 'forceNext', purpose: 'dice', values: [1] });
  await waitKind(['TURN_MENU']);
  await act({ type: 'ROLL' });
  await waitKind(['SHOP']);
  await page.getByTestId('decision-SHOP').waitFor();
  report.scene = await page.getByTestId('decision-SHOP').getAttribute('data-scene');
  await shot('shop-card-page', 1200);

  // 道具页：货架每行的文字（含「庫存 n」）
  await toItemPage();
  let info = await shopInfo();
  report.steps.push({ step: 'item-page', ...info });
  log(`道具页 rows ${JSON.stringify(info.shelfText)}`);
  log(`options.items ${JSON.stringify(info.items)}`);
  await shot('shop-item-page');

  // 先卖 1 颗遥控骰子（item 8）：持有 1 → 0，库存 +1
  const scene = page.getByTestId('decision-SHOP');
  await scene.getByTestId('shop-tab-sell').click();
  await scene.getByTestId('shop-sell-item-8').click();
  await shot('sell-remote-dice-selected');
  let prev = info.decisionId;
  await scene.getByTestId('shop-sell-item').click();
  await newShopDecision(prev);
  await toItemPage();
  info = await shopInfo();
  report.steps.push({ step: 'after-sell-1', ...info });
  log(`卖出 1 颗后 item8 ${JSON.stringify(info.items?.find((r) => r.item === 8))} points ${info.points}`);

  // 买：选遥控骰子，把数量加到上限，一次买下
  if ((await scene.getAttribute('data-mode')) !== 'buy') await scene.getByTestId('shop-tab-buy').click();
  await scene.getByTestId('shop-item-8').click();
  for (let i = 0; i < 12; i++) {
    const inc = scene.getByTestId('shop-qty-inc');
    if (await inc.isDisabled()) break;
    await inc.click();
  }
  const qty = await scene.getByTestId('shop-qty').getAttribute('data-value');
  log(`数量选到 ${qty}`);
  report.qtyPicked = Number(qty);
  await shot('buy-remote-dice-qty');
  prev = info.decisionId;
  await scene.getByTestId('shop-buy-item').click();
  await newShopDecision(prev);
  await toItemPage();
  info = await shopInfo();
  report.steps.push({ step: 'after-buy', ...info });
  log(`一次买下后 item8 ${JSON.stringify(info.items?.find((r) => r.item === 8))} points ${info.points} myItems ${JSON.stringify(info.myItems)}`);
  // 最近的 SHOP_TRADE 事件（服务器下发的日志）
  report.trades = await page.evaluate(() => {
    const g = window.__rich4.store.game.getState();
    const d = g.decision;
    return d?.options?.visit?.trades ?? null;
  });
  log(`本次进店交易 ${JSON.stringify(report.trades)}`);
  await shot('after-buy-9');
  if (report.qtyPicked < 2) report.problems.push('没能复现复数购买');
  await scene.getByTestId('shop-leave').click();
  await page.waitForTimeout(800);
} catch (e) {
  report.problems.push(`异常：${e instanceof Error ? e.message : String(e)}`);
  log(`!! ${e instanceof Error ? e.stack : String(e)}`);
  await page.screenshot({ path: `${OUT}/fail.png` }).catch(() => {});
}

report.errors = errors;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/log.txt`, `${LOG.join('\n')}\n`);
log(report.problems.length ? `问题 ${JSON.stringify(report.problems)}` : '复现完成');
await browser.close();
process.exit(report.problems.length ? 1 : 0);
