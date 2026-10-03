// 访问门禁 E2E（docs/design/original-skin.md U4、§5 A4）：
// 本 spec 自己起一个开启门禁的服务器（ACCESS_MODE=passcode、合成素材包、托管已构建的前端 apps/client/dist），
// 与 playwright.config 里 ACCESS_MODE=off 的默认服务器互不影响。
//   1) 无授权访问 /pack 与 /api 被拒，外壳页、健康检查、robots 公开；口令登录后 /pack 可用且头正确；
//   2) 打开首页即显示门禁页（bootstrapAccess），在门禁页输入口令进入；
//   3) 房间页邀请框直接给出授权链接（一个链接只给一个人：复制后框里换新，30 分钟、1 次），/r/<房间>#g=<token> 由前端兑换后
//      免口令进入；同一个链接第二个人打不开；受邀者不能再生成授权，也只能进那个房间（别的房间、单机、首页入口都被挡）；
//   4) 夹具注入口令（RICH4_E2E_PASSCODE 的路径）后直接建房；
//   5) 外部程序经管理接口签发的限时口令（uses 2、days 1）：登录后首页显示有效期，同一设备再进不消耗次数；停用这个口令后
//      该设备刷新即回到门禁页；
//   6) 旧格式（v1）的房间授权 cookie 失效，回到门禁页（architecture §35）；
//   7) 邀请链接会话在首页点「我有口令」输入口令：换成口令会话，首页恢复完整入口；
//   8) 邀请的房间结束（房主解散）后，访客首页不再给「回到房间」，提示要新链接或输入口令。
// 合成素材包（内容全是自绘图形）按需生成到 .cache/synthetic-pack；测试口令只在本进程内存里。
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, expect, request, test } from '@playwright/test';
import { hashPasscode } from '../../apps/server/src/access/passcode';
import {
  accessStatus,
  ensureGrantRedeemed,
  enterPasscode,
  grantLink,
  postJson,
  probeHandshake,
} from '../fixtures/access';
import { createRoom, newPlayer, Q } from '../fixtures/room';

/**
 * 本 spec 的服务器挂着合成素材包：通过门禁后的页面多半判成原版皮肤（繁体），门禁页与程序化画面是简体——文案两种写法都认
 */
const either = (cn: string, tw: string): RegExp => new RegExp(`${cn}|${tw}`);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACK_DIR = join(repoRoot, '.cache', 'synthetic-pack');
const CLIENT_DIST = join(repoRoot, 'apps', 'client', 'dist');
const PASS = 'e2e-access-passcode-7a4c';
// 门禁开启时 ADMIN_TOKEN 至少 32 字节（config.ts）
const ADMIN = 'e2e-admin-token-access-0123456789abcdef';

let server: ChildProcess | null = null;
let dataDir = '';
let BASE = '';
let SECRET = '';

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => ok(port));
    });
  });
}

/** 合成素材包缺失或已过期（manifest 不是 rich4.assets/1）时重新生成 */
function ensureSyntheticPack(): void {
  const manifest = join(PACK_DIR, 'manifest.json');
  let fresh = false;
  if (existsSync(manifest)) {
    try {
      const m = JSON.parse(readFileSync(manifest, 'utf8')) as { schema?: string; packId?: string };
      fresh = m.schema === 'rich4.assets/1' && typeof m.packId === 'string';
    } catch {
      fresh = false;
    }
  }
  if (fresh) return;
  execFileSync('npx', ['tsx', 'tools/extract/src/cli.ts', 'assets', 'synth', '--out', PACK_DIR], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
}

/** 前端构建产物（webServer 的 vite build 已生成；单独跑本 spec 且没有产物时现场构建） */
function ensureClientBuild(): void {
  if (existsSync(join(CLIENT_DIST, 'index.html'))) return;
  execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: join(repoRoot, 'apps/client'), stdio: 'pipe' });
}

async function waitHealthy(url: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok) return;
      last = `status ${r.status}`;
    } catch (err) {
      last = String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`gated server not healthy: ${last}`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  ensureSyntheticPack();
  ensureClientBuild();
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  SECRET = `e2e-access-secret-${port}-0123456789abcdef`;
  dataDir = mkdtempSync(join(tmpdir(), 'rich4-e2e-access-'));
  const stderr: string[] = [];
  server = spawn('npx', ['tsx', 'apps/server/src/main.ts'], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      RICH4_TEST_MODE: '1',
      PORT: String(port),
      HOST: '127.0.0.1',
      PUBLIC_URL: BASE,
      LOG_LEVEL: 'warn',
      LOG_PRETTY: '0',
      DATA_DIR: dataDir,
      STATIC_DIR: CLIENT_DIST,
      RICH4_ASSETS_DIR: PACK_DIR,
      ACCESS_MODE: 'passcode',
      ACCESS_PASSCODE_HASH: await hashPasscode(PASS, { N: 1 << 14, r: 8, p: 1 }),
      ACCESS_SECRET: SECRET,
      ADMIN_TOKEN: ADMIN,
      TRUST_PROXY: '0',
    },
  });
  server.stderr?.on('data', (d: Buffer) => stderr.push(d.toString('utf8')));
  try {
    await waitHealthy(BASE, 90_000);
  } catch (err) {
    throw new Error(`${String(err)}\n${stderr.join('')}`);
  }
});

test.afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('无授权访问 /pack 与 /api 被拒；外壳页公开；口令登录后 /pack 可用', async () => {
  const api = await request.newContext({ baseURL: BASE });
  try {
    for (const url of ['/pack/manifest.json', '/api/maps']) {
      const r = await api.get(url);
      expect(r.status(), url).toBe(401);
      expect(await r.json()).toMatchObject({ ok: false, error: { code: 'ACCESS_REQUIRED' } });
    }
    expect((await api.get('/healthz')).status()).toBe(200);
    expect(await (await api.get('/robots.txt')).text()).toBe('User-agent: *\nDisallow: /\n');
    const shell = await api.get('/');
    expect(shell.status()).toBe(200);
    expect(shell.headers()['content-type']).toContain('text/html');

    expect((await api.post('/api/access', { data: { passcode: 'wrong' } })).status()).toBe(401);
    const ok = await api.post('/api/access', { data: { passcode: PASS } });
    expect(ok.status()).toBe(200);
    expect(ok.headers()['set-cookie']).toMatch(/^r4_access=v2\..*HttpOnly; SameSite=Lax/);

    const man = await api.get('/pack/manifest.json');
    expect(man.status()).toBe(200);
    const h = man.headers();
    expect(h['cache-control']).toBe('private, no-cache');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['cross-origin-resource-policy']).toBe('same-origin');
    expect(h['x-robots-tag']).toContain('noindex');
    const m = (await man.json()) as { schema: string; packId: string; files: Record<string, { path: string }> };
    expect(m.schema).toBe('rich4.assets/1');
    expect(h.etag).toBe(`"${m.packId}"`);
    const png = Object.values(m.files).find((f) => f.path.endsWith('.png'))!;
    const file = await api.get(`/pack/${png.path}`);
    expect(file.status()).toBe(200);
    expect(file.headers()['cache-control']).toBe('private, max-age=2592000');
    expect(file.headers()['content-type']).toBe('image/png');
    const miss = await api.get('/pack/.rich4-extract.json');
    expect(miss.status()).toBe(404);
    expect(await miss.json()).toMatchObject({ ok: false });

    // 吊销后旧 cookie 立即失效
    const rv = await api.post('/admin/access/revoke', { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(rv.status()).toBe(200);
    expect((await api.get('/pack/manifest.json')).status()).toBe(401);
  } finally {
    await api.dispose();
  }
});

test('门禁页输入口令进入：之前 /pack 被拒、握手被拒，之后能建房', async ({ browser }) => {
  const p = await newPlayer(browser, '门禁', Q, { baseURL: BASE, passcode: null });
  try {
    expect(await accessStatus(p.page)).toMatchObject({ mode: 'passcode', granted: false });
    const before = await p.page.evaluate(async () => (await fetch('/pack/manifest.json')).status);
    expect(before).toBe(401);
    // Socket.IO 握手被 io.use 拒绝（门禁先于协议版本检查）
    expect(await probeHandshake(p.page)).toBe('ACCESS_REQUIRED');
    // 前端启动时就显示门禁页；口令走界面提交（通过后重新载入页面）
    await expect(p.page.getByTestId('access-gate')).toBeVisible();
    expect(await enterPasscode(p.page, PASS)).toBe(true);
    expect(await accessStatus(p.page)).toMatchObject({ granted: true, kind: 'p' });
    const after = await p.page.evaluate(async () => (await fetch('/pack/manifest.json')).status);
    expect(after).toBe(200);
    expect(await probeHandshake(p.page)).toBe('PROTOCOL_MISMATCH');
    await createRoom(p.page);
  } finally {
    await p.context.close();
  }
});

test('邀请链接：一个链接只给一个人（复制后框里换新，30 分钟、1 次）；受邀者只能进那个房间', async ({ browser }) => {
  const host = await newPlayer(browser, '房主', Q, { baseURL: BASE, passcode: PASS });
  const other = await newPlayer(browser, '别人', Q, { baseURL: BASE, passcode: PASS });
  const guest = await newPlayer(browser, '朋友', Q, { baseURL: BASE, passcode: null });
  const late = await newPlayer(browser, '晚到', Q, { baseURL: BASE, passcode: null });
  try {
    await host.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    // 原版选人大厅（合成素材包）在 1280 宽时把侧栏收成抽屉：桌面 16:9 才能直接点到邀请框的按钮
    await host.page.setViewportSize({ width: 1920, height: 1080 });
    const code = await createRoom(host.page);
    const otherCode = await createRoom(other.page);
    const grant = await grantLink(host.page, code);
    // 房间页的邀请框已换成授权链接（data-grant="true"），下方说明一个链接限一人、30 分钟
    expect(grant.viaUi).toBe(true);
    await expect(host.page.getByTestId('invite-grant-note')).toContainText(
      either('限一人使用、30 分钟内有效', '限一人使用、30 分鐘內有效'),
    );
    // 复制：拿到的就是框里那一条，框里随即换成新的一条（被复制过的链接不留给第二个人）
    const box = host.page.getByTestId('invite-url');
    await host.page.getByTestId('invite-copy').click();
    await expect(box).not.toHaveValue(new RegExp(grant.token));
    await expect(box).toHaveAttribute('data-grant', 'true');
    const copied = await host.page.evaluate(() => navigator.clipboard.readText());
    expect(new URL(copied).hash).toBe(`#g=${grant.token}`);
    const next = new URL(await box.inputValue()).hash;
    expect(next).toMatch(/^#g=[A-Za-z0-9_-]{43}$/);
    // 二维码同样交出框里那一条再换新
    await host.page.getByTestId('invite-qr-toggle').click();
    await expect(host.page.getByTestId('invite-qr')).toHaveAttribute('data-url', new RegExp(`${next}$`));
    await expect(box).not.toHaveValue(new RegExp(`${next}$`));
    // 授权本身：30 分钟、1 次（服务器返回的元数据）
    const meta = await postJson(host.page, '/api/access/grant', { room: code });
    expect(meta.json).toMatchObject({ data: { room: code, uses: 1 } });
    const left = (meta.json as { data: { expiresAt: number } }).data.expiresAt - Date.now();
    expect(left).toBeGreaterThan(29 * 60_000);
    expect(left).toBeLessThanOrEqual(30 * 60_000);

    expect(await accessStatus(guest.page)).toMatchObject({ granted: false });
    await guest.page.goto(`/r/${code}?${Q}#g=${grant.token}`);
    // 前端读出 #g= 片段并兑换（不靠助手兜底），随后片段从地址栏清除
    expect(await ensureGrantRedeemed(guest.page)).toBe(true);
    expect(new URL(guest.page.url()).hash).toBe('');
    expect(await accessStatus(guest.page)).toMatchObject({ granted: true, kind: 'g', room: code });
    await expect(guest.page.getByTestId('screen-room')).toBeVisible();
    // 同一个链接第二个人打不开：门禁页提示已被用过，要口令
    await late.page.goto(`/r/${code}?${Q}#g=${grant.token}`);
    await expect(late.page.getByTestId('access-error')).toContainText(either('已被别人用过', '已被別人用過'));
    await expect(late.page.getByTestId('access-passcode')).toBeVisible();
    expect(await accessStatus(late.page)).toMatchObject({ granted: false });

    // 受邀者也能取素材，但不能再生成授权
    expect(await guest.page.evaluate(async () => (await fetch('/pack/manifest.json')).status)).toBe(200);
    const again = await postJson(guest.page, '/api/access/grant', { room: code });
    expect(again.status).toBe(403);
    expect(again.json).toMatchObject({ error: { code: 'ACCESS_SCOPE', details: { reason: 'grantNotAllowed' } } });
    // 别的房间：被拒并给「回到房间」
    const scopeText = either('只能加入邀请你的房间', '只能加入邀請你的房間');
    await guest.page.goto(`/r/${otherCode}?${Q}`);
    await expect(guest.page.getByTestId('room-error')).toContainText(scopeText);
    await guest.page.getByTestId('room-guest-back').click();
    await expect(guest.page.getByTestId('screen-room')).toBeVisible();
    expect(new URL(guest.page.url()).pathname).toBe(`/r/${code}`);
    // 首页：建房、单机、加入、公开房间都不给，只有说明与「回到房间」
    await guest.page.goto(`/?${Q}`);
    await expect(guest.page.getByTestId('home-guest-note')).toContainText(scopeText);
    await expect(guest.page.getByTestId('home-solo')).toHaveCount(0);
    await expect(guest.page.getByTestId('home-join-open')).toHaveCount(0);
    const create = guest.page.getByTestId('home-create');
    if ((await create.count()) > 0) await expect(create).toBeDisabled();
    await guest.page.getByTestId('home-guest-room').click();
    await expect(guest.page.getByTestId('screen-room')).toBeVisible();
    // 直接打开 /solo：服务器拒绝建房，页面给出同样的说明
    await guest.page.goto(`/solo?${Q}`);
    await expect(guest.page.getByTestId('solo-error')).toContainText(scopeText);
  } finally {
    for (const p of [late, guest, other, host]) await p.context.close();
  }
});

test('夹具注入口令：newPlayer 带口令时直接进入大厅并建房', async ({ browser }) => {
  const p = await newPlayer(browser, '夹具', Q, { baseURL: BASE, passcode: PASS });
  try {
    expect(await accessStatus(p.page)).toMatchObject({ granted: true, kind: 'p' });
    await createRoom(p.page);
  } finally {
    await p.context.close();
  }
});

test('限时口令（管理接口签发 uses 2、days 1）：首页显示有效期；同一设备再进不消耗次数；停用后立即失效', async ({
  browser,
}) => {
  const api = await request.newContext({ baseURL: BASE });
  const auth = { authorization: `Bearer ${ADMIN}` };
  const p = await newPlayer(browser, '口令', Q, { baseURL: BASE, passcode: null });
  try {
    const created = await api.post('/admin/access/invites', {
      headers: auth,
      data: { uses: 2, days: 1, note: 'ext:e2e' },
    });
    expect(created.status()).toBe(200);
    const { code, invite } = (await created.json()).data as { code: string; invite: { id: string; expiresAt: number } };
    expect(invite.expiresAt - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    await expect(p.page.getByTestId('access-gate')).toBeVisible();
    expect(await enterPasscode(p.page, code)).toBe(true);
    const st = (await accessStatus(p.page)) as unknown as { kind: string; expiresAt: number; deadline: number };
    expect(st).toMatchObject({ kind: 'i', deadline: Math.floor(invite.expiresAt / 1000) * 1000 });
    expect(st.expiresAt).toBe(st.deadline);
    await expect(p.page.getByTestId('home-access-until')).toBeVisible();
    // 刷新、再进首页（凭 cookie）：不再消耗次数
    await p.page.reload();
    await p.page.goto(`/?${Q}`);
    await expect(p.page.getByTestId('home-access-until')).toBeVisible();
    const list = await api.get('/admin/access/invites', { headers: auth });
    const row = ((await list.json()).data.invites as { id: string; usesLeft: number }[]).find(
      (i) => i.id === invite.id,
    );
    expect(row?.usesLeft).toBe(1);
    // 停用这个口令：这台设备下一次刷新就回到门禁页
    const del = await api.delete(`/admin/access/invites/${invite.id}`, { headers: auth });
    expect(del.status()).toBe(200);
    await p.page.reload();
    await expect(p.page.getByTestId('access-gate')).toBeVisible();
    expect(await accessStatus(p.page)).toMatchObject({ granted: false });
  } finally {
    await p.context.close();
    await api.dispose();
  }
});

test('旧格式（v1）的房间授权 cookie 失效：回到门禁页；旧格式的口令 cookie 继续有效', async ({ browser }) => {
  // 本 spec 前面的用例吊销过（epoch 不再是 0）：旧格式 cookie 按当前 epoch 签，只看格式与 kind 的处理
  const api = await request.newContext({ baseURL: BASE });
  const list = await api.get('/admin/access/invites', { headers: { authorization: `Bearer ${ADMIN}` } });
  const epoch = ((await list.json()) as { data: { epoch: number } }).data.epoch;
  await api.dispose();
  const signV1 = (kind: 'p' | 'g'): string => {
    const body = `v1.${Math.floor(Date.now() / 1000) + 3600}.${epoch}.${kind}`;
    const key = createHmac('sha256', SECRET).update('rich4/access-cookie/v1').digest();
    return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
  };
  const p = await newPlayer(browser, '旧客', Q, { baseURL: BASE, passcode: null });
  try {
    await p.context.addCookies([{ name: 'r4_access', value: signV1('g'), url: BASE }]);
    await p.page.goto(`/?${Q}`);
    await expect(p.page.getByTestId('access-gate')).toBeVisible();
    expect(await accessStatus(p.page)).toMatchObject({ granted: false });
    await p.context.addCookies([{ name: 'r4_access', value: signV1('g'), url: BASE }]);
    expect(await probeHandshake(p.page)).toBe('ACCESS_REQUIRED');
    await p.context.addCookies([{ name: 'r4_access', value: signV1('p'), url: BASE }]);
    expect(await accessStatus(p.page)).toMatchObject({ granted: true, kind: 'p' });
  } finally {
    await p.context.close();
  }
});

/** 房主建房（16:9：原版选人大厅的侧栏整栏显示），取得邀请链接，受邀者兑换后进房；返回房间号 */
async function invitedGuest(browser: Browser, hostNick: string, guestNick: string) {
  const host = await newPlayer(browser, hostNick, Q, { baseURL: BASE, passcode: PASS });
  await host.page.setViewportSize({ width: 1920, height: 1080 });
  const guest = await newPlayer(browser, guestNick, Q, { baseURL: BASE, passcode: null });
  const code = await createRoom(host.page);
  const grant = await grantLink(host.page, code);
  await guest.page.goto(`/r/${code}?${Q}#g=${grant.token}`);
  expect(await ensureGrantRedeemed(guest.page)).toBe(true);
  await expect(guest.page.getByTestId('screen-room')).toBeVisible();
  expect(await accessStatus(guest.page)).toMatchObject({ kind: 'g', room: code, roomOpen: true });
  return { host, guest, code };
}

test('邀请链接会话输入口令升级：首页「我有口令」→ 门禁页（可取消）→ 口令通过后换成口令会话、首页恢复完整入口', async ({
  browser,
}) => {
  const { host, guest } = await invitedGuest(browser, '房主升', '朋友升');
  try {
    await guest.page.goto(`/?${Q}`);
    await expect(guest.page.getByTestId('home-guest-note')).toBeVisible();
    await expect(guest.page.getByTestId('home-guest-room')).toBeVisible();
    // 打开门禁页又取消：仍是访客
    await guest.page.getByTestId('home-guest-passcode').click();
    await expect(guest.page.getByTestId('access-gate')).toBeVisible();
    await guest.page.getByTestId('access-cancel').click();
    await expect(guest.page.getByTestId('access-gate')).toBeHidden();
    expect(await accessStatus(guest.page)).toMatchObject({ kind: 'g' });
    // 这次输入口令：页面重新载入，换成口令会话
    await guest.page.getByTestId('home-guest-passcode').click();
    expect(await enterPasscode(guest.page, PASS)).toBe(true);
    expect(await accessStatus(guest.page)).toMatchObject({ granted: true, kind: 'p', room: null, canGrant: true });
    await expect(guest.page.getByTestId('home-solo')).toBeVisible();
    await expect(guest.page.getByTestId('home-guest-note')).toHaveCount(0);
    await expect(guest.page.getByTestId('home-create')).toBeEnabled();
    expect(await probeHandshake(guest.page)).toBe('PROTOCOL_MISMATCH');
  } finally {
    await guest.context.close();
    await host.context.close();
  }
});

test('邀请的房间结束后：访客首页不给「回到房间」，提示要新链接或输入口令，口令照样能用', async ({ browser }) => {
  const { host, guest } = await invitedGuest(browser, '房主散', '朋友散');
  try {
    await host.page.getByTestId('room-dissolve').click();
    // 访客的房间页收到房间关闭，回到首页
    await expect(guest.page.getByTestId('home-closed-note')).toBeVisible();
    await expect(guest.page.getByTestId('home-guest-closed')).toContainText(
      either('邀请你的房间已经结束', '邀請你的房間已經結束'),
    );
    await expect(guest.page.getByTestId('home-guest-room')).toHaveCount(0);
    expect(await accessStatus(guest.page)).toMatchObject({ kind: 'g', roomOpen: false });
    // 刷新后照样（状态接口给出 roomOpen false）
    await guest.page.reload();
    await expect(guest.page.getByTestId('home-guest-closed')).toBeVisible();
    await guest.page.getByTestId('home-guest-passcode').click();
    expect(await enterPasscode(guest.page, PASS)).toBe(true);
    await expect(guest.page.getByTestId('home-solo')).toBeVisible();
    expect(await accessStatus(guest.page)).toMatchObject({ kind: 'p' });
  } finally {
    await guest.context.close();
    await host.context.close();
  }
});
