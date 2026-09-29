// 调试（左手模式镜头）：无头的第二个真人玩家，加入指定房间、选角色、准备，之后轮到自己时自动按默认应答，
// 让另一端（浏览器面板里手动操作的 P1）的决策有计时（只有一个真人时计时关闭）。跑满时长或 Ctrl+C 结束。
// 先起本机开发服务：npm run dev（前端 :5173）。
// 用法：node test/left-hand-camera-p2.mjs <房间号> [分钟=10]
import { chromium } from '@playwright/test';

const BASE = process.env.LH_BASE ?? 'http://localhost:5173';
const [code, minutes = '10'] = process.argv.slice(2);
if (!/^\d{6}$/.test(code ?? '')) throw new Error('用法：node test/left-hand-camera-p2.mjs <房间号> [分钟]');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
const pb = await ctx.newPage();
await pb.goto(`${BASE}/?test=1`);
await pb.getByTestId('home-nickname').fill('乙');
await pb.getByTestId('home-nickname').blur();
await pb.goto(`${BASE}/r/${code}?test=1`);
await pb.getByTestId('screen-room').waitFor();
await pb.getByTestId('char-9').click();
if ((await pb.getByTestId('screen-room').getAttribute('data-screen')) !== 'select') await pb.getByTestId('char-select').click();
await pb.getByTestId('room-ready').click();
console.log('P2 已准备');
const until = Date.now() + Number(minutes) * 60_000;
while (Date.now() < until) {
  await pb.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const d = g?.decision;
    if (h?.eventPlayer?.idle && d && g.submitting === null) h.client.act(d.defaultIntent, d.decisionId);
  });
  await pb.waitForTimeout(300);
}
await browser.close();
