/**
 * scripts/loadtest.ts 冒烟：对测试服务器（测试模式、带 ADMIN_TOKEN）跑 3 个房间、每房 2 真人 + 1 观战，
 * 检查 --json 结果（全部开局、无缺口与意外断线、读到事件循环延迟、注明窗口口径）与收尾（房间全部解散、连接全部断开）；
 * 访问门禁开启时用口令登录一次、全部 bot 共用 cookie；缺少凭据或 ADMIN_TOKEN、参数错误时退出码 2。
 * 脚本在子进程里以 node --import tsx 运行，ADMIN_TOKEN 与口令经环境变量传入。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hashPasscode, parsePasscodeHash, SCRYPT_LIMITS } from '../../src/access/passcode';
import { startTestServer, type TestServer } from '../helpers/startTestServer';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const script = fileURLToPath(new URL('../../scripts/loadtest.ts', import.meta.url));
const ADMIN = 'loadtest-admin-token-for-tests-0123456789';
const PASS = 'loadtest-passcode-42';
const SECRET = 'loadtest-access-secret-0123456789abcdef';

let srv: TestServer | null = null;

afterEach(async () => {
  await srv?.close();
  srv = null;
});

function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    p.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), 50_000);
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('integration/loadtest-script', () => {
  it('--json：3 房全部开局、无缺口与意外断线，读到服务器事件循环延迟；结束后房间全部解散', {
    timeout: 60_000,
  }, async () => {
    srv = await startTestServer({ adminToken: ADMIN });
    const r = await run(
      [
        '--url',
        srv.url,
        '--rooms',
        '3',
        '--humans',
        '2',
        '--spectators',
        '1',
        '--duration',
        '2',
        '--ramp',
        '0.5',
        '--delay',
        '20',
        '--p99-max',
        '1000',
        '--json',
      ],
      { ADMIN_TOKEN: ADMIN },
    );
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as {
      verdict: string;
      config: { map: string; ais: number };
      rooms: { started: number; failed: number };
      bots: number;
      acks: { act: { count: number }; timeouts: number };
      seqGaps: number;
      disconnects: number;
      server: { eventLoopDelayMs: { p99: number }; windowsInSteadyState: boolean; window: string };
      cleanup: { roomsBefore: number; roomsAfter: number; connectionsAfter: number };
    };
    expect(out.verdict).toBe('PASS');
    // fixture 目录里没有 taiwan：回退到 test
    expect(out.config).toMatchObject({ map: 'test', ais: 2 });
    expect(out.rooms).toMatchObject({ started: 3, failed: 0 });
    expect(out.bots).toBe(9);
    expect(out.acks.act.count).toBeGreaterThan(0);
    expect(out.acks.timeouts).toBe(0);
    expect(out.seqGaps).toBe(0);
    expect(out.disconnects).toBe(0);
    expect(out.server.eventLoopDelayMs.p99).toBeGreaterThanOrEqual(0);
    // 稳态只有 2 秒：注明窗口可能含压测前的时段
    expect(out.server.windowsInSteadyState).toBe(false);
    expect(out.server.window).toContain('仅供冒烟参考');
    expect(out.cleanup).toMatchObject({ roomsBefore: 0, roomsAfter: 0, connectionsAfter: 0 });
    expect(srv.app.rooms.size).toBe(0);
    // ADMIN_TOKEN 不出现在输出里
    expect(r.stdout + r.stderr).not.toContain(ADMIN);
  });

  it('没有 ADMIN_TOKEN 时只跑压测不判定（退出码 2）；参数错误退出码 2', { timeout: 60_000 }, async () => {
    srv = await startTestServer();
    const env = { ADMIN_TOKEN: '' };
    const bad = await run(['--url', srv.url, '--humans', '5'], env);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--humans');
    const r = await run(['--url', srv.url, '--rooms', '1', '--duration', '1', '--ramp', '0', '--json'], env);
    expect(r.code, r.stderr).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ verdict: 'UNKNOWN', rooms: { started: 1 }, server: null });
    expect(srv.app.rooms.size).toBe(0);
  });

  it('运行中被服务器断开：判 FAIL（意外断线），收尾时房主用同一 token 恢复后解散，不留房间', {
    timeout: 60_000,
  }, async () => {
    srv = await startTestServer({ adminToken: ADMIN });
    const app = srv.app;
    const running = run(
      ['--url', srv.url, '--rooms', '2', '--duration', '4', '--ramp', '0', '--p99-max', '1000', '--json'],
      { ADMIN_TOKEN: ADMIN },
    );
    const t0 = Date.now();
    while (app.rooms.stats().playing < 2 && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 50));
    expect(app.rooms.stats().playing).toBe(2);
    app.io.disconnectSockets(true);
    const r = await running;
    expect(r.code, r.stderr).toBe(1);
    const out = JSON.parse(r.stdout) as { verdict: string; reasons: string[]; disconnects: number };
    expect(out.verdict).toBe('FAIL');
    expect(out.disconnects).toBe(2);
    expect(out.reasons.join('；')).toContain('意外断线');
    expect(app.rooms.size).toBe(0);
  });

  it('访问门禁：没有凭据时预检失败并提示；ACCESS_PASSCODE 登录一次后全部 bot 带 cookie 握手', {
    timeout: 60_000,
  }, async () => {
    const h = parsePasscodeHash(await hashPasscode(PASS, { N: SCRYPT_LIMITS.minN, r: 8, p: 1 }));
    if (!h.ok) throw new Error(h.reason);
    srv = await startTestServer({
      adminToken: ADMIN,
      access: { mode: 'passcode', passcodeHash: h.value, secret: SECRET, grants: true, secure: false },
      accessOptions: { sleep: async () => {}, epochCacheMs: 0 },
    });
    const args = ['--url', srv.url, '--rooms', '2', '--duration', '1', '--ramp', '0', '--p99-max', '1000'];
    const denied = await run(args, { ADMIN_TOKEN: ADMIN, ACCESS_PASSCODE: '' });
    expect(denied.code).toBe(2);
    expect(denied.stderr).toContain('--passcode');
    const r = await run([...args, '--json'], { ADMIN_TOKEN: ADMIN, ACCESS_PASSCODE: PASS });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ verdict: 'PASS', rooms: { started: 2, failed: 0 }, disconnects: 0 });
    expect(r.stdout + r.stderr).not.toContain(PASS);
    expect(srv.app.rooms.size).toBe(0);
  });
});
