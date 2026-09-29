// 调试（左手模式镜头 insets 左右对调）：程序化布局 1280×800，两个真人（P2 另开页面，轮到自己时自动按默认应答）以便有计时，
// 等到 P1 的回合菜单（有中央倒计时），分别在右手 / 左手模式下量：
//   - 看得见的棋盘视口：侧栏（aside）以外、顶栏以下、底栏以上（= 中央倒计时层 decision-countdown-layer）的中心；
//   - 中央倒计时数字（decision-countdown）的中心；
//   - 镜头中心 camera.screenAnchor() 与跟随点（本人角色 screenPos 上抬 40）的画布坐标；
//   - 画布矩形（应铺满窗口，画布坐标 = 页面坐标）；
// 左手模式经界面切换：顶栏菜单 → 设置 → 左手模式 → 关闭。截图写到 .cache/left-hand-camera/。
// 先起本机开发服务：npm run dev（服务端 :3000，前端 :5173）。
// 用法：node test/left-hand-camera-probe.mjs [宽x高=1280x800]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.LH_BASE ?? 'http://localhost:5173';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x800').split('x').map(Number);
const OUT = '.cache/left-hand-camera';
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

async function driveB() {
  await pb.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const d = g?.decision;
    if (h?.eventPlayer?.idle && d && g.submitting === null) h.client.act(d.defaultIntent, d.decisionId);
  });
}

async function waitMyMenu() {
  for (let i = 0; i < 400; i++) {
    const ok = await pa.evaluate(() => {
      const h = window.__rich4;
      const g = h?.store?.game?.getState();
      return !!g && h.eventPlayer.idle && g.decision?.kind === 'TURN_MENU' && g.submitting === null;
    });
    if (ok) return;
    await driveB();
    await pa.waitForTimeout(300);
  }
  throw new Error('等不到 P1 的回合菜单');
}

async function measure(tag) {
  // 等镜头跟随收敛（lerp 0.12/帧；开局还有一段从全图 panTo 过来的镜头）：跟随点与镜头中心相差不到 1px 或超时 8 秒
  const t0 = Date.now();
  let settled = false;
  while (Date.now() - t0 < 8000) {
    settled = await pa.evaluate(() => {
      const h = window.__rich4;
      const s = h.renderer;
      const me = h.store.game.getState().decision?.seat ?? null;
      const a = me === null ? null : s.anchorPos({ seat: me });
      if (!a) return false;
      const f = s.camera.worldToScreen({ x: a.x, y: a.y - 10 });
      const c = s.camera.screenAnchor();
      return Math.hypot(f.x - c.x, f.y - c.y) < 1;
    });
    if (settled) break;
    await pa.waitForTimeout(200);
  }
  const settleMs = Date.now() - t0;
  const m = await pa.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { l: b.left, t: b.top, r: b.right, b: b.bottom, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2 };
    };
    const h = window.__rich4;
    const s = h.renderer;
    const g = h.store.game.getState();
    const me = g.decision?.seat ?? null;
    const actor = me === null ? null : s.anchorPos({ seat: me });
    // anchorPos(seat) = screenPos 上抬 30；跟随点 = screenPos 上抬 40
    const follow = actor ? s.camera.worldToScreen({ x: actor.x, y: actor.y - 10 }) : null;
    const game = document.querySelector('[data-testid="screen-game"]');
    return {
      leftAttr: game?.getAttribute('data-left'),
      win: [innerWidth, innerHeight],
      canvas: rect(document.querySelector('[data-testid="screen-game"] canvas')),
      aside: rect(document.querySelector('[data-testid="screen-game"] > aside')),
      layer: rect(document.querySelector('[data-testid="decision-countdown-layer"]')),
      countdown: rect(document.querySelector('[data-testid="decision-countdown"]')),
      anchor: s.camera.screenAnchor(),
      follow,
      corners: s.viewportCorners()?.map((c) => s.camera.worldToScreen(c)),
      zoom: s.camera.zoom,
    };
  });
  const d = (a, b) => (a && b ? Math.round(Math.hypot(a.x - b.cx, a.y - b.cy) * 10) / 10 : null);
  const summary = {
    tag,
    settled,
    settleMs,
    leftAttr: m.leftAttr,
    aside: m.aside && [Math.round(m.aside.l), Math.round(m.aside.r)],
    layerCentre: m.layer && [m.layer.cx, m.layer.cy],
    countdownCentre: m.countdown && [m.countdown.cx, m.countdown.cy],
    anchor: [m.anchor.x, m.anchor.y],
    follow: m.follow && [Math.round(m.follow.x * 10) / 10, Math.round(m.follow.y * 10) / 10],
    'anchor↔layer': d(m.anchor, m.layer),
    'anchor↔countdown': d(m.anchor, m.countdown),
    'follow↔countdown': d(m.follow, m.countdown),
    canvas: m.canvas && [m.canvas.l, m.canvas.t, m.canvas.r, m.canvas.b],
    minimapFrameOnScreen: m.corners?.map((c) => [Math.round(c.x), Math.round(c.y)]),
  };
  console.log(JSON.stringify(summary));
  await pa.screenshot({ path: `${OUT}/${tag}-${size[0]}x${size[1]}.png` });
  return summary;
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
}

await waitMyMenu();
const report = [];
report.push(await measure('right'));
await setLeftHanded(true);
await waitMyMenu();
report.push(await measure('left'));
await setLeftHanded(false);
await waitMyMenu();
report.push(await measure('right-again'));
writeFileSync(`${OUT}/report-${size[0]}x${size[1]}.json`, JSON.stringify(report, null, 2));
await browser.close();
