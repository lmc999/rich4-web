// 访问门禁的 E2E 助手（docs/design/original-skin.md U4；契约见 packages/shared/src/net/access.ts）。
// - 现有 spec 默认跑在 ACCESS_MODE=off 的服务器上，不需要口令；服务器开启门禁时设置 RICH4_E2E_PASSCODE，
//   room.ts 的 newPlayer 会在打开页面前用同一个 BrowserContext 调 POST /api/access 注入 cookie。
// - 远程模式（E2E_BASE_URL，见 remote.ts）：部署实例可能开着门禁（ACCESS_MODE=passcode）。口令取 E2E_PASSCODE；
//   newPlayer 先读 GET /api/access，门禁开着且未通过时才换 cookie（ensureAccess），没有门禁时不受影响；
//   实例开着门禁而没设口令时直接报错说明，而不是停在门禁页上等超时。
// - 门禁页（前端 AccessGate，A5）约定的 data-testid：access-gate（容器）、access-passcode（输入框）、
//   access-submit（提交按钮）、access-error（错误提示）。页面上还没有门禁页时，助手退回到在页面里直接调接口。
import { type BrowserContext, expect, type Page } from '@playwright/test';
import { E2E_REMOTE } from './remote';

/**
 * 服务器开启门禁时 E2E 使用的口令（未设置表示服务器 ACCESS_MODE=off）：本机原版皮肤配置设 RICH4_E2E_PASSCODE；
 * 远程模式取 E2E_PASSCODE（只在部署实例开着门禁时设置——lobby.spec 等据此判断邀请框是不是授权链接）
 */
export const E2E_PASSCODE: string | null =
  process.env.RICH4_E2E_PASSCODE || (E2E_REMOTE ? process.env.E2E_PASSCODE || null : null);

/** 在打开页面之前为整个 BrowserContext 取得访问 cookie（context.request 与页面共用 cookie） */
export async function grantAccess(context: BrowserContext, passcode: string): Promise<void> {
  const res = await context.request.post('/api/access', { data: { passcode } });
  expect(res.status(), `POST /api/access → ${res.status()} ${await res.text()}`).toBe(200);
}

/** 用 BrowserContext 的请求上下文读门禁状态（GET /api/access，与页面共用 cookie） */
async function contextAccess(context: BrowserContext): Promise<{ mode: string; granted: boolean }> {
  const res = await context.request.get('/api/access');
  const text = await res.text();
  expect(res.status(), `GET /api/access → ${res.status()} ${text}`).toBe(200);
  return (JSON.parse(text) as { data: { mode: string; granted: boolean } }).data;
}

/**
 * 远程模式：门禁开着且本上下文还没通过时用口令换 cookie，换完再读一次确认已通过；门禁关闭（mode=off）或已通过时什么都不做。
 * passcode 为 null 而实例开着门禁时报错，提示设置 E2E_PASSCODE。
 */
export async function ensureAccess(context: BrowserContext, passcode: string | null): Promise<void> {
  const st = await contextAccess(context);
  if (st.mode === 'off' || st.granted) return;
  if (!passcode) {
    throw new Error(`实例开着访问门禁（ACCESS_MODE=${st.mode}）：请用 E2E_PASSCODE 提供口令（或邀请码）`);
  }
  await grantAccess(context, passcode);
  expect(await contextAccess(context), '换取 cookie 后门禁状态').toMatchObject({ granted: true });
}

/** 页面在导航途中（门禁页通过后重新载入）：执行上下文被销毁的错误可以等页面载入后重试 */
function navigatedAway(e: unknown): boolean {
  return e instanceof Error && /Execution context was destroyed|navigat/i.test(e.message);
}

/** 在页面里读门禁状态（GET /api/access）；碰上页面正在跳转时等载入完成再读 */
export async function accessStatus(page: Page): Promise<{ mode: string; granted: boolean; kind: string | null }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(async () => {
        const r = await fetch('/api/access', { cache: 'no-store' });
        return ((await r.json()) as { data: { mode: string; granted: boolean; kind: string | null } }).data;
      });
    } catch (e) {
      if (attempt >= 3 || !navigatedAway(e)) throw e;
      await page.waitForLoadState('load');
    }
  }
}

/** 页面里 POST JSON（同源、带 cookie），返回状态码与响应体 */
export async function postJson(page: Page, url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return page.evaluate(
    async ([u, b]) => {
      const r = await fetch(u as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    [url, body] as const,
  );
}

/**
 * 在门禁页输入口令：有 AccessGate 时走界面；没有时（A5 之前）在页面里调 POST /api/access，然后刷新。
 * 返回是否走了界面。
 */
export async function enterPasscode(page: Page, passcode: string): Promise<boolean> {
  const gate = page.getByTestId('access-gate');
  const hasGate = await gate
    .waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (hasGate) {
    await page.getByTestId('access-passcode').fill(passcode);
    await page.getByTestId('access-submit').click();
    // 通过后门禁页保持显示直到重新载入的新页面接手（素材包原因则直接收起）
    await expect(gate).toBeHidden();
    await page.waitForLoadState('load');
    return true;
  }
  const r = await postJson(page, '/api/access', { passcode });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  await page.reload();
  return false;
}

/**
 * 房主取得房间邀请链接（站内路径 `/r/<code>#g=<token>`）：房间页的邀请框（data-testid invite-url，
 * data-grant="true" 表示已换成授权链接）就绪时读界面，否则在页面里调 POST /api/access/grant。
 * 授权只能兑换一次、30 分钟内有效（architecture §35）：一个链接只给一个受邀者；只读邀请框不算交出（框里的链接不变），
 * 点「复制」或打开二维码才会把它交出并换新。
 */
export async function grantLink(page: Page, code: string): Promise<{ path: string; token: string; viaUi: boolean }> {
  const box = page.getByTestId('invite-url');
  const viaUi = await expect(box)
    .toHaveAttribute('data-grant', 'true', { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  let path: string;
  if (viaUi) {
    const u = new URL(await box.inputValue(), page.url());
    path = `${u.pathname}${u.hash}`;
  } else {
    const r = await postJson(page, '/api/access/grant', { room: code });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    path = (r.json as { data: { path: string } }).data.path;
  }
  const m = /^\/r\/(\d{6})#g=([A-Za-z0-9_-]{43})$/.exec(path);
  expect(m?.[1], path).toBe(code);
  return { path, token: m![2]!, viaUi };
}

/**
 * 打开邀请链接之后：前端（A5）应读出 `#g=<token>` 并兑换；页面还不支持时由这里在页面里兑换片段中的 token 再刷新。
 * 返回是否由前端自己完成了兑换。
 */
export async function ensureGrantRedeemed(page: Page): Promise<boolean> {
  const byClient = await expect
    .poll(async () => (await accessStatus(page)).granted, { timeout: 3000 })
    .toBe(true)
    .then(() => true)
    .catch(() => false);
  if (byClient) return true;
  const r = await page.evaluate(async () => {
    const m = /(?:^#|&)g=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
    if (!m) return { status: 0, json: 'no #g= fragment' as unknown };
    const res = await fetch('/api/access/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: m[1] }),
    });
    return { status: res.status, json: (await res.json()) as unknown };
  });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  await page.reload();
  return false;
}

/**
 * 用裸 WebSocket 在页面里试一次 Socket.IO 握手（带页面的 cookie），返回握手错误码或 'connected'。
 * 故意用 protocolVersion 0：通过门禁的握手会以 PROTOCOL_MISMATCH 失败，没通过的以 ACCESS_REQUIRED 失败（门禁先判）。
 */
export async function probeHandshake(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${location.host}/socket.io/?EIO=4&transport=websocket`);
        const done = (r: string) => {
          clearTimeout(timer);
          ws.close();
          resolve(r);
        };
        const timer = setTimeout(() => done('timeout'), 5000);
        ws.onmessage = (ev) => {
          const m = String(ev.data);
          if (m === '2') ws.send('3');
          else if (m.startsWith('0')) {
            const auth = {
              token: 'probeprobeprobeprobe00',
              nickname: 'probe',
              protocolVersion: 0,
              clientVersion: 'e2e',
            };
            ws.send(`40${JSON.stringify(auth)}`);
          } else if (m.startsWith('40')) done('connected');
          else if (m.startsWith('44')) {
            try {
              done((JSON.parse(m.slice(2)) as { data?: { code?: string } }).data?.code ?? 'error');
            } catch {
              done('error');
            }
          }
        };
        ws.onerror = () => done('wserror');
      }),
  );
}
