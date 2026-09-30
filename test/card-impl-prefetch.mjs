// 验证（卡片插画预取）：限速网络下开一局台湾图（1 真人 + 1 电脑），看 30 张卡片插画是否在开局后空闲时就下载完，
// 出卡弹窗出现的那一刻插画是否已在缓存里（弹窗出现后 80 ms 截图，插画应已画出）。
// 用法：node test/card-impl-prefetch.mjs [站点=http://localhost:5721] [延迟 ms=150] [下行 KB/s=200]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://localhost:5721';
const LATENCY = Number(process.argv[3] ?? 150);
const KBPS = Number(process.argv[4] ?? 200);
const OUT = '.cache/card/impl';
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 960 } });
await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
const A = await ctx.newPage();
const cdp = await ctx.newCDPSession(A);
await cdp.send('Network.enable');
/** 卡片插画请求（CDP 网络事件；页面的 resource timing 缓冲区会被几百个素材撑满，不可靠） */
const cardReq = new Map();
cdp.on('Network.requestWillBeSent', (e) => {
  const m = /\/images\/data\/(5[3-5]\d)\./.exec(e.request.url);
  if (m && Number(m[1]) >= 530 && Number(m[1]) <= 559) cardReq.set(e.requestId, { res: Number(m[1]), start: Date.now() });
});
cdp.on('Network.loadingFinished', (e) => {
  const r = cardReq.get(e.requestId);
  if (r) r.end = Date.now();
});
const cardsDone = () => [...cardReq.values()].filter((r) => r.end).length;
/** 限速从进房之后开始（vite 开发服务器的几百个模块在限速下加载太慢，与素材无关） */
const throttle = () =>
  cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: LATENCY,
    downloadThroughput: KBPS * 1024,
    uploadThroughput: KBPS * 1024,
  });
const res = { base: BASE, latency: LATENCY, kbps: KBPS };
try {
  await A.goto(`${BASE}/?test=1`);
  await A.getByTestId('home-nickname').fill('測試甲');
  await A.getByTestId('home-nickname').blur();
  await A.getByTestId('home-create').click();
  await A.getByTestId('set-map').selectOption('taiwan');
  await A.getByTestId('set-timer').selectOption('off');
  await A.getByTestId('set-ai-count').selectOption('1');
  await A.getByTestId('create-submit').click();
  await A.waitForURL(/\/r\/\d{6}/);
  await A.getByTestId('char-2').click();
  if ((await A.getByTestId('screen-room').getAttribute('data-screen')) !== 'select')
    await A.getByTestId('char-select').click();
  await throttle();
  log(`限速：${LATENCY} ms、${KBPS} KB/s`);
  await A.getByTestId('room-start').click();
  await A.getByTestId('classic-stage').waitFor({ timeout: 180_000 });
  const startAt = Date.now();
  log('开局');
  // 等 30 张卡片插画都下载完（CDP 网络事件里 images/data/530–559 的请求）
  for (let i = 0; i < 360 && cardsDone() < 30; i++) await A.waitForTimeout(500);
  const reqs = [...cardReq.values()].sort((a, b) => a.start - b.start);
  res.prefetched = cardsDone();
  res.firstRequestSec = reqs[0] ? ((reqs[0].start - startAt) / 1000).toFixed(1) : null;
  res.prefetchDoneSec = reqs.length ? ((Math.max(...reqs.map((r) => r.end ?? 0)) - startAt) / 1000).toFixed(1) : null;
  res.order = reqs.map((r) => r.res - 529);
  log(`卡片插画已下载 ${res.prefetched}/30：开局后 ${res.firstRequestSec}s 开始、${res.prefetchDoneSec}s 全部完成`, res.order);

  // 本人出一张均富卡：弹窗出现后 80 ms 截图，读插画是否已完成解码
  await A.waitForFunction(() => {
    const g = window.__rich4?.store?.game?.getState();
    return g?.decision?.kind === 'TURN_MENU' && window.__rich4.eventPlayer.idle;
  }, undefined, { timeout: 180_000 });
  const s0 = await A.evaluate(() => window.__rich4.store.game.getState().seq);
  const seat = await A.evaluate(() => window.__rich4.store.room.getState().room.you.seat);
  await A.evaluate((st) => window.__rich4.client.debug({ op: 'give', seat: st, cards: [1], items: [] }), seat);
  await A.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0);
  await A.waitForFunction(() => {
    const d = window.__rich4.store.game.getState().decision;
    return d?.kind === 'TURN_MENU' && d.options.cards.some((r) => r.card === 1);
  });
  const slot = await A.evaluate(
    () => window.__rich4.store.game.getState().decision.options.cards.find((r) => r.card === 1).slot,
  );
  await A.getByTestId('action-cards').click();
  await A.getByTestId(`inv-card-${slot}`).click();
  await A.getByTestId('target-confirm').click();
  const before = cardReq.size;
  await A.locator('[data-testid="card-cast-popup"]').waitFor({ timeout: 30_000 });
  await A.waitForTimeout(80);
  res.newCardRequestsDuringCast = cardReq.size - before;
  res.atPopup = await A.evaluate(async () => {
    const art = document.querySelector('[data-testid="card-cast-art"]');
    const url = art?.getAttribute('data-src');
    const img = new Image();
    img.src = url;
    // 已在内存 / HTTP 缓存里时 complete 立即为 true
    const cachedNow = img.complete;
    const entry = performance.getEntriesByName(new URL(url, location.href).href)[0];
    return { url, cachedNow, fetchedAtMs: entry ? Math.round(entry.responseEnd) : null, nowMs: Math.round(performance.now()) };
  });
  await A.screenshot({ path: `${OUT}/prefetch-throttled-cast-t80.png` });
  log('弹窗出现时', res.atPopup);
} catch (e) {
  res.error = String(e?.stack ?? e);
  log('ERROR', res.error);
  process.exitCode = 1;
} finally {
  writeFileSync(`${OUT}/prefetch.json`, JSON.stringify(res, null, 2));
  await browser.close();
}
