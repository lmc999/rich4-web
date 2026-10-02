// 调研（进监狱 / 医院后人物位置的现状，只读）：两个真人（P2 页面 anim=instant、轮到自己时按默认应答），台湾图。
// ① P1 传送到 P2 所在格、用陷害卡把 P2 送进监狱 → 截图关押期间（镜头对准关押格 1 / 綠島景观 / 保释格 12）；
// ② 轮转到 P2 出狱（RELEASED / RETURNED）→ 截图出狱后的位置；
// ③ P1 用飞弹打 P2 所在格 → P2 住院 → 截图关押期间（关押格 23 / 醫院景观 / 出院格 16）→ 轮转到出院 → 截图。
// 每一步记录 view 里 P2 的 node / prevNode / st.jail / st.hospital 与棋盘上角色的 tile / 可见性 / 关押外观，
// 截图上用 DOM 标记标出关押格、保释（出院）格与景观坐标。产物写到 .cache/spj/jail/<皮肤>/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；调研端口 4013 / 6013）：
//   (apps/server) PORT=4013 HOST=127.0.0.1 PUBLIC_URL=http://localhost:6013 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=<repo>/rich4-assets RICH4_DATA_DIR=<repo>/rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=<repo>/.cache/spj/jail/data npx tsx src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:4013 npx vite --port 6013 --strictPort
// 用法：node test/jail-pos-probe.mjs [宽x高=1280x960] [--skin=original|procedural]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.JAIL_BASE ?? 'http://localhost:6013';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x960').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const OUT = `.cache/spj/jail/${SKIN}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, skin: SKIN, steps: [], trace: [] };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};

// 台湾图：关押格（type 8001/8002 节点）、落点码 4/5 的格（保释 / 出院手续格）
const TW = { jailHold: 1, jailGate: 12, hospitalHold: 23, hospitalGate: 16 };

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function newPage(name, query) {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  if (SKIN !== 'original') {
    await ctx.addInitScript((skin) => {
      try {
        if (!localStorage.getItem('rich4.settings'))
          localStorage.setItem('rich4.settings', JSON.stringify({ state: { skin }, version: 2 }));
      } catch {}
    }, SKIN);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { ctx, page, errors, name, query };
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
      skin: h?.skin?.boardInUse ?? null,
    };
  });
}

/** view 里各玩家的位置与关押计数；棋盘上角色的 tile、可见性、关押外观 */
async function probe(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h.store.game.getState();
    const v = g.view;
    const r = h.renderer;
    const actors = (r?.board?.allActors?.() ?? []).map((a) => ({
      seat: a.seat,
      tile: a.tile,
      visible: a.root.visible,
      confined: a.currentStatus?.confined ?? null,
    }));
    return {
      date: v?.clock?.date ?? null,
      cursor: v?.clock?.cursor ?? null,
      players: (v?.players ?? []).map((p) => ({
        seat: p.seat,
        node: p.node,
        prevNode: p.prevNode,
        jail: p.st?.jail ?? null,
        hospital: p.st?.hospital ?? null,
        returning: p.returning ?? null,
      })),
      actors,
    };
  });
}

/** 镜头对准某格（暂停跟随），标出若干格与景观坐标 */
async function frame(page, centerTile, marks) {
  await page.evaluate(
    async ({ centerTile, marks }) => {
      const r = window.__rich4.renderer;
      if (!r) return;
      r.camera.onUserGesture?.();
      const c = r.anchorPos({ tile: centerTile });
      if (c) await r.camera.panTo(c, 0);
      document.querySelectorAll('.jail-probe-mark').forEach((e) => e.remove());
      const canvas = document.querySelector('canvas');
      const cr = canvas?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const put = (p, text, color) => {
        if (!p) return;
        const el = document.createElement('div');
        el.className = 'jail-probe-mark';
        el.textContent = text;
        el.style.cssText = `position:fixed;left:${cr.left + p.x}px;top:${cr.top + p.y}px;transform:translate(-50%,-50%);z-index:99999;pointer-events:none;font:bold 12px sans-serif;color:#fff;background:${color};border:1px solid #000;border-radius:3px;padding:0 3px;opacity:.85`;
        document.body.appendChild(el);
      };
      for (const m of marks) {
        if (m.tile !== undefined) put(r.tileCanvasPos(m.tile), m.text, m.color);
        else if (m.landmark && r.boardView?.landmarkWorld) {
          // 原版棋盘：景观（医院 / 監獄建筑）的原版世界坐标 → 棋盘坐标 → 画布坐标
          const w = r.boardView.landmarkWorld(m.landmark);
          if (w) put(r.camera.worldToScreen(r.proj.projectPx(w)), m.text, m.color);
        }
      }
    },
    { centerTile, marks },
  );
  await page.waitForTimeout(400);
}

async function clearMarks(page) {
  await page.evaluate(() => document.querySelectorAll('.jail-probe-mark').forEach((e) => e.remove()));
}

let shotN = 0;
async function shot(page, name, centerTile, marks, extra = {}) {
  shotN++;
  const file = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  if (centerTile !== null) await frame(page, centerTile, marks);
  const p = await probe(page);
  await page.screenshot({ path: file });
  await clearMarks(page);
  report.steps.push({ name, file, probe: p, ...extra });
  log(`shot ${file} ${JSON.stringify(p.players)} actors=${JSON.stringify(p.actors)}`);
  return p;
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

const A = await newPage('P1', 'audio=off&test=1');
const B = await newPage('P2', 'anim=instant&audio=off&test=1');
const pa = A.page;
const pb = B.page;

/** P2 与 P1 的非 TURN_MENU 决策都按默认应答；P1 的 TURN_MENU 留给脚本 */
const driveB = async () => {
  const st = await state(pb);
  if (!st.idle || !st.decision || st.submitting !== null) return;
  await act(pb);
};
async function waitP1Menu(timeout = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await driveB();
    const s = await state(pa);
    if (s.idle && s.decision && s.submitting === null) {
      if (s.decision.kind === 'TURN_MENU' && s.decision.seat === s.seat) return s;
      await act(pa);
    }
    await pa.waitForTimeout(200);
  }
  await pa.screenshot({ path: `${OUT}/fail-menu.png` }).catch(() => {});
  throw new Error(`wait P1 menu timeout: ${JSON.stringify(await state(pa))}`);
}
/** 记录 P2 位置变化 */
let lastKey = '';
async function trace(tag) {
  const p = await probe(pa);
  const q = p.players.find((x) => x.seat === 1);
  const act1 = p.actors.find((x) => x.seat === 1);
  const key = JSON.stringify([q, act1?.tile, act1?.confined]);
  if (key !== lastKey) {
    lastKey = key;
    report.trace.push({ tag, date: p.date, p2: q, actor: act1 });
    log(`trace ${tag} date=${p.date} P2=${JSON.stringify(q)} actor=${JSON.stringify(act1)}`);
  }
  return q;
}

try {
  // ── 建房：P1 建台湾图、慢速、不补电脑；P2 进房 ──
  await pa.goto(`${BASE}/?${A.query}`);
  await pa.getByTestId('home-nickname').fill('測試甲');
  await pa.getByTestId('home-nickname').blur();
  await pa.getByTestId('home-create').click();
  await pa.getByTestId('set-map').selectOption('taiwan');
  await pa.getByTestId('set-timer').selectOption('slow');
  await pa.getByTestId('set-ai-count').selectOption('0');
  await pa.getByTestId('create-submit').click();
  await pa.waitForURL(/\/r\/\d{6}/);
  const code = /\/r\/(\d{6})/.exec(pa.url())[1];
  log(`room ${code}`);
  await pb.goto(`${BASE}/?${B.query}`);
  await pb.getByTestId('home-nickname').fill('測試乙');
  await pb.getByTestId('home-nickname').blur();
  await pb.goto(`${BASE}/r/${code}?${B.query}`);
  await pb.getByTestId('screen-room').waitFor();
  for (const [p, c] of [
    [pa, 2],
    [pb, 9],
  ]) {
    await p.getByTestId(`char-${c}`).click();
    if ((await p.getByTestId('screen-room').getAttribute('data-screen')) !== 'select') await p.getByTestId('char-select').click();
  }
  await pb.getByTestId('room-ready').click();
  await pa.waitForTimeout(500);
  await pa.getByTestId('room-start').click();
  await pa.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  await pb.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  await Promise.all([skipFly(pa), skipFly(pb)]);
  log(`skin ${JSON.stringify((await state(pa)).skin)}`);

  await waitP1Menu();
  await pa.waitForTimeout(1500);
  const me = (await state(pa)).seat;
  if (me !== 0) throw new Error(`P1 seat ${me}`);
  const jailMarks = [
    { tile: TW.jailHold, text: '关押格1', color: '#c0392b' },
    { tile: TW.jailGate, text: '保释格12', color: '#2c3e50' },
    { landmark: 'jail', text: '景观2綠島', color: '#8e44ad' },
  ];
  const hospMarks = [
    { tile: TW.hospitalHold, text: '关押格23', color: '#c0392b' },
    { tile: TW.hospitalGate, text: '出院格16', color: '#2c3e50' },
    { landmark: 'hospital', text: '景观1醫院', color: '#8e44ad' },
  ];
  await shot(pa, 'start', null, []);

  // ── ① 陷害卡：P1 传送到 P2 所在格，发卡，用在 P2 身上 ──
  // P2 首回合还没跳伞：先把两人都摆到 40 号格
  let pr = await probe(pa);
  await debug(pa, { op: 'teleport', seat: 1, node: 40 });
  await debug(pa, { op: 'teleport', seat: 0, node: 40 });
  await debug(pa, { op: 'give', seat: 0, cards: [17], items: [{ item: 7, qty: 1 }] });
  await waitP1Menu();
  const slot = await pa.evaluate(() => {
    const g = window.__rich4.store.game.getState();
    const p = g.view.players.find((x) => x.seat === 0);
    return p.cards.indexOf(17);
  });
  log(`frame slot ${slot}`);
  await act(pa, { type: 'USE_CARD', slot, card: 17, target: { t: 'actor', actor: { t: 'seat', seat: 1 } } });
  await waitP1Menu();
  await pa.waitForTimeout(1500);
  await trace('after-frame');
  await shot(pa, 'jail-confined-hold1', TW.jailHold, jailMarks);
  await shot(pa, 'jail-confined-gate12', TW.jailGate, jailMarks);

  // ── ② 轮转到 P2 出狱：P1 每回合掷骰（默认），P2 自动 ──
  let released = false;
  for (let round = 0; round < 12 && !released; round++) {
    await act(pa, { type: 'ROLL', dice: 1 });
    await waitP1Menu();
    const q = await trace(`round-${round}`);
    if (q.jail === 0) released = true;
  }
  await pa.waitForTimeout(1500);
  await shot(pa, 'jail-released-gate12', TW.jailGate, jailMarks);
  await shot(pa, 'jail-released-hold1', TW.jailHold, jailMarks);

  // ── ③ 飞弹打 P2 所在格：P2 住院（P1 若在窗内也会住院，先把 P1 传送到远处） ──
  pr = await probe(pa);
  const q2 = pr.players.find((x) => x.seat === 1);
  await debug(pa, { op: 'teleport', seat: 0, node: q2.node === 40 ? 60 : 40 });
  await waitP1Menu();
  await act(pa, { type: 'USE_ITEM', item: 7, target: { t: 'node', node: q2.node } });
  await waitP1Menu();
  await pa.waitForTimeout(1500);
  await trace('after-missile');
  await shot(pa, 'hosp-confined-hold23', TW.hospitalHold, hospMarks);
  await shot(pa, 'hosp-confined-gate16', TW.hospitalGate, hospMarks);
  released = false;
  for (let round = 0; round < 10 && !released; round++) {
    await act(pa, { type: 'ROLL', dice: 1 });
    await waitP1Menu();
    const q = await trace(`h-round-${round}`);
    if (q.hospital === 0) released = true;
  }
  await pa.waitForTimeout(1500);
  await shot(pa, 'hosp-released-gate16', TW.hospitalGate, hospMarks);
  await shot(pa, 'hosp-released-hold23', TW.hospitalHold, hospMarks);
} catch (e) {
  log(`FAILED ${e.stack ?? e}`);
  report.failed = String(e);
  await pa.screenshot({ path: `${OUT}/fail.png` }).catch(() => {});
}
report.errors = { P1: A.errors, P2: B.errors };
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/log.txt`, LOG.join('\n'));
log(`done → ${OUT}/report.json`);
await browser.close();
