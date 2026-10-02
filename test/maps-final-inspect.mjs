// 调试脚本（原版另外 3 张图接入的集成阶段）：对着本机集成服务（客户端 5815 → 服务端 3815，RICH4_DATA_DIR=rich4-data、
// RICH4_ASSETS_DIR=rich4-assets、RICH4_TEST_MODE=1、免门禁）用本机 Chrome 逐图巡检（verify-checklist §5.6）：
// 开局设置点关卡（勾、背景）→ 建房（补 3 个电脑）→ 选人大厅 → 开局飞行动画（播放、跳过）→ 原版棋盘（皮肤判定、对位）
// → 「地圖」大图 → 日历节日插画 → 股市行业图 → 天使卡把一条街升级、拍卖卡拍卖（拍卖缩图）→ 命运送进医院 / 监狱（按图文案、
// 被关棋子与同格棋子）→ 托管等出院 / 出狱（第一步方向）并统计小游戏 → 住宅 → 日本快艇段 → 存档缩图 → 长名称 → 程序化皮肤；
// 另测刷新不重播。截图与记录写到 .cache/maps/final/<out>/。
// 用法：node test/maps-final-inspect.mjs [--maps china,japan,usa,taiwan] [--phone china,japan,usa,taiwan] [--out inspect]
//        [--base http://localhost:5815] [--quick]（手机横屏只走开局设置 / 大厅 / 飞行动画 / 棋盘 / 日历 / 命运坐牢）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = arg('--base', 'http://localhost:5815');
const OUT = `.cache/maps/final/${arg('--out', 'inspect')}`;
const DATA = arg('--data', 'rich4-data/maps');
mkdirSync(OUT, { recursive: true });
const MAPS = arg('--maps', 'china,japan,usa,taiwan').split(',').filter(Boolean);
const PHONE = arg('--phone', 'china,japan,usa,taiwan').split(',').filter(Boolean);
const STAGE = { taiwan: 0, china: 1, japan: 2, usa: 3 };
const FLY = { taiwan: 'flytw', china: 'flychina', japan: 'flyjp', usa: 'flyus' };
/** 各图挑一个有插画的节日（日期 → 期望的节日插画键） */
const HOLIDAY = {
  taiwan: { date: 19981010, key: 'illustration.holiday.10' },
  china: { date: 19981001, key: 'illustration.holiday.33' },
  japan: { date: 19981225, key: 'illustration.holiday.61' },
  usa: { date: 19980704, key: 'illustration.holiday.75' },
};

const report = [];
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  report.push(line);
  console.log(line);
};
const flush = () => writeFileSync(`${OUT}/report.txt`, `${report.join('\n')}\n`);

function loadDef(map) {
  return JSON.parse(readFileSync(`${DATA}/${map}.map.json`, 'utf8'));
}

async function newPage(browser, viewport, skin = 'original') {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript((sk) => {
    localStorage.setItem('rich4.introSeen', '1');
    if (!localStorage.getItem('rich4.settings')) {
      localStorage.setItem('rich4.settings', JSON.stringify({ state: { nickname: '集成巡检', skin: sk }, version: 2 }));
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

const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
const sleep = (page, ms) => page.waitForTimeout(ms);

async function waitAttr(page, id, name, value, timeout = 20_000) {
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

const seqOf = (page) => page.evaluate(() => window.__rich4.store.game.getState().seq);

async function debugOp(page, op) {
  const s0 = await seqOf(page);
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r?.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 20_000 });
  await waitIdle(page);
}

/** 等本人的某种决策（缺省回合菜单） */
async function waitDecision(page, kinds = ['TURN_MENU'], timeout = 120_000) {
  await page.waitForFunction(
    (ks) => {
      const h = window.__rich4;
      const d = h?.store?.game?.getState().decision;
      return !!d && ks.includes(d.kind) && h.eventPlayer.idle;
    },
    kinds,
    { timeout },
  );
  return page.evaluate(() => window.__rich4.store.game.getState().decision.kind);
}

/** 提交 intent（用当前决策号），等 seq 前进、演出空闲 */
async function act(page, intent) {
  const s0 = await seqOf(page);
  const r = await page.evaluate((it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return h.client.act(it, d?.decisionId);
  }, intent);
  if (!r?.ok) throw new Error(`act ${JSON.stringify(intent)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
  await waitIdle(page);
}

async function mySeat(page) {
  return page.evaluate(() => {
    const r = window.__rich4.store.room.getState().room;
    return r?.you?.role === 'player' ? r.you.seat : null;
  });
}

async function me(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const r = h.store.room.getState().room;
    const seat = r?.you?.seat;
    const v = h.store.game.getState().latest;
    return v?.players.find((p) => p.seat === seat) ?? null;
  });
}

/** 镜头对准格 / 地块（暂停跟随） */
async function panTo(page, anchor, zoom) {
  await page.evaluate(
    async ([a, z]) => {
      const r = window.__rich4.renderer;
      if (!r) return;
      r.camera.onUserGesture();
      const p = r.anchorPos(a);
      if (!p) return;
      await r.camera.panTo(p, 0);
      if (z) await r.camera.zoomTo(z, 0);
    },
    [anchor, zoom ?? null],
  );
  await sleep(page, 700);
}

async function refollow(page) {
  await page.evaluate(() => window.__rich4.renderer?.camera.fitAll?.(0));
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

/** 工具列按钮：手机横屏可能收在「更多」里 */
async function clickTool(page, id) {
  const b = tid(page, id);
  if ((await b.count()) > 0 && (await b.first().isVisible())) {
    await b.first().click();
    return true;
  }
  const more = tid(page, 'tool-more');
  if ((await more.count()) > 0 && (await more.first().isVisible())) {
    await more.first().click();
    await sleep(page, 400);
    if ((await b.count()) > 0 && (await b.first().isVisible())) {
      await b.first().click();
      return true;
    }
  }
  return false;
}

async function closeTop(page) {
  await page.keyboard.press('Escape');
  await sleep(page, 500);
}

/** 找一个两邻格的格 X，它的一侧是 target：teleport 到 X（来路是另一侧），掷 1 点即踩上 target */
function approach(def, target) {
  for (const t of def.tiles) {
    const outs = t.links.filter((l) => !l.blocked).map((l) => l.to);
    if (outs.length !== 2 || !outs.includes(target)) continue;
    const prev = outs.find((x) => x !== target);
    if (def.tiles.find((x) => x.id === prev)?.kind === 'jail') continue;
    return { node: t.id, prev };
  }
  return null;
}

/** 一张图：开局设置 → 建房 → 大厅 → 开局飞行动画 → 棋盘各项巡检 */
async function runMap(browser, map, viewport, tag, full) {
  const def = loadDef(map);
  const P = `${tag}-${map}`;
  const { context, page, errors } = await newPage(browser, viewport);
  const res = { map, tag };
  try {
    await page.goto(`${BASE}/?audio=off&test=1`);
    await waitAttr(page, 'screen-home', 'data-screen', 'title', 30_000);
    await tid(page, 'home-create').click();
    await tid(page, 'screen-setup').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="set-map"]')?.value);
    const k = STAGE[map];
    await tid(page, `setup-stage-${k}`).click();
    await waitAttr(page, `setup-stage-${k}`, 'data-selected', 'true');
    const bg = await tid(page, 'setup-bg').getAttribute('data-image');
    const avail = [];
    for (let i = 0; i < 4; i++) avail.push(await tid(page, `setup-stage-${i}`).getAttribute('data-available'));
    const check = await page.evaluate((kk) => {
      const row = document.querySelector(`[data-testid="setup-stage-${kk}"]`);
      const stage = document.querySelector('[data-testid="screen-setup"]');
      const c = row?.querySelector('[data-sprite$="/8"]');
      if (!c || !stage) return null;
      const r = c.getBoundingClientRect();
      const st = (stage.querySelector('[data-stage]') ?? stage).getBoundingClientRect();
      return { sprite: c.getAttribute('data-sprite'), x: Math.round(r.left - st.left), y: Math.round(r.top - st.top), stageW: Math.round(st.width) };
    }, k);
    await sleep(page, 600);
    await shot(page, `${P}-01-setup`);
    res.setup = { setMap: await tid(page, 'set-map').inputValue(), bg, avail, check };
    log(`[${P}] 开局设置：${JSON.stringify(res.setup)}`);

    await tid(page, 'set-timer').selectOption('off');
    await tid(page, 'set-ai-count').selectOption('3');
    if ((await tid(page, 'set-pacing').count()) > 0) await tid(page, 'set-pacing').selectOption('compact');
    await tid(page, 'create-submit').click();
    await page.waitForURL(/\/r\/\d{6}/);
    await waitAttr(page, 'screen-room', 'data-screen', 'select');
    await page.evaluate(() => window.__rich4?.client?.updateSettings?.({ aiPace: 'fast' }));
    await tid(page, 'char-3').click();
    await sleep(page, 800);
    res.room = {
      bg: await tid(page, 'setup-bg').getAttribute('data-image'),
      tick: await tid(page, `setup-stage-${k}`).getAttribute('data-selected'),
    };
    await shot(page, `${P}-02-room`);
    log(`[${P}] 选人大厅：${JSON.stringify(res.room)}`);

    await tid(page, 'room-start').click();
    await tid(page, 'fly').waitFor({ timeout: 20_000 });
    const src = await tid(page, 'fly-video').getAttribute('src');
    const held = await page.evaluate(() => window.__rich4.client.player.held);
    await sleep(page, 2500);
    const playing = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="fly-video"]');
      return v ? { t: Number(v.currentTime.toFixed(2)), paused: v.paused, rs: v.readyState, w: v.clientWidth, h: v.clientHeight } : null;
    });
    await shot(page, `${P}-03-fly`);
    await tid(page, 'fly-skip').click();
    await tid(page, 'fly').waitFor({ state: 'detached' });
    res.fly = {
      src: src?.split('/').pop(),
      right: !!src?.includes(FLY[map]),
      held,
      playing,
      heldAfter: await page.evaluate(() => window.__rich4.client.player.held),
    };
    log(`[${P}] 飞行动画：${JSON.stringify(res.fly)}`);

    await tid(page, 'screen-game').waitFor();
    await waitIdle(page);
    await sleep(page, 1500);
    res.skin = await page.evaluate(() => window.__rich4.skin);
    await shot(page, `${P}-04-board`);
    log(`[${P}] 皮肤：${JSON.stringify(res.skin)}`);

    if (await clickTool(page, 'tool-bigmap')) {
      await sleep(page, 1000);
      await shot(page, `${P}-05-bigmap`);
      await clickTool(page, 'tool-bigmap');
      await sleep(page, 800);
    } else log(`[${P}] 没找到「地圖」按钮`);

    const h = HOLIDAY[map];
    await debugOp(page, { op: 'setDate', date: h.date });
    await sleep(page, 1200);
    res.calendar = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="classic-calendar"]');
      const b = document.querySelector('[data-testid="classic-cal-bg"]');
      return c
        ? {
            mode: c.getAttribute('data-mode'),
            holiday: c.getAttribute('data-holiday'),
            bg: b?.getAttribute('data-bg'),
            text: c.textContent?.replace(/\s+/g, ' ').slice(0, 40),
          }
        : null;
    });
    await shot(page, `${P}-06-calendar`);
    log(`[${P}] 日历 ${h.date}（期望插画 ${h.key}）：${JSON.stringify(res.calendar)}`);

    const seat = await mySeat(page);
    await waitDecision(page);

    if (full) {
      // 股市：挑电子业（日本 / 美国）或第一家有企业的股票看行业图
      const co = def.companies.find((c) => c.industry === 3) ?? def.companies[0];
      await tid(page, 'action-stock').click();
      const sheet = tid(page, 'turn-stock-sheet');
      await sheet.waitFor();
      await sleep(page, 800);
      await shot(page, `${P}-07-stock-list`);
      await tid(page, `stock-pick-${co.stockIndex}`).click();
      await sleep(page, 800);
      res.stock = await page.evaluate(() => {
        const e = document.querySelector('[data-testid="stock-industry"]');
        return e ? { sprite: e.getAttribute('data-sprite') } : null;
      });
      res.stock = { company: co.id, industry: co.industry, stockIndex: co.stockIndex, ...res.stock };
      await shot(page, `${P}-08-stock-detail`);
      log(`[${P}] 股市行业图：${JSON.stringify(res.stock)}`);
      if ((await tid(page, 'stock-back').count()) > 0) await tid(page, 'stock-back').click().catch(() => {});
      await sleep(page, 300);
      if ((await tid(page, 'stock-exit').count()) > 0) await tid(page, 'stock-exit').click().catch(() => {});
      await sleep(page, 500);
    }

    // 住宅与拍卖：站到一块无主住宅地上，天使卡 ×N 把整条街升级，再用拍卖卡拍卖脚下这块
    const latest = await page.evaluate(() => window.__rich4.store.game.getState().latest);
    const street = new Map();
    for (const l of def.lots) if (l.kind === 'land') street.set(l.streetId, [...(street.get(l.streetId) ?? []), l.id]);
    const occupied = new Set(latest.players.map((p) => p.node));
    const lotTile = def.tiles.find((t) => {
      const lot = t.ref?.lot;
      if (!lot || !lot.startsWith('L') || occupied.has(t.id)) return false;
      const L = def.lots.find((x) => x.id === lot);
      const st = latest.lands.find((x) => x.id === lot);
      return L && (street.get(L.streetId)?.length ?? 0) >= 3 && st && st.owner === null && st.level === 0;
    });
    const angels = full ? 5 : 2;
    if (lotTile) {
      const lot = lotTile.ref.lot;
      const nb = lotTile.links.find((l) => !l.blocked)?.to;
      await debugOp(page, { op: 'teleport', seat, node: lotTile.id, prev: nb });
      await debugOp(page, { op: 'setCash', seat, cash: 500000, deposit: null });
      // 牌堆里每种卡张数有限：能拿几张天使卡拿几张
      let gotAngels = 0;
      for (let i = 0; i < angels; i++) {
        try {
          await debugOp(page, { op: 'give', seat, cards: [9], items: [] });
          gotAngels++;
        } catch {
          break;
        }
      }
      if (full) await debugOp(page, { op: 'give', seat, cards: [8], items: [] }).catch((e) => log(`[${P}] 拍卖卡：${e.message}`));
      log(`[${P}] 拿到天使卡 ${gotAngels} 张`);
      await waitDecision(page);
      for (let i = 0; i < angels; i++) {
        const slot = await page.evaluate(
          () => window.__rich4.store.game.getState().decision.options.cards.find((r) => r.card === 9 && r.usable)?.slot,
        );
        if (slot === undefined) break;
        await act(page, { type: 'USE_CARD', slot, card: 9, target: { t: 'lot', lot, facility: null } });
        await waitDecision(page);
      }
      const lv = await page.evaluate((l) => window.__rich4.store.game.getState().latest.lands.find((x) => x.id === l), lot);
      await panTo(page, { lot }, null);
      await shot(page, `${P}-09-houses-angel`);
      res.houses = { lot, street: def.lots.find((x) => x.id === lot).streetId, level: lv?.level, owner: lv?.owner };
      log(`[${P}] 天使卡 ×${angels}：${JSON.stringify(res.houses)}`);
      if (full) {
        const slot = await page.evaluate(
          () => window.__rich4.store.game.getState().decision.options.cards.find((r) => r.card === 8)?.slot,
        );
        const s0 = await seqOf(page);
        await page.evaluate(
          ([sl]) => {
            const h = window.__rich4;
            const d = h.store.game.getState().decision;
            return h.client.act({ type: 'USE_CARD', slot: sl, card: 8, target: { t: 'underfoot', facility: null } }, d.decisionId);
          },
          [slot],
        );
        await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0);
        const watch = await tid(page, 'classic-auction-watch')
          .waitFor({ timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        await sleep(page, 900);
        res.auction = await page.evaluate(() => {
          const w = document.querySelector('[data-testid="classic-auction-watch"]');
          const art = w?.querySelector('[data-testid="auction-item"]');
          return w ? { lot: w.getAttribute('data-lot'), art: art?.getAttribute('data-sprite') ?? null } : null;
        });
        await shot(page, `${P}-10-auction`);
        log(`[${P}] 拍卖（旁观）：出现=${watch} ${JSON.stringify(res.auction)}`);
        await waitDecision(page, ['TURN_MENU'], 120_000);
        const after = await page.evaluate((l) => window.__rich4.store.game.getState().latest.lands.find((x) => x.id === l), lot);
        await panTo(page, { lot }, null);
        await shot(page, `${P}-11-houses-after-auction`);
        log(`[${P}] 拍卖后：${JSON.stringify(after)}`);
      }
    } else log(`[${P}] 没找到可用的无主住宅地`);

    // 命运：12 住院（桌面）/ 33 坐牢（手机，按图文案）
    const fateId = full ? 12 : 33;
    const fates = def.tiles.filter((t) => t.kind === 'fate');
    let path = null;
    for (const f of fates) {
      path = approach(def, f.id);
      if (path) break;
    }
    if (path) {
      await waitDecision(page);
      await debugOp(page, { op: 'stackDeck', deck: 'fate', ids: [fateId] });
      await debugOp(page, { op: 'teleport', seat, node: path.node, prev: path.prev });
      await debugOp(page, { op: 'forceNext', purpose: 'dice', values: [1] });
      await waitDecision(page);
      const logLen = await page.evaluate(() => window.__rich4.store.game.getState().log.length);
      const rolled = await page.evaluate(() => {
        const h = window.__rich4;
        const d = h.store.game.getState().decision;
        return h.client.act({ type: 'ROLL' }, d.decisionId);
      });
      let popText = null;
      let confinedLog = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 45_000) {
        const st = await page.evaluate((n) => {
          const e = document.querySelector('[data-testid="fate-popup"]');
          const lines = window.__rich4.store.game.getState().log.slice(n);
          return {
            pop: e ? e.innerText.replace(/\s+/g, ' ').slice(0, 120) : null,
            fate: lines.find((l) => l.type === 'FATE')?.text ?? null,
            confined: lines.find((l) => l.type === 'CONFINED')?.text ?? null,
          };
        }, logLen);
        if (st.pop && !popText) {
          popText = st.pop;
          await sleep(page, 300);
          await shot(page, `${P}-12-fate-${fateId}`);
        }
        if (st.confined) {
          confinedLog = { fate: st.fate, confined: st.confined };
          break;
        }
        await sleep(page, 200);
      }
      res.fate = { id: fateId, roll: rolled?.ok, popup: popText, ...confinedLog };
      log(`[${P}] 命运 ${fateId}：${JSON.stringify(res.fate)}`);
      // 等被关的演出（走进医院 / 监狱）播完就截图，不等全场空闲（电脑接着行动，关押天数会很快过去）
      await sleep(page, 2500);
      const m = await me(page);
      res.confined = { node: m?.node, st: m?.st, savedPrevNode: m?.savedPrevNode, prevNode: m?.prevNode };
      await panTo(page, { tile: m.node }, null);
      await shot(page, `${P}-13-confined`);
      // 另一名玩家停在同一格（看两个棋子怎么摆）
      const other = (seat + 1) % 4;
      await debugOp(page, { op: 'teleport', seat: other, node: m.node }).catch((e) => log(`[${P}] 同格传送：${e.message}`));
      await panTo(page, { tile: m.node }, null);
      await shot(page, `${P}-14-confined-shared`);
      const actors = await page.evaluate(() =>
        window.__rich4.renderer.board.allActors().map((a) => ({ seat: a.seat, tile: a.tile, confined: a.currentStatus?.confined ?? null })),
      );
      log(`[${P}] 被关：${JSON.stringify(res.confined)} 棋子：${JSON.stringify(actors)}`);

      if (full) {
        // 托管到出院 / 出狱，逐 150ms 读棋子所在格，记录获释后走的第一格；顺带统计托管期间的日志
        const logLen0 = await page.evaluate(() => window.__rich4.store.game.getState().log.length);
        await page.evaluate(() => window.__rich4.client.autopilot(true));
        const holdNode = m.node;
        const t1 = Date.now();
        let released = null;
        while (Date.now() - t1 < 300_000) {
          const cur = await page.evaluate(
            (sq) => window.__rich4.renderer?.board.actor(sq)?.tile ?? null,
            seat,
          );
          if (cur !== null && cur !== holdNode) {
            released = { firstStep: cur, afterS: Math.round((Date.now() - t1) / 1000) };
            break;
          }
          await sleep(page, 150);
        }
        const hold = def.tiles.find((t) => t.id === holdNode);
        res.release = { holdNode, neighbors: hold?.links.map((l) => l.to + (l.blocked ? 'x' : '')), ...released };
        log(`[${P}] 获释：${JSON.stringify(res.release)}`);
        await sleep(page, 45_000);
        const types = await page.evaluate(
          (n) => window.__rich4.store.game.getState().log.slice(n).map((l) => l.type),
          logLen0,
        );
        const count = {};
        for (const t of types) count[t] = (count[t] ?? 0) + 1;
        res.logTypes = count;
        log(`[${P}] 托管期间日志：${JSON.stringify(count)}`);
        await page.evaluate(() => window.__rich4.client.autopilot(false));
        await sleep(page, 1500);
        // 住宅：找等级最高的地块
        const lands = await page.evaluate(() => window.__rich4.store.game.getState().latest.lands);
        const best = [...lands].filter((l) => l.owner !== null && l.level > 0).sort((a, b) => b.level - a.level);
        log(`[${P}] 有主且有房的地块：${best.length}，最高 ${JSON.stringify(best.slice(0, 4).map((l) => [l.id, l.owner, l.level]))}`);
        for (const [i, l] of best.slice(0, 2).entries()) {
          await panTo(page, { lot: l.id }, null);
          await shot(page, `${P}-15-houses-${i}`);
        }
      }
    } else log(`[${P}] 没找到命运格的来路`);

    if (map === 'japan') {
      await panTo(page, { tile: 26 }, null);
      await shot(page, `${P}-16-boat`);
    }

    if (full) {
      if (await clickTool(page, 'tool-save')) {
        await tid(page, 'classic-saves').waitFor({ timeout: 10_000 }).catch(() => {});
        await sleep(page, 800);
        res.saveThumb = await page.evaluate(() => {
          const s = document.querySelector('[data-testid="classic-saves"]');
          return s ? [...s.querySelectorAll('[data-sprite]')].map((e) => e.getAttribute('data-sprite')) : null;
        });
        await shot(page, `${P}-17-save`);
        log(`[${P}] 存档窗：${JSON.stringify(res.saveThumb)}`);
        await closeTop(page);
      }
      if (map === 'usa') {
        const lv = def.lots.find((l) => l.nameKey && /L\d+$/.test(l.id) && l.kind === 'land' && (def.strings?.[l.nameKey] ?? '').includes('拉斯'));
        const lotId = lv?.id ?? 'L1';
        await page.evaluate((l) => window.__rich4.client.focusLot(l), lotId);
        await sleep(page, 1200);
        await shot(page, `${P}-18-lotinfo-${lotId}`);
        log(`[${P}] 地块信息 ${lotId}`);
        await closeTop(page);
      }
    }

    // 刷新：进页时对局已在进行，不重播飞行动画
    await page.reload();
    await tid(page, 'screen-game').waitFor({ timeout: 30_000 });
    await sleep(page, 2500);
    res.reloadNoFly = (await tid(page, 'fly').count()) === 0;
    log(`[${P}] 刷新后飞行动画：${res.reloadNoFly ? '不播（正确）' : '又播了（错误）'}`);

    if (full) {
      // 程序化皮肤看一遍棋盘
      await page.evaluate(() => {
        const raw = localStorage.getItem('rich4.settings');
        const o = raw ? JSON.parse(raw) : { state: {}, version: 2 };
        o.state.skin = 'procedural';
        localStorage.setItem('rich4.settings', JSON.stringify(o));
      });
      await page.reload();
      await tid(page, 'screen-game').waitFor({ timeout: 30_000 });
      await sleep(page, 4000);
      res.procedural = await page.evaluate(() => window.__rich4.skin?.boardInUse ?? null);
      await refollow(page);
      await sleep(page, 1200);
      await shot(page, `${P}-19-procedural`);
      log(`[${P}] 程序化皮肤：${res.procedural}`);
    }
    const errs = errors.filter((e) => !/favicon|WebGL|GPU stall|autoplay/i.test(e));
    res.errors = errs;
    log(`[${P}] 控制台错误 ${errs.length} 条${errs.length ? `：${errs.slice(0, 6).join(' | ')}` : ''}`);
  } catch (e) {
    log(`[${P}] 失败：${e?.message ?? e}`);
    await shot(page, `${P}-zz-fail`).catch(() => {});
    res.fail = String(e?.message ?? e);
  } finally {
    await context.close();
    flush();
  }
  return res;
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const all = [];
try {
  for (const m of MAPS) all.push(await runMap(browser, m, { width: 1280, height: 800 }, 'desktop', !process.argv.includes('--quick')));
  for (const m of PHONE) all.push(await runMap(browser, m, { width: 812, height: 375 }, 'phone', false));
} finally {
  await browser.close();
  writeFileSync(`${OUT}/results.json`, `${JSON.stringify(all, null, 2)}\n`);
  flush();
}
