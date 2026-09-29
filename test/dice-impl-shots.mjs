// 掷骰修正的本机目视（原版皮肤 + 真实素材包；两个真人，P2 另开页面，轮到自己时按默认应答）。
// 步行 / 机车 / 汽车各掷一次：截图掷骰前、持骰动作中、骰子 FLC 中、点数面；采样本人与对手棋子的姿态库 / 帧号，
// 读 AudioEngine 的日志确认两声「咚」（sfx.010）的时刻。截图与报告写到 .cache/dice/impl/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；端口 3921 / 5921）：
//   (apps/server) PORT=3921 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5921 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=<repo>/rich4-assets RICH4_DATA_DIR=<repo>/rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=<repo>/.cache/dice/impl/data npx tsx src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:3921 npx vite --port 5921 --strictPort
// 用法：node test/dice-impl-shots.mjs [宽x高=1280x960] [--pacing=original|compact]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.DICE_BASE ?? 'http://localhost:5921';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x960').split('x').map(Number);
const PACING = args.find((a) => a.startsWith('--pacing='))?.slice('--pacing='.length) ?? 'original';
const OUT = PACING === 'original' ? '.cache/dice/impl' : `.cache/dice/impl/${PACING}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, pacing: PACING, steps: [] };
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
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`);
    if (m.type() === 'warning' && /未结束|超预算|handler 出错/.test(m.text())) errors.push(`warn: ${m.text().slice(0, 300)}`);
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
      decision: d ? { kind: d.kind, id: d.decisionId, dice: d.options?.dice ?? null } : null,
      submitting: g?.submitting ?? null,
    };
  });
}

async function probe(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const actors = (h.renderer?.board?.allActors?.() ?? []).map((a) => ({
      seat: a.seat,
      pose: a.poseKey ?? null,
      frame: a.frameIndex ?? null,
      walking: a.isWalking ?? null,
    }));
    const ov = document.querySelector('[data-testid="dice-overlay"]');
    const dc = document.querySelector('[data-testid="action-dice-count"]');
    const r = ov?.getBoundingClientRect();
    return {
      actors,
      overlay: ov
        ? {
            rolling: ov.getAttribute('data-rolling'),
            seat: ov.getAttribute('data-seat'),
            count: ov.getAttribute('data-count'),
            slot: ov.getAttribute('data-slot'),
            flic: ov.getAttribute('data-flic'),
            faces: [...ov.querySelectorAll('[data-testid="dice-face"]')].map(
              (f) => `${f.getAttribute('data-face')}@${f.querySelector('[data-sprite]')?.getAttribute('data-sprite')}`,
            ),
            rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
          }
        : null,
      slots: dc
        ? {
            value: dc.getAttribute('data-value'),
            slots: dc.getAttribute('data-slots'),
            dies: [...dc.querySelectorAll('[data-testid="dice-count-die"]')].map(
              (e) => `${e.getAttribute('data-frame')}${e.getAttribute('data-on') === 'true' ? '+' : '-'}`,
            ),
          }
        : null,
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
    await page.waitForTimeout(150);
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

/** 页面内逐帧采样（本人与对手棋子、骰子覆盖层），返回相对采样起点的时间线 */
async function startSampler(page, ms) {
  await page.evaluate((dur) => {
    const out = [];
    window.__diceSamples = out;
    window.__diceT0 = performance.now();
    const t0 = window.__diceT0;
    const tick = () => {
      const h = window.__rich4;
      const actors = (h.renderer?.board?.allActors?.() ?? []).map(
        (a) => `${a.seat}:${a.poseKey}#${a.frameIndex}${a.isWalking ? 'W' : ''}`,
      );
      const ov = document.querySelector('[data-testid="dice-overlay"]');
      out.push({
        t: Math.round(performance.now() - t0),
        actors,
        ov: ov ? `${ov.getAttribute('data-rolling') === 'true' ? 'rolling' : 'faces'}/${ov.getAttribute('data-count')}` : null,
      });
      if (performance.now() - t0 < dur) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
}

async function sampled(page) {
  return page.evaluate(() => ({ samples: window.__diceSamples ?? [], t0: window.__diceT0 ?? 0 }));
}

async function audioLog(page, t0) {
  return page.evaluate((base) => {
    const a = window.__rich4.audio;
    const l = a?.log ?? [];
    return (Array.isArray(l) ? l : [])
      .filter((e) => e.kind === 'sfx')
      .map((e) => ({ t: Math.round(e.t - base), op: e.op, key: e.key ?? '' }));
  }, t0);
}

/** 本人按 GO（强制点数）：掷骰前、持骰动作中、FLC 中、点数面各截一张；采样姿态与声音 */
async function rollAndCapture(tag, forced) {
  await myTurn();
  const seat = (await state(pa)).seat;
  await debug(pa, { op: 'forceNext', purpose: 'dice', values: forced });
  const st = await myTurn();
  log(`${tag} TURN_MENU options.dice ${JSON.stringify(st.decision.dice)}`);
  await pa.waitForTimeout(600);
  await startSampler(pa, 800);
  await pa.waitForTimeout(900);
  const idle = await sampled(pa);
  const mineIdle = [...new Set(idle.samples.map((s) => s.actors.find((a) => a.startsWith(`${seat}:`))))];
  report.steps.push({ name: `${tag}-idle`, mine: mineIdle });
  log(`${tag} 掷骰前 本人姿态（800ms 内去重）${JSON.stringify(mineIdle)}`);
  await shot(pa, `${tag}-1-before-roll`, { dice: st.decision.dice, mineIdle });
  await pa.evaluate(() => window.__rich4.audio?.clearLog?.());
  await startSampler(pa, 4500);
  await pa.getByTestId('action-roll').click({ timeout: 5000 });
  // 持骰动作中
  await pa.waitForFunction((s) => (window.__rich4.renderer?.board?.actor(s)?.poseKey ?? '').endsWith('.dice'), seat, {
    timeout: 10_000,
  });
  await pa.waitForTimeout(PACING === 'original' ? 200 : 100);
  await shot(pa, `${tag}-2-throw`);
  // 骰子 FLC 中
  await pa.waitForFunction(
    () => document.querySelector('[data-testid="dice-overlay"]')?.getAttribute('data-rolling') === 'true',
    null,
    { timeout: 10_000 },
  );
  await pa.waitForTimeout(PACING === 'original' ? 450 : 300);
  await shot(pa, `${tag}-3-flic`);
  // 点数面
  await pa.waitForFunction(
    () => document.querySelector('[data-testid="dice-overlay"]')?.getAttribute('data-rolling') === 'false',
    null,
    { timeout: 10_000 },
  );
  await pa.waitForTimeout(60);
  await shot(pa, `${tag}-4-faces`, { forced });
  await pa.waitForTimeout(3600);
  const tl = await sampled(pa);
  const audio = await audioLog(pa, tl.t0);
  // 时间线压缩：只记本人姿态与覆盖层变化的时刻
  const changes = [];
  let last = '';
  for (const s of tl.samples) {
    const mine = s.actors.find((a) => a.startsWith(`${seat}:`)) ?? '';
    const k = `${mine.replace(/#\d+/, '#')} ${s.ov ?? '-'}`;
    const kf = `${mine} ${s.ov ?? '-'}`;
    if (kf !== last) {
      if (k !== last.replace(/#\d+/, '#') || mine.includes('.dice')) changes.push(`${s.t} ${kf}`);
      last = kf;
    }
  }
  const rollAt = tl.samples.find((s) => s.ov?.startsWith('rolling'))?.t ?? null;
  const facesAt = tl.samples.find((s) => s.ov?.startsWith('faces'))?.t ?? null;
  const throwAt = tl.samples.find((s) => s.actors.some((a) => a.startsWith(`${seat}:`) && a.includes('.dice')))?.t ?? null;
  const knocks = audio.filter((e) => e.key === 'sfx.010' || e.key === 'zzfx.dice');
  const summary = {
    throwAt,
    rollAt,
    facesAt,
    knocks: knocks.map((k) => `${k.t} ${k.op} ${k.key}`),
    knockFromRoll: rollAt === null ? null : knocks.map((k) => k.t - rollAt),
    knockGap: knocks.length === 2 ? knocks[1].t - knocks[0].t : null,
  };
  report.steps.push({ name: `${tag}-timeline`, changes, audio, summary });
  log(`${tag} 时间线 ${JSON.stringify(summary)}`);
  log(`${tag} 变化 ${JSON.stringify(changes.slice(0, 40))}`);
  return seat;
}

// ── 建房：P1 建台湾图、不补电脑；P2 进房 ──
await pa.goto(`${BASE}/?test=1`);
await pa.getByTestId('home-nickname').fill('測試甲');
await pa.getByTestId('home-nickname').blur();
await pa.getByTestId('home-create').click();
await pa.getByTestId('set-map').selectOption('taiwan');
await pa.getByTestId('set-timer').selectOption('off');
await pa.getByTestId('set-ai-count').selectOption('0');
if (PACING !== 'original') await pa.getByTestId('set-pacing').selectOption(PACING);
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

// 步行（1 颗）
await rollAndCapture('walk', [3]);

// ── 对手回合、还没掷骰（P1 观看）：对手棋子静止 ──
holdB = true;
await waitDecision(pb, ['TURN_MENU'], 120_000, async () => {
  const s = await state(pa);
  if (s.idle && s.decision && s.submitting === null) await act(pa);
});
await pa.waitForTimeout(1200);
await startSampler(pa, 800);
await pa.waitForTimeout(900);
{
  const tl = await sampled(pa);
  const me = (await state(pa)).seat;
  const other = [...new Set(tl.samples.map((s) => s.actors.find((a) => !a.startsWith(`${me}:`))))];
  report.steps.push({ name: 'other-idle', other });
  log(`对手回合掷骰前 对手姿态（800ms 内去重）${JSON.stringify(other)}`);
}
await shot(pa, 'other-1-before-roll');
// 对手掷骰：P1 看到对手先播持骰动作
await startSampler(pa, 4500);
holdB = false;
await driveB();
await pa.waitForTimeout(4600);
{
  const tl = await sampled(pa);
  const seats = (await probe(pa)).actors.map((a) => a.seat);
  const me = (await state(pa)).seat;
  const other = seats.find((s) => s !== me);
  const changes = [];
  let last = '';
  for (const s of tl.samples) {
    const a = s.actors.find((x) => x.startsWith(`${other}:`)) ?? '';
    const k = `${a} ${s.ov ?? '-'}`;
    if (k !== last) {
      changes.push(`${s.t} ${k}`);
      last = k;
    }
  }
  report.steps.push({ name: 'other-roll', changes });
  log(`对手掷骰 时间线 ${JSON.stringify(changes.slice(0, 30))}`);
}

// 机车（2 颗）
{
  await myTurn();
  const seat = (await state(pa)).seat;
  await debug(pa, { op: 'give', seat, cards: [], items: [{ item: 5, qty: 1 }] });
  await myTurn();
  await act(pa, { type: 'USE_ITEM', item: 5, target: { t: 'none' } });
  await pa.waitForTimeout(2500);
}
await rollAndCapture('moto', [3, 4]);

// 汽车（3 颗）
{
  await myTurn();
  const seat = (await state(pa)).seat;
  await debug(pa, { op: 'give', seat, cards: [], items: [{ item: 6, qty: 1 }] });
  await myTurn();
  await act(pa, { type: 'USE_ITEM', item: 6, target: { t: 'none' } });
  await pa.waitForTimeout(2500);
}
await rollAndCapture('car', [2, 5, 6]);

report.errors = { P1: A.errors, P2: B.errors };
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/log.txt`, LOG.join('\n'));
log(`done → ${OUT}/report.json errors ${JSON.stringify(report.errors)}`);
await browser.close();
