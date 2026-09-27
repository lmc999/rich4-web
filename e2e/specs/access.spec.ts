// 访问门禁 E2E（docs/design/original-skin.md U4、§5 A4）：
// 本 spec 自己起一个开启门禁的服务器（ACCESS_MODE=passcode、合成素材包、托管已构建的前端 apps/client/dist），
// 与 playwright.config 里 ACCESS_MODE=off 的默认服务器互不影响。
//   1) 无授权访问 /pack 与 /api 被拒，外壳页、健康检查、robots 公开；口令登录后 /pack 可用且头正确；
//   2) 打开首页即显示门禁页（bootstrapAccess），在门禁页输入口令进入；
//   3) 房间页邀请框直接给出授权链接，/r/<房间>#g=<token> 由前端兑换后免口令进入；受邀者不能再生成授权；
//   4) 夹具注入口令（RICH4_E2E_PASSCODE 的路径）后直接建房。
// 合成素材包（内容全是自绘图形）按需生成到 .cache/synthetic-pack；测试口令只在本进程内存里。
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, request, test } from '@playwright/test';
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACK_DIR = join(repoRoot, '.cache', 'synthetic-pack');
const CLIENT_DIST = join(repoRoot, 'apps', 'client', 'dist');
const PASS = 'e2e-access-passcode-7a4c';
// 门禁开启时 ADMIN_TOKEN 至少 32 字节（config.ts）
const ADMIN = 'e2e-admin-token-access-0123456789abcdef';

let server: ChildProcess | null = null;
let dataDir = '';
let BASE = '';

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
      ACCESS_SECRET: `e2e-access-secret-${port}-0123456789abcdef`,
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
    expect(ok.headers()['set-cookie']).toMatch(/^r4_access=v1\..*HttpOnly; SameSite=Lax/);

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

test('邀请链接免口令进入：/r/<房间>#g=<token> 兑换后进房；受邀者不能再生成授权', async ({ browser }) => {
  const host = await newPlayer(browser, '房主', Q, { baseURL: BASE, passcode: PASS });
  const guest = await newPlayer(browser, '朋友', Q, { baseURL: BASE, passcode: null });
  try {
    const code = await createRoom(host.page);
    const grant = await grantLink(host.page, code);
    // 房间页的邀请框已换成授权链接（data-grant="true"）
    expect(grant.viaUi).toBe(true);
    // 授权本身：24 小时、8 次（服务器返回的元数据）
    const meta = await postJson(host.page, '/api/access/grant', { room: code });
    expect(meta.json).toMatchObject({ data: { room: code, uses: 8 } });

    expect(await accessStatus(guest.page)).toMatchObject({ granted: false });
    await guest.page.goto(`/r/${code}?${Q}#g=${grant.token}`);
    // 前端读出 #g= 片段并兑换（不靠助手兜底），随后片段从地址栏清除
    expect(await ensureGrantRedeemed(guest.page)).toBe(true);
    expect(new URL(guest.page.url()).hash).toBe('');
    expect(await accessStatus(guest.page)).toMatchObject({ granted: true, kind: 'g' });
    await expect(guest.page.getByTestId('screen-room')).toBeVisible();
    // 受邀者也能取素材，但不能再生成授权
    expect(await guest.page.evaluate(async () => (await fetch('/pack/manifest.json')).status)).toBe(200);
    const again = await postJson(guest.page, '/api/access/grant', { room: code });
    expect(again.status).toBe(403);
    expect(again.json).toMatchObject({ error: { code: 'ACCESS_REQUIRED', details: { reason: 'grantNotAllowed' } } });
  } finally {
    await guest.context.close();
    await host.context.close();
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
