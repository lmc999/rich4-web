// 调试脚本（T3 选图与飞行动画的本机手测与截图）：对着本机 T3 服务（客户端 5813 → 服务端 3813，RICH4_DATA_DIR 为四张图的
// 数据包、RICH4_ASSETS_DIR 为 test/maps-t3-overlay-pack.ts 生成的叠加包）用本机 Chrome 逐图走一遍：
// 开局设置点关卡换背景 → 建房（补 3 个电脑）→ 选人大厅 → 开局播该图的飞行动画（截图、跳过）→ 调到节日看日历插画与节日名；
// 另测刷新不重播、读档开局不播。截图写到 .cache/maps/t3-shots/。
// 用法：node test/maps-t3-shots.mjs [--maps china,japan,usa,taiwan] [--phone japan]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.T3_BASE ?? 'http://localhost:5813';
const OUT = '.cache/maps/t3-shots';
mkdirSync(OUT, { recursive: true });

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const MAPS = arg('--maps', 'china,japan,usa,taiwan').split(',').filter(Boolean);
const PHONE = arg('--phone', 'japan').split(',').filter(Boolean);
const STAGE = { taiwan: 0, china: 1, japan: 2, usa: 3 };
const FLY = { taiwan: 'flytw', china: 'flychina', japan: 'flyjp', usa: 'flyus' };
/** 各图挑一个有插画的节日（日期 → 期望的 slot 与节日插画键） */
const HOLIDAY = {
  taiwan: { date: 19981010, key: 'illustration.holiday.10' },
  china: { date: 19981001, key: 'illustration.holiday.33' },
  japan: { date: 19981225, key: 'illustration.holiday.61' },
  usa: { date: 19980704, key: 'illustration.holiday.75' },
};

const report = [];
const log = (...a) => {
  const line = a.join(' ');
  report.push(line);
  console.log(line);
};

async function newPage(browser, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    localStorage.setItem('rich4.introSeen', '1');
    if (!localStorage.getItem('rich4.settings')) {
      localStorage.setItem('rich4.settings', JSON.stringify({ state: { nickname: 'T3测试', skin: 'original' }, version: 2 }));
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return { context, page, errors };
}

const tid = (page, id) => page.locator(`[data-testid="${id}"]`);

async function waitAttr(page, id, name, value, timeout = 20_000) {
  await page.waitForFunction(
    ([i, n, v]) => document.querySelector(`[data-testid="${i}"]`)?.getAttribute(n) === v,
    [id, name, value],
    { timeout },
  );
}

async function debug(page, op) {
  return page.evaluate((o) => window.__rich4.client.debug(o), op);
}

/** 一张图：开局设置 → 建房 → 大厅 → 开局飞行动画 → 日历节日 */
async function runMap(browser, map, viewport, tag) {
  const { context, page, errors } = await newPage(browser, viewport);
  try {
    await page.goto(`${BASE}/?audio=off&test=1`);
    await waitAttr(page, 'screen-home', 'data-screen', 'title', 30_000);
    await tid(page, 'home-create').click();
    await tid(page, 'screen-setup').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="set-map"]')?.value === 'taiwan');
    const k = STAGE[map];
    await tid(page, `setup-stage-${k}`).click();
    await waitAttr(page, `setup-stage-${k}`, 'data-selected', 'true');
    const bg = await tid(page, 'setup-bg').getAttribute('data-image');
    const avail = [];
    for (let i = 0; i < 4; i++) avail.push(await tid(page, `setup-stage-${i}`).getAttribute('data-available'));
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${tag}-1-setup-${map}.png` });
    log(`[${tag}] ${map} 开局设置：set-map=${await tid(page, 'set-map').inputValue()} 背景=${bg} 关卡可用=${avail.join(',')}`);

    await tid(page, 'set-timer').selectOption('off');
    await tid(page, 'set-ai-count').selectOption('3');
    await tid(page, 'create-submit').click();
    await page.waitForURL(/\/r\/\d{6}/);
    await waitAttr(page, 'screen-room', 'data-screen', 'select');
    await tid(page, 'char-3').click();
    await page.waitForTimeout(800);
    log(`[${tag}] ${map} 选人大厅：背景=${await tid(page, 'setup-bg').getAttribute('data-image')} 勾=${await tid(page, `setup-stage-${k}`).getAttribute('data-selected')}`);
    await page.screenshot({ path: `${OUT}/${tag}-2-room-${map}.png` });

    await tid(page, 'room-start').click();
    await tid(page, 'fly').waitFor({ timeout: 20_000 });
    const src = await tid(page, 'fly-video').getAttribute('src');
    const held = await page.evaluate(() => window.__rich4.client.player.held);
    await page.waitForTimeout(2500);
    const urgent = await tid(page, 'fly-skip').getAttribute('data-urgent');
    const playing = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="fly-video"]');
      return v ? { t: Number(v.currentTime.toFixed(2)), paused: v.paused, muted: v.muted, rs: v.readyState } : null;
    });
    await page.screenshot({ path: `${OUT}/${tag}-3-fly-${map}.png` });
    log(`[${tag}] ${map} 飞行动画：src=${src} 期望含 ${FLY[map]}：${src?.includes(FLY[map])} 暂缓回放=${held} 跳过钮醒目=${urgent} 播放=${JSON.stringify(playing)}`);
    await tid(page, 'fly-skip').click();
    await tid(page, 'fly').waitFor({ state: 'detached' });
    log(`[${tag}] ${map} 跳过后：暂缓=${await page.evaluate(() => window.__rich4.client.player.held)}`);

    await tid(page, 'screen-game').waitFor();
    await page.waitForFunction(() => window.__rich4?.store?.game?.getState?.().view != null || true);
    await page.waitForTimeout(1500);
    const h = HOLIDAY[map];
    const r = await debug(page, { op: 'setDate', date: h.date });
    await page.waitForTimeout(1500);
    const cal = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="classic-calendar"]');
      const b = document.querySelector('[data-testid="classic-cal-bg"]');
      return c ? { mode: c.getAttribute('data-mode'), holiday: c.getAttribute('data-holiday'), bg: b?.getAttribute('data-bg') } : null;
    });
    await page.screenshot({ path: `${OUT}/${tag}-4-calendar-${map}.png` });
    log(`[${tag}] ${map} 日历（setDate ${h.date} ok=${r?.ok}）：${JSON.stringify(cal)} 期望插画 ${h.key}`);

    // 刷新：进页时对局已在进行，不重播
    await page.reload();
    await tid(page, 'screen-game').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    log(`[${tag}] ${map} 刷新后飞行动画：${(await tid(page, 'fly').count()) === 0 ? '不播（正确）' : '又播了（错误）'}`);
    const errs = errors.filter((e) => !/favicon|WebGL/.test(e));
    if (errs.length) log(`[${tag}] ${map} 控制台错误：${errs.slice(0, 5).join(' | ')}`);
    return page;
  } finally {
    await context.close();
  }
}

/** 读档开局不播：在一局里存档 → 新建房间读档 → 开局 */
async function runLoad(browser, map) {
  const { context, page, errors } = await newPage(browser, { width: 1280, height: 800 });
  try {
    await page.goto(`${BASE}/?audio=off&test=1&anim=instant`);
    await waitAttr(page, 'screen-home', 'data-screen', 'title', 30_000);
    // 先正常开一局（instant 下不播飞行动画）并存档
    await tid(page, 'home-create').click();
    await tid(page, `setup-stage-${STAGE[map]}`).click();
    await tid(page, 'set-timer').selectOption('off');
    await tid(page, 'set-ai-count').selectOption('3');
    await tid(page, 'create-submit').click();
    await page.waitForURL(/\/r\/\d{6}/);
    await waitAttr(page, 'screen-room', 'data-screen', 'select');
    await tid(page, 'char-5').click();
    await page.waitForTimeout(500);
    await tid(page, 'room-start').click();
    await tid(page, 'screen-game').waitFor();
    await page.waitForTimeout(1500);
    const saved = await page.evaluate(() => window.__rich4.client.save('T3 读档测试'));
    log(`[load] ${map} 存档：${JSON.stringify(saved).slice(0, 120)}`);
    await page.evaluate(() => window.__rich4.client.leaveRoom());
    // 去掉 anim=instant 再开一个房间读档
    await page.goto(`${BASE}/?audio=off&test=1`);
    await waitAttr(page, 'screen-home', 'data-screen', 'title', 30_000);
    await tid(page, 'home-create').click();
    await tid(page, 'set-timer').selectOption('off');
    await tid(page, 'create-submit').click();
    await page.waitForURL(/\/r\/\d{6}/);
    await waitAttr(page, 'screen-room', 'data-screen', 'select');
    const list = await page.evaluate(() => window.__rich4.client.listSaves());
    const save = list?.data?.saves?.find((x) => x.name === 'T3 读档测试');
    const loaded = await page.evaluate((id) => window.__rich4.client.loadSave(id), save?.saveId);
    log(`[load] 读档：${JSON.stringify(loaded).slice(0, 120)}`);
    await page.waitForTimeout(1000);
    // 认领自己的座位（存档里 0 号是真人），其余存档座位由电脑补上
    const room = await page.evaluate(() => window.__rich4.store.room.getState().room);
    log(`[load] 大厅读档横幅：${room?.loadedSave ? room.loadedSave.name : '无'}；地图 ${room?.settings?.game?.mapId}`);
    await page.screenshot({ path: `${OUT}/load-1-room-${map}.png` });
    const start = await page.evaluate(() => window.__rich4.client.startGame());
    log(`[load] 开局：${JSON.stringify(start).slice(0, 160)}`);
    await tid(page, 'screen-game').waitFor({ timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    log(`[load] 读档开局飞行动画：${(await tid(page, 'fly').count()) === 0 ? '不播（正确）' : '播了（错误）'}`);
    await page.screenshot({ path: `${OUT}/load-2-game-${map}.png` });
    const errs = errors.filter((e) => !/favicon|WebGL/.test(e));
    if (errs.length) log(`[load] 控制台错误：${errs.slice(0, 5).join(' | ')}`);
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  for (const m of MAPS) await runMap(browser, m, { width: 1280, height: 800 }, 'desktop');
  for (const m of PHONE) await runMap(browser, m, { width: 812, height: 375 }, 'phone');
  if (!process.argv.includes('--no-load')) await runLoad(browser, 'china');
} finally {
  await browser.close();
  writeFileSync(`${OUT}/report.txt`, `${report.join('\n')}\n`);
}
