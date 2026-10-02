// 调试脚本（原版另外 3 张图接入的集成阶段回归）：对着本机集成服务（客户端 5815 → 服务端 3815，免门禁、RICH4_TEST_MODE=1）：
// - taiwan：台湾一局（期限 30 天、3 个电脑、托管）从开局到结束，第 10 天前后手动存档；再新建房间读这个档开局
//   （不播飞行动画），托管到结束；
// - oldsave：导入早先版本留下的台湾存档（test/maps-final-old-save.mjs 导出的 .r4save），读档开局后能继续（mapHash 不失配）；
// - oldpack：服务器挂旧素材包（只有台湾皮肤）时，四张图各开一局：台湾原版棋盘，另外三张回退程序化棋盘、不崩溃。
// 截图与记录写到 .cache/maps/final/regress/。
// 用法：node test/maps-final-regress.mjs taiwan|oldsave|oldpack [--base http://localhost:5815]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const MODE = process.argv[2];
const BASE = arg('--base', 'http://localhost:5815');
const OUT = '.cache/maps/final/regress';
mkdirSync(OUT, { recursive: true });
const STAGE = { taiwan: 0, china: 1, japan: 2, usa: 3 };

const report = [];
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  report.push(line);
  console.log(line);
};

const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
const sleep = (page, ms) => page.waitForTimeout(ms);

async function newPage(browser, skin = 'original') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.addInitScript((sk) => {
    localStorage.setItem('rich4.introSeen', '1');
    if (!localStorage.getItem('rich4.settings')) {
      localStorage.setItem('rich4.settings', JSON.stringify({ state: { nickname: '回归', skin: sk }, version: 2 }));
    }
  }, skin);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    if (m.type() === 'warning' && /未结束|handler 出错/.test(m.text())) errors.push(`warn: ${m.text()}`);
  });
  return { context, page, errors };
}

async function waitAttr(page, id, name, value, timeout = 30_000) {
  await page.waitForFunction(
    ([i, n, v]) => document.querySelector(`[data-testid="${i}"]`)?.getAttribute(n) === v,
    [id, name, value],
    { timeout },
  );
}

async function waitIdle(page, timeout = 60_000) {
  await page.waitForFunction(
    () => {
      const h = window.__rich4;
      return !!h?.store?.game && h.store.game.getState().view !== null && h.eventPlayer.idle;
    },
    undefined,
    { timeout },
  );
}

const day = (page) =>
  page.evaluate(() => {
    const v = window.__rich4?.store?.game?.getState().latest;
    return v ? { date: v.clock.date, elapsed: v.clock.elapsedDays } : null;
  });

/** 首页 → 开局设置（点关卡）→ 建房 → 选人；返回房间码 */
async function createGame(page, map, o = {}) {
  await page.goto(`${BASE}/?audio=off&test=1${o.instant ? '&anim=instant' : ''}`);
  await waitAttr(page, 'screen-home', 'data-screen', 'title');
  await tid(page, 'home-create').click();
  await tid(page, 'screen-setup').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="set-map"]')?.value);
  const k = STAGE[map];
  const avail = await tid(page, `setup-stage-${k}`).getAttribute('data-available');
  if (avail === 'true') await tid(page, `setup-stage-${k}`).click();
  else await tid(page, 'set-map').selectOption(map);
  await tid(page, 'set-timer').selectOption('off');
  await tid(page, 'set-ai-count').selectOption('3');
  if (o.days) await tid(page, 'set-time').selectOption(String(o.days));
  if ((await tid(page, 'set-pacing').count()) > 0) await tid(page, 'set-pacing').selectOption('compact');
  await tid(page, 'create-submit').click();
  await page.waitForURL(/\/r\/\d{6}/);
  await waitAttr(page, 'screen-room', 'data-screen', 'select');
  await page.evaluate(() => window.__rich4?.client?.updateSettings?.({ aiPace: 'fast' }));
  await tid(page, 'char-2').click();
  await sleep(page, 600);
  return page.url().match(/\/r\/(\d{6})/)?.[1];
}

async function startAndSkipFly(page) {
  await tid(page, 'room-start').click();
  const fly = await tid(page, 'fly')
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (fly) {
    await tid(page, 'fly-skip').click();
    await tid(page, 'fly').waitFor({ state: 'detached' });
  }
  await tid(page, 'screen-game').waitFor({ timeout: 30_000 });
  await waitIdle(page);
  return fly;
}

/** 托管，等到 pred 成立或对局结束 */
async function runUntil(page, pred, timeoutMs) {
  await page.evaluate(() => window.__rich4.client.autopilot(true));
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(page, 2000);
    const st = await page.evaluate(() => {
      const g = window.__rich4.store.game.getState();
      const r = window.__rich4.store.room.getState().room;
      return { over: g.over !== null, phase: r?.phase, elapsed: g.latest?.clock.elapsedDays ?? null };
    });
    if (st.over || st.phase === 'ended' || (await pred(st))) return st;
  }
  return null;
}

async function saveAs(page, name) {
  const r = await page.evaluate((n) => window.__rich4.client.save(n), name);
  return r;
}

async function loadInNewRoom(page, name, o = {}) {
  await page.goto(`${BASE}/?audio=off&test=1`);
  await waitAttr(page, 'screen-home', 'data-screen', 'title');
  await tid(page, 'home-create').click();
  await tid(page, 'screen-setup').waitFor();
  await tid(page, 'set-timer').selectOption('off');
  if ((await tid(page, 'set-pacing').count()) > 0) await tid(page, 'set-pacing').selectOption('compact');
  await tid(page, 'create-submit').click();
  await page.waitForURL(/\/r\/\d{6}/);
  await waitAttr(page, 'screen-room', 'data-screen', 'select');
  await page.evaluate(() => window.__rich4?.client?.updateSettings?.({ aiPace: 'fast' }));
  const list = await page.evaluate(() => window.__rich4.client.listSaves());
  const save = o.saveId
    ? list?.data?.saves?.find((x) => x.saveId === o.saveId)
    : list?.data?.saves?.find((x) => x.name === name);
  if (!save) throw new Error(`找不到存档 ${name}：${JSON.stringify(list).slice(0, 300)}`);
  const loaded = await page.evaluate((id) => window.__rich4.client.loadSave(id), save.saveId);
  log(`读档 ${save.saveId}（${save.name}，${save.mapId ?? ''}，verified=${save.verified}）：${JSON.stringify(loaded).slice(0, 200)}`);
  await sleep(page, 1200);
  const room = await page.evaluate(() => window.__rich4.store.room.getState().room);
  log(`大厅：地图 ${room?.settings?.game?.mapId}，读档横幅 ${room?.loadedSave ? JSON.stringify(room.loadedSave).slice(0, 160) : '无'}`);
  // 读档后认领存档里的一个真人座位（本人还没入座时），其余等待认领的真人座位交给电脑
  for (const s of room?.seats ?? []) {
    if (s.occupant !== null || !s.savedSeat) continue;
    const r2 = await page.evaluate(() => window.__rich4.store.room.getState().room);
    const mine = r2?.you?.role === 'player';
    const res = mine
      ? await page.evaluate((i) => window.__rich4.client.setSeatAi(i, { preset: 'character' }), s.index)
      : await page.evaluate((i) => window.__rich4.client.claimSeat(i), s.index);
    log(`座位 ${s.index}（${s.savedSeat.nickname}，wasHuman=${s.savedSeat.wasHuman}）${mine ? '交给电脑' : '由本人认领'}：${JSON.stringify(res)}`);
    await sleep(page, 400);
  }
  await sleep(page, 800);
  const after = await page.evaluate(() => window.__rich4.store.room.getState().room);
  return { save, loaded, room: after };
}

async function modeTaiwan(browser) {
  const { context, page, errors } = await newPage(browser);
  try {
    const code = await createGame(page, 'taiwan', { days: 30 });
    const fly = await startAndSkipFly(page);
    log(`台湾新局 ${code}：飞行动画=${fly}`);
    await page.screenshot({ path: `${OUT}/taiwan-1-start.png` });
    const st = await runUntil(page, async (s) => (s.elapsed ?? 0) >= 10, 900_000);
    log(`托管到第 ${st?.elapsed} 天：${JSON.stringify(st)}`);
    await page.evaluate(() => window.__rich4.client.autopilot(false));
    await waitIdle(page, 90_000).catch(() => {});
    const saved = await saveAs(page, '集成回归-台湾');
    log(`手动存档：${JSON.stringify(saved).slice(0, 200)}；当前 ${JSON.stringify(await day(page))}`);
    await page.screenshot({ path: `${OUT}/taiwan-2-saved.png` });
    const end = await runUntil(page, async () => false, 1_500_000);
    const over = await page.evaluate(() => window.__rich4.store.game.getState().over);
    log(`第一局结束：${JSON.stringify(end)} over=${JSON.stringify(over)?.slice(0, 300)}`);
    await sleep(page, 2000);
    await page.screenshot({ path: `${OUT}/taiwan-3-over.png` });
    // 读档继续
    await page.evaluate(() => window.__rich4.client.leaveRoom()).catch(() => {});
    await loadInNewRoom(page, '集成回归-台湾');
    const fly2 = await startAndSkipFly(page);
    log(`读档开局：飞行动画=${fly2}（应为 false），${JSON.stringify(await day(page))}`);
    await page.screenshot({ path: `${OUT}/taiwan-4-loaded.png` });
    const end2 = await runUntil(page, async () => false, 1_500_000);
    const over2 = await page.evaluate(() => window.__rich4.store.game.getState().over);
    log(`读档局结束：${JSON.stringify(end2)} over=${JSON.stringify(over2)?.slice(0, 300)}`);
    await page.screenshot({ path: `${OUT}/taiwan-5-over.png` });
  } finally {
    const errs = errors.filter((e) => !/favicon|WebGL|GPU stall|autoplay/i.test(e));
    log(`台湾回归 控制台错误 ${errs.length} 条${errs.length ? `：${errs.slice(0, 6).join(' | ')}` : ''}`);
    await context.close();
  }
}

async function modeOldSave(browser) {
  const text = readFileSync(arg('--file', '.cache/maps/final/old-taiwan.r4save'), 'utf8');
  const { context, page, errors } = await newPage(browser);
  try {
    await page.goto(`${BASE}/?audio=off&test=1`);
    await waitAttr(page, 'screen-home', 'data-screen', 'title');
    // 玩家令牌在首次联网时才生成：没有就先按客户端的格式（16 字节 base64url）写一个再刷新
    const has = await page.evaluate(() => localStorage.getItem('rich4.token'));
    if (!has) {
      await page.evaluate(() => {
        const b = crypto.getRandomValues(new Uint8Array(16));
        const t = btoa(String.fromCharCode(...b)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        localStorage.setItem('rich4.token', t);
      });
      await page.reload();
      await waitAttr(page, 'screen-home', 'data-screen', 'title');
    }
    const imp = await page.evaluate(async (t) => {
      const token = localStorage.getItem('rich4.token');
      const r = await fetch('/api/saves/import', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-player-token': token ?? '' },
        body: t,
      });
      return { status: r.status, body: await r.json() };
    }, text);
    log(`导入旧存档：${JSON.stringify(imp).slice(0, 400)}`);
    const saveId = imp?.body?.data?.saveId;
    const { room } = await loadInNewRoom(page, null, { saveId });
    await page.screenshot({ path: `${OUT}/oldsave-1-room.png` });
    const fly = await startAndSkipFly(page);
    const d0 = await day(page);
    const mapId = await page.evaluate(() => window.__rich4.store.game.getState().latest?.dataRef ?? null);
    log(`旧存档开局：飞行动画=${fly}（应为 false），${JSON.stringify(d0)}，dataRef ${JSON.stringify(mapId)}，房间地图 ${room?.settings?.game?.mapId}`);
    await page.screenshot({ path: `${OUT}/oldsave-2-game.png` });
    const st = await runUntil(page, async (s) => (s.elapsed ?? 0) >= (d0?.elapsed ?? 0) + 3, 600_000);
    log(`旧存档继续玩到：${JSON.stringify(st)}`);
    await page.screenshot({ path: `${OUT}/oldsave-3-later.png` });
    await page.evaluate(() => window.__rich4.client.autopilot(false));
  } finally {
    const errs = errors.filter((e) => !/favicon|WebGL|GPU stall|autoplay/i.test(e));
    log(`旧存档 控制台错误 ${errs.length} 条${errs.length ? `：${errs.slice(0, 6).join(' | ')}` : ''}`);
    await context.close();
  }
}

async function modeOldPack(browser) {
  for (const map of ['taiwan', 'china', 'japan', 'usa']) {
    const { context, page, errors } = await newPage(browser);
    try {
      await createGame(page, map);
      const bg = await tid(page, 'setup-bg').getAttribute('data-image');
      await page.screenshot({ path: `${OUT}/oldpack-${map}-1-room.png` });
      const fly = await startAndSkipFly(page);
      await sleep(page, 2000);
      const skin = await page.evaluate(() => window.__rich4.skin);
      await page.screenshot({ path: `${OUT}/oldpack-${map}-2-game.png` });
      // 日历节日插画：新图的插画条目旧包里没有，应回退为节日名
      const hol = { taiwan: 19981010, china: 19981001, japan: 19981225, usa: 19980704 }[map];
      await page.evaluate((d) => window.__rich4.client.debug({ op: 'setDate', date: d }), hol);
      await sleep(page, 2500);
      const cal = await page.evaluate(() => {
        const b = document.querySelector('[data-testid="classic-cal-bg"]');
        return b ? { bg: b.getAttribute('data-bg'), text: b.textContent?.trim().slice(0, 20) } : null;
      });
      await page.screenshot({ path: `${OUT}/oldpack-${map}-3-calendar.png` });
      const st = await runUntil(page, async (s) => (s.elapsed ?? 0) >= 2, 240_000);
      await page.evaluate(() => window.__rich4.client.autopilot(false));
      const errs = errors.filter((e) => !/favicon|WebGL|GPU stall|autoplay/i.test(e));
      log(
        `旧素材包 ${map}：大厅背景 ${bg}，飞行动画=${fly}，皮肤 ${JSON.stringify({ res: skin?.resolution, board: skin?.boardInUse, failed: skin?.failedGroups, packId: skin?.packId })}，日历 ${JSON.stringify(cal)}，托管后 ${JSON.stringify(st)}，控制台错误 ${errs.length} 条${errs.length ? `：${errs.slice(0, 4).join(' | ')}` : ''}`,
      );
    } catch (e) {
      log(`旧素材包 ${map} 失败：${e?.message ?? e}`);
      await page.screenshot({ path: `${OUT}/oldpack-${map}-zz-fail.png` }).catch(() => {});
    } finally {
      await context.close();
    }
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  if (MODE === 'taiwan') await modeTaiwan(browser);
  else if (MODE === 'oldsave') await modeOldSave(browser);
  else if (MODE === 'oldpack') await modeOldPack(browser);
  else throw new Error('用法：node test/maps-final-regress.mjs taiwan|oldsave|oldpack');
} finally {
  await browser.close();
  writeFileSync(`${OUT}/report-${MODE}.txt`, `${report.join('\n')}\n`);
}
