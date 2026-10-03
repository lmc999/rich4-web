// 实施验证（监狱 / 医院获释留在关押格，VERIFY V-M7）：两个真人（P2 页面 anim=instant、轮到自己时按默认应答），截图坐牢 / 住院
// 期间、获释后（RETURNED 之后）与获释后第一次走出来的位置。从 jail-pos-probe.mjs 改写（同一套测试钩子）。
// - 台湾：陷害卡把 P2 送进监狱（关押格 1）→ 获释 → 沿监狱支线走出；飞弹打 P2 → 住院（关押格 23）→ 获释 → 沿医院支线走出；
// - 大陆：飞弹打 P2 → 住院（关押格 63，环路上，兼出院格）→ 获释 → 从 63 随机方向走出。
// 截图上用 DOM 标记标出关押格、保释（出院）格与景观坐标。产物写到 .cache/jail/impl/<图>-<皮肤>/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；实现端口 4111 / 6111），在仓库根目录：
//   PORT=4111 HOST=127.0.0.1 PUBLIC_URL=http://localhost:6111 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=./.cache/jail/impl/data npx tsx apps/server/src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:4111 npx vite --port 6111 --strictPort
// 用法：node test/jail-impl-shots.mjs [--map=taiwan|china] [--skin=original|procedural] [--fork=0|1] [宽x高=1280x960]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.JAIL_BASE ?? 'http://localhost:6111';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x960').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const MAP = args.find((a) => a.startsWith('--map='))?.slice(6) ?? 'taiwan';
/** 获释后第一次起步强制岔路下标（不给则随机）：环路上的关押格用来演示另一个方向 */
const FORK = args.find((a) => a.startsWith('--fork='))?.slice(7);
const OUT = `.cache/jail/impl/${MAP}-${SKIN}${FORK !== undefined ? `-fork${FORK}` : ''}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, skin: SKIN, map: MAP, steps: [], trace: [] };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};

// 各图的关押格（type 8001/8002 节点）与落点码 4/5 的格（保释 / 出院格）
const HOLDS = {
  taiwan: { jailHold: 1, jailGate: 12, hospitalHold: 23, hospitalGate: 16 },
  china: { jailHold: 144, jailGate: 28, hospitalHold: 63, hospitalGate: 63 },
};
const H = HOLDS[MAP];
if (!H) throw new Error(`unsupported map ${MAP}`);

/** 数据包里这张图的格子世界坐标（本机读取，不入库） */
const def = (() => {
  const d = JSON.parse(readFileSync(`rich4-data/maps/${MAP}.map.json`, 'utf8'));
  return d.def ?? d;
})();
const worldOf = (id) => def.tiles.find((t) => t.id === id).world;

/** 离 target 不远不近（在出手人的视窗里、在飞弹半宽 100 之外）的格，给飞弹的出手人站 */
function shooterSpot(target) {
  const w = worldOf(target);
  const ok = def.tiles
    .filter((t) => !t.noItems && t.ref?.landmark === undefined)
    .map((t) => ({ id: t.id, d: Math.max(Math.abs(t.world.x - w.x), Math.abs(t.world.y - w.y)) }))
    .filter((x) => x.d >= 140 && x.d <= 190)
    .sort((a, b) => a.d - b.d || a.id - b.id);
  if (ok.length === 0) throw new Error(`no shooter spot near ${target}`);
  return ok[0].id;
}

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

/** view 里各玩家的位置与关押计数；棋盘上角色的 tile、可见性、关押外观；日志里最近的出狱事件 */
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
    const tail = (g.log ?? []).filter((l) => l.type === 'RELEASED' || l.type === 'RETURNED').slice(-2);
    return {
      date: v?.clock?.date ?? null,
      players: (v?.players ?? []).map((p) => ({
        seat: p.seat,
        node: p.node,
        prevNode: p.prevNode,
        jail: p.st?.jail ?? null,
        hospital: p.st?.hospital ?? null,
        returning: p.returning ?? null,
      })),
      actors,
      releaseLog: tail.map((l) => l.type),
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
        el.style.cssText = `position:fixed;left:${cr.left + p.x}px;top:${cr.top + p.y + 18}px;transform:translate(-50%,0);z-index:99999;pointer-events:none;font:bold 12px sans-serif;color:#fff;background:${color};border:1px solid #000;border-radius:3px;padding:0 3px;opacity:.85`;
        document.body.appendChild(el);
      };
      for (const m of marks) {
        if (m.tile !== undefined) put(r.tileCanvasPos(m.tile), m.text, m.color);
        else if (m.landmark && r.boardView?.landmarkWorld) {
          const w = r.boardView.landmarkWorld(m.landmark);
          if (w) put(r.camera.worldToScreen(r.proj.projectPx(w)), m.text, m.color);
        }
      }
    },
    { centerTile, marks },
  );
  await page.waitForTimeout(500);
}

async function clearMarks(page) {
  await page.evaluate(() => document.querySelectorAll('.jail-probe-mark').forEach((e) => e.remove()));
}

let shotN = 0;
async function shot(page, name, centerTile, marks) {
  shotN++;
  const file = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  if (centerTile !== null) await frame(page, centerTile, marks);
  const p = await probe(page);
  await page.screenshot({ path: file });
  await clearMarks(page);
  report.steps.push({ name, file, probe: p });
  log(`shot ${file} P2=${JSON.stringify(p.players[1])} actor2=${JSON.stringify(p.actors.find((a) => a.seat === 1))}`);
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
let lastKey = '';
async function trace(tag) {
  const p = await probe(pa);
  const q = p.players.find((x) => x.seat === 1);
  const act1 = p.actors.find((x) => x.seat === 1);
  const key = JSON.stringify([q, act1?.tile, act1?.confined]);
  if (key !== lastKey) {
    lastKey = key;
    report.trace.push({ tag, date: p.date, p2: q, actor: act1, releaseLog: p.releaseLog });
    log(`trace ${tag} date=${p.date} P2=${JSON.stringify(q)} actor=${JSON.stringify(act1)} log=${p.releaseLog}`);
  }
  return q;
}

/** P1 每回合掷 1 颗骰子，直到 P2 的 counter 归零（获释并走回棋盘，又轮到 P1） */
async function untilReleased(where, tag) {
  for (let round = 0; round < 14; round++) {
    await act(pa, { type: 'ROLL', dice: 1 });
    await waitP1Menu();
    const q = await trace(`${tag}-${round}`);
    if (q[where] === 0) return q;
  }
  throw new Error(`${where} not released`);
}

/** P1 再掷一次：P2 的回合按默认掷骰，从关押格走出来（给了 --fork 时先强制 P2 起步的岔路） */
async function walkOut(tag) {
  await act(pa, { type: 'ROLL', dice: 1 });
  if (FORK !== undefined) {
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > 120_000) throw new Error('P2 menu timeout');
      const sb = await state(pb);
      if (sb.idle && sb.submitting === null && sb.decision?.seat === sb.seat) {
        if (sb.decision.kind === 'TURN_MENU') {
          await debug(pb, { op: 'forceNext', purpose: 'fork', values: [Number(FORK)] });
          await pb.waitForTimeout(300);
          await act(pb);
          break;
        }
        await act(pb);
      }
      const sa = await state(pa);
      if (sa.idle && sa.submitting === null && sa.decision?.seat === sa.seat && sa.decision.kind !== 'TURN_MENU') await act(pa);
      await pa.waitForTimeout(200);
    }
  }
  await waitP1Menu();
  return trace(tag);
}

async function missile(target) {
  await debug(pa, { op: 'teleport', seat: 1, node: target });
  await debug(pa, { op: 'teleport', seat: 0, node: shooterSpot(target) });
  await waitP1Menu();
  const r = await act(pa, { type: 'USE_ITEM', item: 7, target: { t: 'node', node: target } });
  log(`missile ${target} → ${JSON.stringify(r)}`);
  await waitP1Menu();
  await pa.waitForTimeout(1500);
}

try {
  // ── 建房：P1 建图、慢速、不补电脑；P2 进房 ──
  await pa.goto(`${BASE}/?${A.query}`);
  await pa.getByTestId('home-nickname').fill('測試甲');
  await pa.getByTestId('home-nickname').blur();
  await pa.getByTestId('home-create').click();
  await pa.getByTestId('set-map').selectOption(MAP);
  await pa.getByTestId('set-timer').selectOption('slow');
  await pa.getByTestId('set-ai-count').selectOption('0');
  await pa.getByTestId('create-submit').click();
  await pa.waitForURL(/\/r\/\d{6}/);
  const code = /\/r\/(\d{6})/.exec(pa.url())[1];
  log(`room ${code} map ${MAP}`);
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
  if ((await state(pa)).seat !== 0) throw new Error('P1 is not seat 0');
  await debug(pa, { op: 'clearBoard' });

  const jailMarks = [
    { tile: H.jailHold, text: `关押格${H.jailHold}`, color: '#c0392b' },
    { tile: H.jailGate, text: `保释格${H.jailGate}`, color: '#2c3e50' },
    { landmark: 'jail', text: '监狱景观', color: '#8e44ad' },
  ];
  const hospMarks = [
    { tile: H.hospitalHold, text: `关押格${H.hospitalHold}`, color: '#c0392b' },
    ...(H.hospitalGate !== H.hospitalHold ? [{ tile: H.hospitalGate, text: `出院格${H.hospitalGate}`, color: '#2c3e50' }] : []),
    { landmark: 'hospital', text: '医院景观', color: '#8e44ad' },
  ];

  if (MAP === 'taiwan') {
    // ── ① 陷害卡：P1、P2 都摆到 40 号格，P1 对 P2 用陷害卡 → 坐牢（关押格 1） ──
    await debug(pa, { op: 'teleport', seat: 1, node: 40 });
    await debug(pa, { op: 'teleport', seat: 0, node: 40 });
    await debug(pa, { op: 'give', seat: 0, cards: [17], items: [{ item: 7, qty: 2 }] });
    await waitP1Menu();
    const slot = await pa.evaluate(() => window.__rich4.store.game.getState().view.players.find((x) => x.seat === 0).cards.indexOf(17));
    await act(pa, { type: 'USE_CARD', slot, card: 17, target: { t: 'actor', actor: { t: 'seat', seat: 1 } } });
    await waitP1Menu();
    await pa.waitForTimeout(1500);
    await trace('after-frame');
    await shot(pa, 'jail-confined-hold1', H.jailHold, jailMarks);
    await untilReleased('jail', 'j-round');
    await pa.waitForTimeout(1500);
    await shot(pa, 'jail-released-hold1', H.jailHold, jailMarks);
    await shot(pa, 'jail-released-gate12-empty', H.jailGate, jailMarks);
    const q = await walkOut('jail-walk');
    await pa.waitForTimeout(1500);
    await shot(pa, `jail-walked-out-to-${q.node}`, q.node, jailMarks);

    // ── ② 飞弹：P2 摆到保释格 12，P1 在附近出手 → 住院（关押格 23） ──
    await missile(H.jailGate);
    await trace('after-missile');
    await shot(pa, 'hosp-confined-hold23', H.hospitalHold, hospMarks);
    await untilReleased('hospital', 'h-round');
    await pa.waitForTimeout(1500);
    await shot(pa, 'hosp-released-hold23', H.hospitalHold, hospMarks);
    await shot(pa, 'hosp-released-gate16-empty', H.hospitalGate, hospMarks);
    const q2 = await walkOut('hosp-walk');
    await pa.waitForTimeout(1500);
    await shot(pa, `hosp-walked-out-to-${q2.node}`, q2.node, hospMarks);
  } else {
    // ── 大陆：P2 摆到医院旁的 62，P1 在附近用飞弹 → 住院（关押格 63，环路上兼出院格） ──
    await debug(pa, { op: 'give', seat: 0, cards: [], items: [{ item: 7, qty: 2 }] });
    await missile(62);
    await trace('after-missile');
    await shot(pa, 'hosp-confined-hold63', H.hospitalHold, hospMarks);
    await untilReleased('hospital', 'h-round');
    await pa.waitForTimeout(1500);
    await shot(pa, 'hosp-released-hold63', H.hospitalHold, hospMarks);
    const q2 = await walkOut('hosp-walk');
    await pa.waitForTimeout(1500);
    await shot(pa, `hosp-walked-out-to-${q2.node}`, q2.node, hospMarks);
  }
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
