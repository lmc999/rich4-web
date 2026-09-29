// 审查用（原版忠实度）：本机真实素材包、原版皮肤，量「掷骰那一刻」人物锚点在 640×480 舞台里的位置、棋盘缩放与舞台缩放、
// 骰子 FLC 框与点数面相对人物的位置，和原版假设（镜头 = 行动者世界坐标 → 人物锚点在舞台 (220,260)，exe 0x40d37f–0x40d394
// 调 fcn.00407ebd(p.x,p.y)；render.md §1.3 基准 (220,260)；FLC 画点 (136,48)+表 0x4730ac）比较。
// 服务：3941 / 5941（本机例外，见 test/dice-verify-shots.mjs 头部的起法）。
// 用法：node test/dice-review-fidelity.mjs [宽x高=1280x960] [--mobile] [--name=desktop]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.DICE_BASE ?? 'http://localhost:5941';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x960').split('x').map(Number);
const MOBILE = args.includes('--mobile');
const NAME = args.find((a) => a.startsWith('--name='))?.slice('--name='.length) ?? `${size[0]}x${size[1]}`;
const OUT = `.cache/dice/review/${NAME}`;
mkdirSync(OUT, { recursive: true });
const report = { size, mobile: MOBILE, samples: [] };
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${s}`);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({
  viewport: { width: size[0], height: size[1] },
  deviceScaleFactor: MOBILE ? 2 : 1,
  ...(MOBILE ? { isMobile: true, hasTouch: true } : {}),
});
await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

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
      players: (g?.view?.players ?? []).map((p) => ({ seat: p.seat, vehicle: p.vehicle, node: p.node })),
    };
  });
}
async function act(intent = null) {
  return page.evaluate((it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(it ?? d.defaultIntent, d.decisionId) : null;
  }, intent);
}
async function debug(op) {
  const s0 = (await state()).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
}
async function myTurn(timeout = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await state();
    if (st.idle && st.decision && st.submitting === null) {
      if (st.decision.kind === 'TURN_MENU') return st;
      await act();
    }
    await page.waitForTimeout(120);
  }
  throw new Error('myTurn timeout');
}

/** 舞台换算（GO 钮 GO_RECT = (360,400,72,67)）、棋盘缩放、人物锚点（boardPos）在舞台坐标里的位置 */
async function measure(seat) {
  return page.evaluate((s) => {
    const h = window.__rich4;
    const surf = h.renderer;
    const go = document.querySelector('[data-testid="action-roll"]').getBoundingClientRect();
    const scale = go.width / 72;
    const ox = go.left - 360 * scale;
    const oy = go.top - 400 * scale;
    const toStage = (x, y) => ({ x: +((x - ox) / scale).toFixed(1), y: +((y - oy) / scale).toFixed(1) });
    const canvas = document.querySelector('[data-testid="screen-game"] canvas');
    const cr = canvas.getBoundingClientRect();
    const a = surf.anchorPos({ seat: s }); // = boardPos − 16
    const foot = { x: a.x, y: a.y + 16 };
    const sp = surf.camera.worldToScreen(foot);
    const anchorStage = toStage(cr.left + sp.x, cr.top + sp.y);
    const ov = document.querySelector('[data-testid="dice-overlay"]');
    const r = ov?.getBoundingClientRect();
    const flc = r ? { ...toStage(r.left, r.top), w: +(r.width / scale).toFixed(1), h: +(r.height / scale).toFixed(1) } : null;
    const faces = [...(ov?.querySelectorAll('[data-testid="dice-face"] [data-sprite]') ?? [])].map((e) => {
      const b = e.getBoundingClientRect();
      return { ...toStage(b.left, b.top), w: +(b.width / scale).toFixed(1), h: +(b.height / scale).toFixed(1) };
    });
    return {
      stageScale: +scale.toFixed(4),
      cameraZoom: +surf.camera.zoom.toFixed(4),
      canvasStage: { ...toStage(cr.left, cr.top), w: +(cr.width / scale).toFixed(1), h: +(cr.height / scale).toFixed(1) },
      anchorStage,
      slot: ov?.getAttribute('data-slot') ?? null,
      rolling: ov?.getAttribute('data-rolling') ?? null,
      flc,
      faces,
      actorScreenDir: surf.board.actor(s)?.screenDir ?? null,
    };
  }, seat);
}

// ── 建房：一个真人 + 一个电脑，台湾图 ──
await page.goto(`${BASE}/?test=1`);
await page.getByTestId('home-nickname').fill('審查乙');
await page.getByTestId('home-nickname').blur();
await page.getByTestId('home-create').click();
await page.getByTestId('set-map').selectOption('taiwan');
await page.getByTestId('set-timer').selectOption('off');
await page.getByTestId('set-ai-count').selectOption('1');
await page.getByTestId('create-submit').click();
await page.waitForURL(/\/r\/\d{6}/);
await page.getByTestId('char-2').click();
if ((await page.getByTestId('screen-room').getAttribute('data-screen')) !== 'select') await page.getByTestId('char-select').click();
await page.waitForTimeout(400);
await page.getByTestId('room-start').click();
await page.getByTestId('screen-game').waitFor({ timeout: 60_000 });
await page.waitForFunction(() => window.__rich4?.store?.game?.getState().view !== null && window.__rich4.eventPlayer.idle, null, { timeout: 60_000 });
report.skin = await page.evaluate(() => window.__rich4.skin);
log(`skin ${JSON.stringify(report.skin)}`);
await debug({ op: 'clearBoard' });

for (const [tag, forced] of [
  ['walk-a', [4]],
  ['walk-b', [2]],
]) {
  const st = await myTurn();
  await debug({ op: 'forceNext', purpose: 'dice', values: forced });
  await myTurn();
  await page.waitForTimeout(1500);
  const me = st.seat;
  const before = await measure(me);
  await page.screenshot({ path: `${OUT}/${tag}-1-before.png` });
  await page.getByTestId('action-roll').click({ timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="dice-overlay"]')?.getAttribute('data-rolling') === 'true', null, { timeout: 10_000 });
  await page.waitForTimeout(60);
  const rolling = await measure(me);
  await page.screenshot({ path: `${OUT}/${tag}-2-flic-start.png` });
  await page.waitForFunction(() => document.querySelector('[data-testid="dice-overlay"]')?.getAttribute('data-rolling') === 'false', null, { timeout: 10_000 });
  await page.waitForTimeout(60);
  const faces = await measure(me);
  await page.screenshot({ path: `${OUT}/${tag}-3-faces.png` });
  report.samples.push({ tag, before, rolling, faces });
  log(`${tag} ${JSON.stringify({ before, faces })}`);
  // 等本回合其余决策按默认应答、电脑回合走完
  await page.waitForTimeout(3000);
}

report.errors = errors;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
log(`done → ${OUT}/report.json errors ${JSON.stringify(errors)}`);
await browser.close();
