// 调研（掷骰表现链路的现状，只读）：原版皮肤 + 真实素材包，两个真人（P2 另开页面，轮到自己时按默认应答）。
// 复现三处与原版不符：①还没掷骰人物就在播持骰动画；②掷骰音效；③机车 / 汽车时骰子盘仍只有一颗。
// 逐步采样本人与对手棋子的姿态库 / 帧号、GO 钮骰子数竖槽、骰子 FLC 覆盖层与音频日志，截图写到 .cache/dice/current/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；端口 3912 / 5912）：
//   (apps/server) PORT=3912 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5912 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=<repo>/rich4-assets RICH4_DATA_DIR=<repo>/rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=<repo>/.cache/dice/current/data npx tsx src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:3912 npx vite --port 5912 --strictPort
// 用法：node test/dice-current-shots.mjs [宽x高=1280x960] [--skin=original|procedural]（程序化写到 .cache/dice/current/procedural/）
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.DICE_BASE ?? 'http://localhost:5912';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x960').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const OUT = SKIN === 'original' ? '.cache/dice/current' : `.cache/dice/current/${SKIN}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, steps: [] };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

async function newPage(name) {
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
  return { ctx, page, errors, name };
}

const A = await newPage('P1');
const B = await newPage('P2');
const pa = A.page;
const pb = B.page;

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
      decision: d ? { kind: d.kind, id: d.decisionId, seat: d.seat, dice: d.options?.dice ?? null } : null,
      submitting: g?.submitting ?? null,
      skin: h?.skin ?? null,
    };
  });
}

/** 棋子、骰子覆盖层、GO 钮的现场（原版皮肤） */
async function probe(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const r = h.renderer;
    const actors = (r?.board?.allActors?.() ?? []).map((a) => ({
      seat: a.seat,
      pose: a.poseKey ?? a.currentPose ?? null,
      frame: a.frameIndex ?? null,
      facing: a.facing ?? null,
      walking: a.isWalking ?? null,
    }));
    const ov = document.querySelector('[data-testid="dice-overlay"]');
    const faces = ov ? ov.querySelectorAll('[data-testid], span, div').length : 0;
    const dice = h.store.ui?.getState?.().dice ?? null;
    const cnt = document.querySelector('[data-testid="action-dice-count"]');
    const choice = [1, 2, 3].map((n) => document.querySelector(`[data-testid="action-dice-${n}"]`)).filter(Boolean);
    const go = document.querySelector('[data-testid="action-roll"]');
    const view = h.store.game.getState().view;
    return {
      actors,
      uiDice: dice ? { faces: dice.faces, rolling: dice.rolling } : null,
      overlay: ov
        ? {
            rolling: ov.getAttribute('data-rolling'),
            flic: ov.getAttribute('data-flic'),
            sum: ov.getAttribute('data-sum'),
            canvas: !!ov.querySelector('canvas'),
            faceSprites: ov.querySelectorAll('[class*="diceFaces"] > *').length,
            nodes: faces,
          }
        : null,
      go: go ? { state: go.getAttribute('data-state'), frame: go.getAttribute('data-frame') } : null,
      diceCount: cnt
        ? {
            value: cnt.getAttribute('data-value'),
            active: cnt.getAttribute('data-active'),
            sprites: cnt.querySelectorAll('[data-testid="dice-count-sprite"]').length,
          }
        : null,
      diceChoice: choice.map((b) => `${b.getAttribute('data-testid')}:${b.getAttribute('aria-pressed')}:${b.disabled ? 'off' : 'on'}`),
      overlayText: ov ? ov.textContent : null,
      players: view?.players?.map((p) => ({ seat: p.seat, vehicle: p.vehicle, node: p.node })) ?? [],
    };
  });
}

async function rect(page, testId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }, testId);
}

let shotN = 0;
async function shot(page, name, extra = {}) {
  shotN++;
  const file = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  const p = await probe(page);
  await page.screenshot({ path: file });
  // GO 钮与骰子数竖槽的局部放大
  const go = await rect(page, 'action-roll');
  if (go) {
    const pad = 20;
    await page.screenshot({
      path: file.replace(/\.png$/, '.go.png'),
      clip: { x: Math.max(0, go.x - pad), y: Math.max(0, go.y - pad), width: go.w + pad * 2, height: go.h + pad * 2 },
    });
  }
  report.steps.push({ name, file, probe: p, ...extra });
  log(`shot ${file} ${JSON.stringify(p)} ${JSON.stringify(extra)}`);
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

let holdB = false;
async function driveB() {
  if (holdB) return;
  const st = await state(pb);
  if (!st.idle || !st.decision || st.submitting !== null) return;
  await act(pb);
}

async function waitDecision(page, kinds, timeout = 120_000, other = null) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await state(page);
    if (st.idle && st.decision && st.submitting === null && kinds.includes(st.decision.kind)) return st;
    if (other) await other();
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: `${OUT}/fail-${kinds[0]}.png` }).catch(() => {});
  throw new Error(`wait ${kinds} timeout: ${JSON.stringify(await state(page))}`);
}

const myTurn = () =>
  waitDecision(pa, ['TURN_MENU'], 180_000, async () => {
    await driveB();
    const s = await state(pa);
    if (s.idle && s.decision && s.submitting === null && s.decision.kind !== 'TURN_MENU') await act(pa);
  });

/** 在 ms 毫秒内每隔 step 采样一次本人与对手的棋子 */
async function sampleActors(page, ms, step = 60) {
  const out = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = await probe(page);
    out.push({ t: Date.now() - t0, actors: p.actors.map((a) => `${a.seat}:${a.pose}#${a.frame}${a.walking ? 'W' : ''}`) });
    await page.waitForTimeout(step);
  }
  return out;
}

async function audioLog(page) {
  return page.evaluate(() => {
    const a = window.__rich4.audio;
    const l = a?.log ?? [];
    return (Array.isArray(l) ? l : []).slice(-40).map((e) => `${Math.round(e.t)} ${e.kind}.${e.op} ${e.key ?? ''} ${e.detail ?? ''}`);
  });
}

async function clearAudio(page) {
  await page.evaluate(() => window.__rich4.audio?.clearLog?.());
}

/** 本人按 GO（强制点数），掷骰过程按时间点截图 */
async function rollAndCapture(tag, forced) {
  await myTurn();
  const seat = (await state(pa)).seat;
  await debug(pa, { op: 'forceNext', purpose: 'dice', values: forced });
  const st = await myTurn();
  log(`${tag} TURN_MENU options.dice ${JSON.stringify(st.decision.dice)}`);
  await shot(pa, `${tag}-before-roll`, { dice: st.decision.dice });
  report.steps.push({ name: `${tag}-idle-sample`, sample: await sampleActors(pa, 700) });
  await clearAudio(pa);
  const s0 = (await state(pa)).seq;
  await pa.getByTestId('action-roll').click({ timeout: 5000 });
  await pa.waitForFunction((s) => window.__rich4.store.game.getState().seq > s || !!document.querySelector('[data-testid="dice-overlay"]'), s0, { timeout: 10_000 }).catch(() => {});
  const t0 = Date.now();
  for (const at of [60, 200, 380, 560, 760, 1000, 1300]) {
    const wait = at - (Date.now() - t0);
    if (wait > 0) await pa.waitForTimeout(wait);
    await shot(pa, `${tag}-roll-t${at}`, { atMs: Date.now() - t0 });
  }
  report.steps.push({ name: `${tag}-audio`, audio: await audioLog(pa) });
  log(`${tag} audio ${JSON.stringify(await audioLog(pa))}`);
  return seat;
}

// ── 建房：P1 建台湾图 slow、不补电脑；P2 进房 ──
await pa.goto(`${BASE}/?test=1`);
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
await pb.goto(`${BASE}/?test=1`);
await pb.getByTestId('home-nickname').fill('測試乙');
await pb.getByTestId('home-nickname').blur();
await pb.goto(`${BASE}/r/${code}?test=1`);
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
log(`skin ${JSON.stringify((await state(pa)).skin)}`);

// ── A：等待掷骰（本人 TURN_MENU）：人物姿态 ──
const st1 = await myTurn();
await pa.waitForTimeout(1500);
await shot(pa, 'A-self-turn-menu', { decision: st1.decision });
report.steps.push({ name: 'A-self-idle-sample', sample: await sampleActors(pa, 1200) });

// 本人掷骰（步行，1 颗）
await rollAndCapture('B-walk', [3]);

// ── A'：对手回合、对手还没掷骰（P1 观看） ──
holdB = true;
await waitDecision(pb, ['TURN_MENU'], 120_000, async () => {
  const s = await state(pa);
  if (s.idle && s.decision && s.submitting === null) await act(pa);
});
await pa.waitForTimeout(1500);
await shot(pa, 'A-other-turn-before-roll');
report.steps.push({ name: 'A-other-idle-sample', sample: await sampleActors(pa, 1200) });
holdB = false;

// ── B：机车（2 颗） ──
{
  await myTurn();
  const seat = (await state(pa)).seat;
  await debug(pa, { op: 'give', seat, cards: [], items: [{ item: 5, qty: 1 }] });
  await myTurn();
  await act(pa, { type: 'USE_ITEM', item: 5, target: { t: 'none' } });
  await pa.waitForTimeout(2500);
}
await rollAndCapture('B-moto', [3, 4]);

// ── B：汽车（3 颗） ──
{
  await myTurn();
  const seat = (await state(pa)).seat;
  await debug(pa, { op: 'give', seat, cards: [], items: [{ item: 6, qty: 1 }] });
  await myTurn();
  await act(pa, { type: 'USE_ITEM', item: 6, target: { t: 'none' } });
  await pa.waitForTimeout(2500);
}
await rollAndCapture('B-car', [2, 5, 6]);

report.errors = { P1: A.errors, P2: B.errors };
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/log.txt`, LOG.join('\n'));
log(`done → ${OUT}/report.json`);
await browser.close();
