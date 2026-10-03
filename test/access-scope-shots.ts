// 调试脚本（architecture §35：限时邀请码会话、一次性邀请链接、邀请链接会话的房间作用域）：自己起一个开启口令门禁的服务器
// （合成素材包 .cache/synthetic-pack、托管已构建的前端 apps/client/dist、测试口令只在本进程内存里），用系统 Chrome 无头截图两种皮肤：
// 1) 房主大厅的邀请框（备用授权链接 + 「限一人使用、30 分钟」说明）、复制后框里换新、二维码；
// 2) 用邀请链接进来的访客：房间页、首页（只剩说明与「回到房间」）、打开别的房间被拒的错误页；
// 3) 第二个人打开同一个链接：门禁页提示已被用过；
// 4) 管理接口签发的限时邀请码（uses 2、days 1）登录后的首页（有效期）；
// 5) 访客在首页点「我有口令」打开的门禁页（可取消）；房主解散房间后访客的首页（房间已结束，只剩「我有口令」）。
// 产物写到 .cache/access-scope/<皮肤>/（不入库）。前提：apps/client/dist 已构建（E2E 的 webServer 会构建，或 npx vite build）。
// 用法：npx tsx test/access-scope-shots.ts [procedural|original|both]
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Browser, type BrowserContext, chromium, type Page } from '@playwright/test';
import { hashPasscode } from '../apps/server/src/access/passcode';

const ROOT = resolve(import.meta.dirname, '..');
const PACK = join(ROOT, '.cache', 'synthetic-pack');
const DIST = join(ROOT, 'apps', 'client', 'dist');
const PASS = 'shots-passcode-9f2e';
const ADMIN = 'shots-admin-token-0123456789abcdefghij';
const Q = 'anim=instant&audio=off';
const which = process.argv[2] ?? 'both';
const skins = which === 'both' ? (['procedural', 'original'] as const) : ([which] as ('procedural' | 'original')[]);

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

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

async function waitHealthy(base: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server not healthy');
}

async function startServer(): Promise<{ base: string; proc: ChildProcess; dataDir: string }> {
  if (!existsSync(join(PACK, 'manifest.json'))) {
    execFileSync('npx', ['tsx', 'tools/extract/src/cli.ts', 'assets', 'synth', '--out', PACK], { cwd: ROOT });
  }
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('先构建前端：(apps/client) npx vite build');
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'rich4-shots-'));
  const proc = spawn('npx', ['tsx', 'apps/server/src/main.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      RICH4_TEST_MODE: '1',
      PORT: String(port),
      HOST: '127.0.0.1',
      PUBLIC_URL: base,
      LOG_LEVEL: 'warn',
      LOG_PRETTY: '0',
      DATA_DIR: dataDir,
      STATIC_DIR: DIST,
      RICH4_ASSETS_DIR: PACK,
      ACCESS_MODE: 'passcode',
      ACCESS_PASSCODE_HASH: await hashPasscode(PASS, { N: 1 << 14, r: 8, p: 1 }),
      ACCESS_SECRET: `shots-access-secret-${port}-0123456789abcdef`,
      ADMIN_TOKEN: ADMIN,
      TRUST_PROXY: '0',
    },
  });
  await waitHealthy(base);
  return { base, proc, dataDir };
}

/** 新的隔离上下文：皮肤设置（procedural / auto）与昵称预先写进 localStorage；passcode 非空时先换 cookie */
async function player(
  browser: Browser,
  base: string,
  skin: 'procedural' | 'original',
  nickname: string,
  passcode: string | null,
): Promise<{ ctx: BrowserContext; page: Page }> {
  // 原版选人大厅在桌面 16:9 才把两侧联机侧栏（含邀请框）整栏显示，窄了收成抽屉
  const viewport = skin === 'original' ? { width: 1920, height: 1080 } : { width: 1280, height: 860 };
  const ctx = await browser.newContext({ baseURL: base, viewport });
  await ctx.addInitScript(
    ([pref, nick]) => {
      if (!localStorage.getItem('rich4.settings')) {
        localStorage.setItem('rich4.settings', JSON.stringify({ state: { skin: pref, nickname: nick }, version: 2 }));
      }
    },
    [skin === 'procedural' ? 'procedural' : 'auto', nickname] as const,
  );
  if (passcode) {
    const r = await ctx.request.post('/api/access', { data: { passcode } });
    if (r.status() !== 200) throw new Error(`login ${r.status()}`);
  }
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  return { ctx, page };
}

async function createRoom(page: Page): Promise<string> {
  await page.goto(`/?${Q}`);
  await page.getByTestId('home-create').click();
  await page.getByTestId('set-map').selectOption('test');
  await page.getByTestId('create-submit').click();
  await page.waitForURL(/\/r\/\d{6}/);
  await page.getByTestId('screen-room').waitFor();
  return /\/r\/(\d{6})/.exec(page.url())![1]!;
}

async function shot(page: Page, out: string, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  → ${join(out, `${name}.png`)}`);
}

async function runSkin(browser: Browser, base: string, skin: 'procedural' | 'original'): Promise<void> {
  const out = join(ROOT, '.cache', 'access-scope', skin);
  mkdirSync(out, { recursive: true });
  console.log(`== ${skin}`);
  const host = await player(browser, base, skin, '房主', PASS);
  const other = await player(browser, base, skin, '别人', PASS);
  const guest = await player(browser, base, skin, '朋友', null);
  const late = await player(browser, base, skin, '晚到', null);
  const timed = await player(browser, base, skin, '限时', null);
  try {
    const code = await createRoom(host.page);
    const otherCode = await createRoom(other.page);
    const box = host.page.getByTestId('invite-url');
    await host.page.locator('[data-testid="invite-url"][data-grant="true"]').waitFor();
    const first = await box.inputValue();
    check(`${skin}: 邀请框是授权链接`, /#g=[A-Za-z0-9_-]{43}$/.test(first));
    check(
      `${skin}: 说明限一人、30 分钟`,
      /限一人使用、30 分(钟|鐘)內?内?有效/.test(await host.page.getByTestId('invite-grant-note').innerText()),
    );
    await shot(host.page, out, '1-host-lobby-invite');
    await host.page.getByTestId('invite-copy').click();
    await host.page.waitForFunction((v) => document.querySelector<HTMLInputElement>('[data-testid="invite-url"]')?.value !== v, first);
    const copied = await host.page.evaluate(() => navigator.clipboard.readText());
    check(`${skin}: 复制的是框里那条`, copied === first);
    check(`${skin}: 复制后框里换新`, (await box.inputValue()) !== first);
    await shot(host.page, out, '2-host-after-copy');
    await host.page.getByTestId('invite-qr-toggle').click();
    await host.page.getByTestId('invite-qr').waitFor();
    await shot(host.page, out, '3-host-qr');

    await guest.page.goto(`${new URL(copied).pathname}?${Q}${new URL(copied).hash}`);
    await guest.page.getByTestId('screen-room').waitFor({ timeout: 30_000 });
    await shot(guest.page, out, '4-guest-room');
    await late.page.goto(`${new URL(copied).pathname}?${Q}${new URL(copied).hash}`);
    await late.page.getByTestId('access-error').waitFor();
    check(`${skin}: 第二个人提示已被用过`, /已被(别人用过|別人用過)/.test(await late.page.getByTestId('access-error').innerText()));
    await shot(late.page, out, '5-second-person-gate');

    await guest.page.goto(`/r/${otherCode}?${Q}`);
    await guest.page.getByTestId('room-error').waitFor();
    check(
      `${skin}: 访客进别的房间被拒`,
      /只能加入邀(请你的房间|請你的房間)/.test(await guest.page.getByTestId('room-error').innerText()),
    );
    await shot(guest.page, out, '6-guest-other-room');
    await guest.page.goto(`/?${Q}`);
    await guest.page.getByTestId('home-guest-note').waitFor();
    check(`${skin}: 访客首页没有单机`, (await guest.page.getByTestId('home-solo').count()) === 0);
    await shot(guest.page, out, '7-guest-home');
    await guest.page.getByTestId('home-guest-passcode').click();
    await guest.page.getByTestId('access-cancel').waitFor();
    await shot(guest.page, out, '9-guest-passcode-gate');
    await guest.page.getByTestId('access-cancel').click();
    await host.page.getByTestId('invite-qr-toggle').click();
    await host.page.getByTestId('room-dissolve').click();
    await host.page.getByTestId('screen-home').waitFor();
    await guest.page.goto(`/?${Q}`);
    await guest.page.getByTestId('home-guest-closed').waitFor();
    check(`${skin}: 房间结束后没有「回到房间」`, (await guest.page.getByTestId('home-guest-room').count()) === 0);
    await shot(guest.page, out, '10-guest-room-closed-home');

    const inv = await timed.ctx.request.post('/admin/access/invites', {
      headers: { authorization: `Bearer ${ADMIN}` },
      data: { uses: 2, days: 1, note: 'shots' },
    });
    const invCode = ((await inv.json()) as { data: { code: string } }).data.code;
    await timed.page.goto(`/?${Q}`);
    await timed.page.getByTestId('access-passcode').fill(invCode);
    await timed.page.getByTestId('access-submit').click();
    await timed.page.getByTestId('home-access-until').waitFor({ timeout: 30_000 });
    await shot(timed.page, out, '8-invite-code-home-deadline');
  } finally {
    for (const p of [timed, late, guest, other, host]) await p.ctx.close();
  }
}

const srv = await startServer();
let browser: Browser | null = null;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const s of skins) await runSkin(browser, srv.base, s);
} finally {
  await browser?.close();
  srv.proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  rmSync(srv.dataDir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length > 0 ? 1 : 0);
