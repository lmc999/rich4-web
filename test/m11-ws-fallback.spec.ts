// 调试（M11 故障排查「WebSocket 被拦时降级长轮询」）：浏览器经 test/m11-ws-block-proxy.mjs（拦掉 WebSocket 升级、
// 其余请求转发给 Caddy 的本机代理）访问部署，确认前端退到长轮询：能进标题、建房进大厅，Socket.IO 全部走 transport=polling。
// （Chrome DevTools 的 Network.setBlockedURLs 拦不住 WebSocket 握手，所以用代理模拟。）配置见 test/m11-playwright.config.ts：
//   node test/m11-ws-block-proxy.mjs 18444 &
//   M11_BASE_URL=https://localhost:18444 npx playwright test -c test/m11-playwright.config.ts test/m11-ws-fallback.spec.ts
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PASS = readFileSync(join(root, '.cache/m11/passcode.txt'), 'utf8').trim();

test('WebSocket 被拦：退到长轮询，照样能建房进大厅', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const sio: { transport: string; status: number }[] = [];
  const wsTried: string[] = [];
  page.on('websocket', (ws) => wsTried.push(ws.url()));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/socket.io/')) sio.push({ transport: u.searchParams.get('transport') ?? '?', status: r.status() });
  });
  try {
    await page.goto('/?test=1&audio=off');
    await expect(page.getByTestId('access-gate')).toBeVisible();
    await page.getByTestId('access-passcode').fill(PASS);
    await page.getByTestId('access-submit').click();
    await page.waitForLoadState('load');
    await expect(page.getByTestId('intro')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('intro-skip').click();
    await expect(page.getByTestId('screen-home')).toHaveAttribute('data-screen', 'title', { timeout: 30_000 });
    await page.getByTestId('home-create').click();
    await expect(page.getByTestId('screen-setup')).toBeVisible();
    await page.getByTestId('create-submit').click();
    await page.waitForURL(/\/r\/\d{6}/, { timeout: 60_000 });
    await expect(page.getByTestId('screen-room')).toBeVisible();
    console.log(
      `[ws-fallback] 尝试过的 WebSocket ${wsTried.length} 次；socket.io 响应：${JSON.stringify(
        sio.reduce<Record<string, number>>((a, x) => {
          const k = `${x.transport}:${x.status}`;
          a[k] = (a[k] ?? 0) + 1;
          return a;
        }, {}),
      )}`,
    );
    expect(sio.filter((x) => x.transport === 'polling' && x.status === 200).length).toBeGreaterThan(0);
    expect(sio.filter((x) => x.transport === 'websocket' && x.status === 101)).toEqual([]);
    // 解散房间，不留给别的检查
    await page.evaluate(() => (window as unknown as { __rich4: { client: { req(e: string, p: object): unknown } } }).__rich4.client.req('room:dissolve', {}));
  } finally {
    await ctx.close();
  }
});
