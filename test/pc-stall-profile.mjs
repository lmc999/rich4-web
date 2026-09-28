// 调试：程序化皮肤开局后第一个本人回合前后的主线程长任务（联调时看到中央倒计时在第一回合停更数秒）。
// 用 CDP Profiler 采样「按 OK → 第一个回合菜单出现后 6 秒」，按函数汇总自身耗时；同时记 longtask。
// 需要 5501/3501 的本机服务（见 test/pc-final-check.mjs）。用法：node test/pc-stall-profile.mjs [宽x高=1920x1080] [--skin=procedural] [--two]
// --two：同一个浏览器里再开一个上下文当 P2（与 pc-final-check.mjs 相同的两页形态）
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.PC_BASE ?? 'http://localhost:5501';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'procedural';
const TWO = args.includes('--two');
const OUT = `.cache/pc/final/stall-${SKIN}-${size[0]}x${size[1]}${TWO ? '-two' : ''}`;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
await ctx.addInitScript((skin) => {
  if (skin !== 'original') localStorage.setItem('rich4.settings', JSON.stringify({ state: { skin }, version: 2 }));
  window.__longtasks = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
}, SKIN);
const page = await ctx.newPage();
try {
  await page.goto(`${BASE}/?test=1`);
  await page.getByTestId('home-nickname').fill('測試');
  await page.getByTestId('home-nickname').blur();
  await page.getByTestId('home-create').click();
  await page.getByTestId('set-map').selectOption('taiwan');
  await page.getByTestId('set-timer').selectOption('fast');
  await page.getByTestId('set-pacing').selectOption('compact');
  await page.getByTestId('set-ai-count').selectOption(TWO ? '2' : '3');
  await page.getByTestId('create-submit').click();
  await page.waitForURL(/\/r\/\d{6}/);
  await page.getByTestId('char-2').click();
  if (TWO) {
    const ctx2 = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
    await ctx2.addInitScript((skin) => {
      localStorage.setItem('rich4.introSeen', '1');
      if (skin !== 'original') localStorage.setItem('rich4.settings', JSON.stringify({ state: { skin }, version: 2 }));
    }, SKIN);
    const p2 = await ctx2.newPage();
    await p2.goto(`${BASE}/?test=1`);
    await p2.getByTestId('home-nickname').fill('測試乙');
    await p2.getByTestId('home-nickname').blur();
    await p2.goto(`${BASE}/r/${/\/r\/(\d{6})/.exec(page.url())[1]}?test=1`);
    await p2.getByTestId('char-9').click();
    await p2.getByTestId('room-ready').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="room-start"]')?.hasAttribute('disabled'));
  }
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  const t0 = await page.evaluate(() => performance.now());
  await page.getByTestId('room-start').click();
  await page.waitForFunction(
    () => window.__rich4?.store?.game?.getState()?.decision?.kind === 'TURN_MENU',
    undefined,
    { timeout: 60_000 },
  );
  const tTurn = await page.evaluate(() => performance.now());
  await page.waitForTimeout(6000);
  const { profile } = await cdp.send('Profiler.stop');
  const long = await page.evaluate(() => window.__longtasks);
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas;
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const f = n.callFrame;
    const k = `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/(src|node_modules|deps)\//, '$1/')}:${f.lineNumber + 1}`;
    self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  const lines = [
    `回合菜单出现 @ ${Math.round(tTurn - t0)}ms（相对按 OK）`,
    `longtask（≥200ms，相对按 OK）: ${JSON.stringify(long.filter((l) => l.dur >= 200).map((l) => `${Math.round(l.start - t0)}+${l.dur}`))}`,
    ...top.map(([k, v]) => `${v.toFixed(0).padStart(6)}ms  ${k}`),
  ];
  console.log(lines.join('\n'));
  writeFileSync(`${OUT}/summary.txt`, `${lines.join('\n')}\n`);
  writeFileSync(`${OUT}/profile.cpuprofile`, JSON.stringify(profile));
} finally {
  await browser.close();
}
