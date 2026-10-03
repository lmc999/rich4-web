// 整体验证（监狱 / 医院获释留在关押格，VERIFY V-M7）：真实素材包、原版皮肤，两个真人（P2 页面 anim=instant、按默认应答）。
// 每个场景：把 P2 关进去（坐牢：两人同格，P1 对 P2 用陷害卡；住院：P1 在旁边对 P2 所在格放飞弹）→ 截图关押期间 →
// P1 每回合掷 1 颗骰子直到 P2 获释（RELEASED / RETURNED）→ 截图获释后（关押格）与保释 / 出院大圆盘（关押格不同时）→
// P2 下一回合强制掷 1 点，记录从关押格出发的第一步；重复 --runs 次（同一局里反复关、放），看出发方向是否随机。
// 从 test/jail-impl-shots.mjs 改写（同一套测试钩子）。产物写到 .cache/jail/verify/shots/<图>-<场景>/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；验证端口 4121 / 6121），在仓库根目录：
//   PORT=4121 HOST=127.0.0.1 PUBLIC_URL=http://localhost:6121 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=./.cache/jail/verify/data npx tsx apps/server/src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:4121 npx vite --port 6121 --strictPort
// 用法：node test/jail-verify-shots.mjs --map=taiwan|china|japan|usa --kind=jail|hospital [--runs=3] [宽x高=1920x1080]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.JAIL_BASE ?? 'http://localhost:6121';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const MAP = args.find((a) => a.startsWith('--map='))?.slice(6) ?? 'taiwan';
const KIND = args.find((a) => a.startsWith('--kind='))?.slice(7) ?? 'jail';
const RUNS = Number(args.find((a) => a.startsWith('--runs='))?.slice(7) ?? '3');
const OUT = `.cache/jail/verify/shots/${MAP}-${KIND}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, map: MAP, kind: KIND, runs: [], steps: [] };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};

/** 数据包里这张图（本机读取，不入库）：关押格取地标 holdTile，保释 / 出院格取落点码 4 / 5 的最小 id */
const def = (() => {
  const d = JSON.parse(readFileSync(`rich4-data/maps/${MAP}.map.json`, 'utf8'));
  return d.def ?? d;
})();
const tileOf = (id) => def.tiles.find((t) => t.id === id);
const worldOf = (id) => tileOf(id).world;
const HOLD = def.landmarks.find((l) => l.kind === KIND).holdTile;
const GATE = Math.min(...def.tiles.filter((t) => t.landingCode === (KIND === 'jail' ? 4 : 5)).map((t) => t.id));
const nbOf = (id) => tileOf(id).links.filter((l) => !l.blocked).map((l) => l.to);
log(`map ${MAP} ${KIND}: hold ${HOLD} (邻格 ${nbOf(HOLD).join('/')}), gate ${GATE}`);

/** 普通地产 / 空地（落点码 0、可放物件），离关押格与保释格远一点 */
function plainSpot(avoid) {
  const far = (t) => avoid.every((a) => Math.hypot(t.world.x - worldOf(a).x, t.world.y - worldOf(a).y) > 400);
  const c = def.tiles.filter(
    (t) => t.landingCode === 0 && !t.noItems && (t.kind === 'property' || t.kind === 'plain') && t.links.length === 2 && far(t),
  );
  if (c.length === 0) throw new Error('no plain spot');
  return c[Math.floor(c.length / 2)].id;
}

/** P1 每回合掷骰前先摆到这里（两个邻格也都是落点码 0 的地产 / 空地），免得踩到命运、新闻等把自己关住或让 P2 多走几回合 */
const SAFE = (() => {
  const plain = (t) => t.landingCode === 0 && !t.noItems && (t.kind === 'property' || t.kind === 'plain');
  const far = (t) => [HOLD, GATE].every((a) => Math.hypot(t.world.x - worldOf(a).x, t.world.y - worldOf(a).y) > 400);
  const c = def.tiles.filter(
    (t) => plain(t) && far(t) && t.links.length === 2 && t.links.every((l) => !l.blocked && plain(tileOf(l.to)) && tileOf(l.to).links.length === 2),
  );
  if (c.length === 0) throw new Error('no safe spot');
  const t = c[Math.floor(c.length / 3)];
  return { node: t.id, prev: t.links[0].to };
})();
log(`P1 safe spot ${JSON.stringify(SAFE)}`);

/** 离 target 不远不近（在出手人的视窗里、在飞弹半宽 100 之外）的格，给飞弹的出手人站 */
function shooterSpot(target) {
  const w = worldOf(target);
  const ok = def.tiles
    .filter((t) => !t.noItems && t.ref?.landmark === undefined && t.id !== HOLD && t.id !== GATE)
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

/** view 里 P2 的位置与关押计数；棋盘上 P2 角色的 tile、可见性、关押外观；日志里最近的出狱事件 */
async function probe(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h.store.game.getState();
    const v = g.view;
    const r = h.renderer;
    const a = (r?.board?.allActors?.() ?? []).find((x) => x.seat === 1);
    const p = (v?.players ?? []).find((x) => x.seat === 1);
    const c = a?.currentStatus?.confined ?? null;
    return {
      date: v?.clock?.date ?? null,
      p2: p
        ? { node: p.node, prevNode: p.prevNode, jail: p.st?.jail ?? null, hospital: p.st?.hospital ?? null }
        : null,
      actor: a ? { tile: a.tile, visible: a.root.visible, confined: c ? (typeof c === 'string' ? c : c.where) : null } : null,
      releaseLog: (g.log ?? [])
        .filter((l) => l.type === 'RELEASED' || l.type === 'RETURNED')
        .slice(-2)
        .map((l) => l.type),
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
  await page.waitForTimeout(600);
}

let shotN = 0;
async function shot(page, name, centerTile, marks) {
  shotN++;
  const file = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  await frame(page, centerTile, marks);
  const p = await probe(page);
  await page.screenshot({ path: file });
  await page.evaluate(() => document.querySelectorAll('.jail-probe-mark').forEach((e) => e.remove()));
  report.steps.push({ name, file, probe: p });
  log(`shot ${file} ${JSON.stringify(p)}`);
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

/** P2 的决策按默认应答（walkOut 期间另行处理）；P1 的非 TURN_MENU 决策按默认应答 */
let p2Hook = null;
const driveB = async () => {
  const st = await state(pb);
  if (!st.idle || !st.decision || st.submitting !== null) return;
  if (p2Hook && st.decision.seat === st.seat && st.decision.kind === 'TURN_MENU') {
    const h = p2Hook;
    p2Hook = null;
    await h();
  }
  await act(pb);
};
async function waitP1Menu(timeout = 240_000) {
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

/** P1 每回合掷 1 颗骰子，直到 P2 的计数归零（获释、走回棋盘，又轮到 P1） */
async function untilReleased() {
  for (let round = 0; round < 20; round++) {
    await debug(pa, { op: 'teleport', seat: 0, node: SAFE.node, prev: SAFE.prev });
    await waitP1Menu();
    await act(pa, { type: 'ROLL', dice: 1 });
    await waitP1Menu();
    const p = await probe(pa);
    log(`round ${round} ${JSON.stringify(p)}`);
    if (p.p2[KIND] === 0) return p;
  }
  throw new Error(`${KIND} not released`);
}

/** P1 再掷一次；P2 的回合先强制掷 1 点（只走一步，看从关押格出发的方向，不强制岔路），然后按默认掷骰 */
async function walkOut() {
  p2Hook = async () => {
    await debug(pb, { op: 'forceNext', purpose: 'dice', values: [1] });
    await pb.waitForTimeout(300);
  };
  await debug(pa, { op: 'teleport', seat: 0, node: SAFE.node, prev: SAFE.prev });
  await waitP1Menu();
  await act(pa, { type: 'ROLL', dice: 1 });
  await waitP1Menu();
  if (p2Hook !== null) throw new Error('P2 turn menu not seen');
  return probe(pa);
}

async function confine() {
  if (KIND === 'jail') {
    // 两人同格，P1 对 P2 用陷害卡（17）→ 坐牢
    const spot = plainSpot([HOLD, GATE]);
    await debug(pa, { op: 'teleport', seat: 1, node: spot });
    await debug(pa, { op: 'teleport', seat: 0, node: spot });
    await debug(pa, { op: 'give', seat: 0, cards: [17], items: [] });
    await waitP1Menu();
    const slot = await pa.evaluate(() =>
      window.__rich4.store.game.getState().view.players.find((x) => x.seat === 0).cards.indexOf(17),
    );
    const r = await act(pa, { type: 'USE_CARD', slot, card: 17, target: { t: 'actor', actor: { t: 'seat', seat: 1 } } });
    log(`frame card at ${spot} → ${JSON.stringify(r)}`);
  } else {
    // P2 站在普通格，P1 在附近对那一格放飞弹（7）→ 住院
    const target = plainSpot([HOLD, GATE]);
    await debug(pa, { op: 'give', seat: 0, cards: [], items: [{ item: 7, qty: 1 }] });
    await debug(pa, { op: 'teleport', seat: 1, node: target });
    await debug(pa, { op: 'teleport', seat: 0, node: shooterSpot(target) });
    await waitP1Menu();
    const r = await act(pa, { type: 'USE_ITEM', item: 7, target: { t: 'node', node: target } });
    log(`missile ${target} → ${JSON.stringify(r)}`);
  }
  await waitP1Menu();
  await pa.waitForTimeout(1500);
  const p = await probe(pa);
  if (p.p2[KIND] === 0) throw new Error(`P2 not confined: ${JSON.stringify(p)}`);
  return p;
}

try {
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
  report.skin = (await state(pa)).skin;
  log(`skin ${JSON.stringify(report.skin)}`);
  await waitP1Menu();
  await pa.waitForTimeout(1500);
  if ((await state(pa)).seat !== 0) throw new Error('P1 is not seat 0');
  await debug(pa, { op: 'clearBoard' });

  const marks = [
    { tile: HOLD, text: `关押格${HOLD}`, color: '#c0392b' },
    ...(GATE !== HOLD ? [{ tile: GATE, text: `${KIND === 'jail' ? '保释' : '出院'}格${GATE}`, color: '#2c3e50' }] : []),
    { landmark: KIND, text: KIND === 'jail' ? '监狱景观' : '医院景观', color: '#8e44ad' },
  ];
  for (let run = 1; run <= RUNS; run++) {
    const c = await confine();
    const first = run === 1;
    if (first) await shot(pa, `confined-hold${HOLD}`, HOLD, marks);
    const rel = await untilReleased();
    await pa.waitForTimeout(1500);
    const atHold = first ? await shot(pa, `released-hold${HOLD}`, HOLD, marks) : await probe(pa);
    if (first && GATE !== HOLD) await shot(pa, `released-gate${GATE}-empty`, GATE, marks);
    const out = await walkOut();
    await pa.waitForTimeout(1500);
    const w = await shot(pa, `run${run}-walked-out-to-${out.p2.node}`, out.p2.node, marks);
    const r = {
      run,
      confined: c.p2,
      released: rel.p2,
      releasedActor: atHold.actor,
      firstStep: w.p2.node,
      firstStepPrev: w.p2.prevNode,
    };
    report.runs.push(r);
    log(`RUN ${JSON.stringify(r)}`);
  }
  const ok = report.runs.every(
    (r) => r.released.node === HOLD && r.releasedActor?.tile === HOLD && r.releasedActor?.confined === null && r.firstStepPrev === HOLD,
  );
  report.summary = {
    hold: HOLD,
    gate: GATE,
    neighbors: nbOf(HOLD),
    firstSteps: report.runs.map((r) => r.firstStep),
    allReleasedAtHold: ok,
  };
  log(`SUMMARY ${JSON.stringify(report.summary)}`);
} catch (e) {
  log(`FAILED ${e.stack ?? e}`);
  report.failed = String(e);
  await pa.screenshot({ path: `${OUT}/fail.png` }).catch(() => {});
}
report.errors = { P1: A.errors, P2: B.errors };
log(`console errors P1 ${A.errors.length} P2 ${B.errors.length}`);
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/log.txt`, LOG.join('\n'));
await browser.close();
