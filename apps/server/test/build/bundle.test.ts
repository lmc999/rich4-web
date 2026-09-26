/**
 * 生产包（build.mjs）：不含测试代码（stubEngine、localPolicy 标为 external），产物能以 NODE_ENV=production 起服、
 * 通过 /healthz 与 /readyz，并在 SIGTERM 后优雅停机（退出码 0，数据库文件已落盘）。
 * 产物写到 apps/server/dist/bundle-test-<pid>.mjs（dist 在 .gitignore 中），测试结束删除。
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const outfile = join(serverDir, 'dist', `bundle-test-${process.pid}.mjs`);
const dataDir = mkdtempSync(join(tmpdir(), 'rich4-bundle-'));
let child: ChildProcess | null = null;

afterAll(() => {
  child?.kill('SIGKILL');
  for (const f of [outfile, `${outfile}.map`]) rmSync(f, { force: true });
  try {
    rmdirSync(join(serverDir, 'dist')); // 只在空目录时成功（不动已有的构建产物）
  } catch {
    // dist 里还有别的产物
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function waitForLine(p: ChildProcess, pred: (line: string) => boolean, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timed out; output so far:\n${buf}`)), timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      for (const line of buf.split('\n')) {
        if (pred(line)) {
          clearTimeout(timer);
          p.stdout?.off('data', onData);
          resolve(line);
          return;
        }
      }
    };
    p.stdout?.on('data', onData);
    p.stderr?.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
    });
  });
}

describe('build/bundle', () => {
  it('产物不含测试代码，可以起服并在 SIGTERM 后优雅停机', async () => {
    const b = spawnSync(process.execPath, [join(serverDir, 'build.mjs'), '--outfile', outfile], { encoding: 'utf8' });
    expect(b.status, b.stderr).toBe(0);
    const code = readFileSync(outfile, 'utf8');
    // stubEngine / localPolicy 的实现不在包里，只剩 external 的动态 import
    expect(code).not.toContain('0.0.0-stub');
    expect(code).not.toContain('function pickIntent');
    expect(code).toContain('"../test/helpers/stubEngine"');

    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', outfile], {
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'production',
        SAVE_HMAC_SECRET: 'bundle-test-secret-0123456789abcdefghij',
        DATA_DIR: dataDir,
        RICH4_DATA_DIR: join(dataDir, 'no-rich4-data'),
        PORT: '0',
        HOST: '127.0.0.1',
        LOG_PRETTY: '0',
        LOG_LEVEL: 'info',
        BACKUP_ENABLED: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = await waitForLine(child, (l) => l.includes('rich4 server listening'), 15_000);
    const url = (JSON.parse(line) as { addr: string }).addr.replace('0.0.0.0', '127.0.0.1');
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
    expect(((await (await fetch(`${url}/api/maps`)).json()) as { maps: unknown[] }).maps.length).toBeGreaterThan(0);

    const exited = new Promise<number | null>((resolve) => child!.once('exit', (c) => resolve(c)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    child = null;
    expect(existsSync(join(dataDir, 'rich4.db'))).toBe(true);
  }, 60_000);
});
