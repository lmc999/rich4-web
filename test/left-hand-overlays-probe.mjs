// 调试（左手模式 HUD 叠层居中）：程序化布局，两个真人（P2 另开页面，轮到自己时自动按默认应答）以便有计时，
// 分别在右手 / 左手模式下量回合横幅（turn-banner）、骰子（dice-overlay）、暂停条（paused-banner）的水平中心，
// 与看得见的棋盘视口（侧栏 aside 以外 = 中央倒计时层 decision-countdown-layer）的水平中心比较。
// 页面里用 rAF 轮询记下每个叠层每次出现时的矩形；横幅与骰子各截一张图，写到 .cache/left-hand-overlays/。
// 左手模式经界面切换：顶栏菜单 → 设置 → 左手模式 → 关闭。暂停条由房主 client.pause(true) 触发，量完恢复。
// 先起本机开发服务：npm run dev（服务端 :3000，前端 :5173）。
// 用法：node test/left-hand-overlays-probe.mjs [宽x高=1280x800]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.LH_BASE ?? 'http://localhost:5173';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x800').split('x').map(Number);
const OUT = '.cache/left-hand-overlays';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    localStorage.setItem('rich4.introSeen', '1');
    try {
      if (!localStorage.getItem('rich4.settings'))
        localStorage.setItem('rich4.settings', JSON.stringify({ state: { skin: 'procedural' }, version: 2 }));
    } catch {}
  });
  return ctx.newPage();
}

const pa = await newPage();
const pb = await newPage();
await pa.goto(`${BASE}/?test=1`);
await pa.getByTestId('home-nickname').fill('甲');
await pa.getByTestId('home-nickname').blur();
await pa.getByTestId('home-create').click();
await pa.getByTestId('set-timer').selectOption('slow');
await pa.getByTestId('set-ai-count').selectOption('0');
await pa.getByTestId('create-submit').click();
await pa.waitForURL(/\/r\/\d{6}/);
const code = /\/r\/(\d{6})/.exec(pa.url())[1];
await pb.goto(`${BASE}/?test=1`);
await pb.getByTestId('home-nickname').fill('乙');
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

// 页面内记录器：每个叠层元素第一次出现时记下它的矩形、当时的 data-left、侧栏与倒计时层的矩形
await pa.evaluate(() => {
  const ids = ['turn-banner', 'dice-overlay', 'paused-banner'];
  const seen = new WeakSet();
  window.__ovl = [];
  const tick = () => {
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const game = document.querySelector('[data-testid="screen-game"]');
      const b = el.getBoundingClientRect();
      const aside = game?.querySelector(':scope > aside')?.getBoundingClientRect();
      const layer = document.querySelector('[data-testid="decision-countdown-layer"]')?.getBoundingClientRect();
      const left = game?.getAttribute('data-left') === 'true';
      // 看得见的棋盘视口：侧栏以外那一块
      const boardCx = aside ? (left ? aside.right + (innerWidth - aside.right) / 2 : aside.left / 2) : null;
      window.__ovl.push({
        id,
        left,
        text: (el.textContent ?? '').slice(0, 16),
        cx: Math.round(((b.left + b.right) / 2) * 10) / 10,
        cy: Math.round(((b.top + b.bottom) / 2) * 10) / 10,
        boardCx,
        layerCx: layer ? (layer.left + layer.right) / 2 : null,
        aside: aside ? [Math.round(aside.left), Math.round(aside.right)] : null,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

async function drive(p) {
  await p.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const d = g?.decision;
    if (h?.eventPlayer?.idle && d && g.submitting === null && d.kind !== 'TURN_MENU') h.client.act(d.defaultIntent, d.decisionId);
  });
}

async function driveB() {
  await pb.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const d = g?.decision;
    if (h?.eventPlayer?.idle && d && g.submitting === null) h.client.act(d.defaultIntent, d.decisionId);
  });
}

const myMenuReady = () =>
  pa.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    return !!g && h.eventPlayer.idle && g.decision?.kind === 'TURN_MENU' && g.submitting === null;
  });

/** 推进到 P1 的回合菜单；途中第一次看见回合横幅时截图（tag 非空时） */
async function waitMyMenu(tag) {
  let shot = !tag;
  for (let i = 0; i < 600; i++) {
    if (!shot && (await pa.getByTestId('turn-banner').count())) {
      await pa.screenshot({ path: `${OUT}/${tag}-banner-${size[0]}x${size[1]}.png` });
      shot = true;
    }
    if (await myMenuReady()) return;
    await drive(pa);
    await driveB();
    await pa.waitForTimeout(150);
  }
  throw new Error('等不到 P1 的回合菜单');
}

/** 掷骰并在骰子出现时截图，然后推进到 P1 的下一个回合菜单（途中截回合横幅） */
async function rollCycle(tag) {
  await pa.getByTestId('action-roll').click();
  await pa
    .getByTestId('dice-overlay')
    .waitFor({ timeout: 10_000 })
    .catch(async (e) => {
      await pa.screenshot({ path: `${OUT}/${tag}-fail-${size[0]}x${size[1]}.png` });
      throw e;
    });
  await pa.screenshot({ path: `${OUT}/${tag}-dice-${size[0]}x${size[1]}.png` });
  await pa.waitForTimeout(1000);
  await waitMyMenu(tag);
}

async function pauseCycle(tag) {
  await pa.evaluate(() => window.__rich4.client.pause(true));
  await pa.getByTestId('paused-banner').waitFor({ timeout: 10_000 });
  await pa.waitForTimeout(300);
  await pa.screenshot({ path: `${OUT}/${tag}-paused-${size[0]}x${size[1]}.png` });
  await pa.evaluate(() => window.__rich4.client.pause(false));
  await pa.getByTestId('paused-banner').waitFor({ state: 'detached', timeout: 10_000 });
}

async function setLeftHanded(on) {
  await pa.getByTestId('top-menu').click();
  await pa.getByTestId('menu-settings').click();
  const box = pa.getByTestId('settings-left');
  if ((await box.isChecked()) !== on) await box.click();
  // 关掉设置与系统菜单
  for (let i = 0; i < 3; i++) {
    const close = pa.locator('[role="dialog"] button[aria-label]').last();
    if (!(await close.count())) break;
    await close.click();
    await pa.waitForTimeout(200);
  }
  await pa.waitForFunction(
    (v) => document.querySelector('[data-testid="screen-game"]')?.getAttribute('data-left') === v,
    on ? 'true' : 'false',
  );
}

await waitMyMenu();
await rollCycle('right');
await pauseCycle('right');
await setLeftHanded(true);
await waitMyMenu();
await rollCycle('left');
await pauseCycle('left');

const records = await pa.evaluate(() => window.__ovl);
const rows = records.map((r) => ({
  ...r,
  'cx-boardCx': r.boardCx === null ? null : Math.round((r.cx - r.boardCx) * 10) / 10,
  'cx-layerCx': r.layerCx === null ? null : Math.round((r.cx - r.layerCx) * 10) / 10,
}));
console.table(rows.map(({ id, left, text, cx, boardCx, layerCx, 'cx-boardCx': d1, 'cx-layerCx': d2 }) => ({ id, left, text, cx, boardCx, layerCx, 'cx-boardCx': d1, 'cx-layerCx': d2 })));
const bad = rows.filter((r) => r['cx-boardCx'] !== null && Math.abs(r['cx-boardCx']) > 1);
console.log(bad.length ? `✗ ${bad.length} 个叠层没居中在棋盘视口上` : '✓ 所有叠层都居中在看得见的棋盘视口上');
for (const [id, left] of [
  ['turn-banner', false],
  ['turn-banner', true],
  ['dice-overlay', false],
  ['dice-overlay', true],
  ['paused-banner', false],
  ['paused-banner', true],
])
  if (!rows.some((r) => r.id === id && r.left === left)) console.log(`! 没量到 ${id}（${left ? '左手' : '右手'}）`);
writeFileSync(`${OUT}/report-${size[0]}x${size[1]}.json`, JSON.stringify(rows, null, 2));
await browser.close();
