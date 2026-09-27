// scripts/access.ts 的实现：hash / secret / invite / list / revoke
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openAccessStore } from '../../src/access/AccessStore';
import { type CliIo, defaultAccessDbPath, runAccessCli } from '../../src/access/cli';
import { parsePasscodeHash, verifyPasscode } from '../../src/access/passcode';

const root = mkdtempSync(join(tmpdir(), 'rich4-access-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function io(o: Partial<CliIo> & { stdin?: string } = {}): CliIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return {
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    readStdin: async () => o.stdin ?? '',
    promptHidden: o.promptHidden ?? null,
    env: o.env ?? { DATA_DIR: root },
    cwd: o.cwd ?? root,
    ...(o.now ? { now: o.now } : {}),
    outs,
    errs,
  };
}

describe('access CLI', () => {
  it('hash --stdin：输出可解析、可验证的哈希；短口令给出警告；口令不出现在输出里', async () => {
    const x = io({ stdin: 'a-long-enough-passcode\nignored' });
    expect(await runAccessCli(['hash', '--stdin', '--N', '16384'], x)).toBe(0);
    expect(x.outs).toHaveLength(1);
    const h = parsePasscodeHash(x.outs[0]!);
    if (!h.ok) throw new Error(h.reason);
    expect(await verifyPasscode('a-long-enough-passcode', h.value)).toBe(true);
    expect([...x.outs, ...x.errs].join('\n')).not.toContain('a-long-enough-passcode');
    expect(x.errs.join('\n')).not.toContain('警告');

    const short = io({ stdin: 'short\n' });
    expect(await runAccessCli(['hash', '--stdin', '--N', '16384'], short)).toBe(0);
    expect(short.errs.join('\n')).toContain('警告');
    expect(await runAccessCli(['hash', '--stdin'], io({ stdin: '' }))).toBe(1);
    expect(await runAccessCli(['hash', '--stdin', '--N', '1000'], io({ stdin: 'passcode-long' }))).toBe(1);
  });

  it('hash 交互：两次输入一致才输出', async () => {
    const answers = ['same-passcode-xyz', 'same-passcode-xyz'];
    const ok = io({ promptHidden: async () => answers.shift()! });
    expect(await runAccessCli(['hash', '--N', '16384'], ok)).toBe(0);
    const again = ['one-passcode-abc', 'two-passcode-abc'];
    const bad = io({ promptHidden: async () => again.shift()! });
    expect(await runAccessCli(['hash', '--N', '16384'], bad)).toBe(1);
    expect(bad.errs.join('\n')).toContain('不一致');
  });

  it('secret：≥32 字节的随机串', async () => {
    const x = io();
    expect(await runAccessCli(['secret'], x)).toBe(0);
    expect(x.outs[0]).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });

  it('invite / list / revoke：写入与服务器相同的库（DATA_DIR/rich4.db）', async () => {
    const t = 1_900_000_000_000;
    const x = io({ now: () => t });
    // 库还不存在：不带 --create 时拒绝（不新建空库）
    expect(await runAccessCli(['invite', '--uses', '3'], io({ now: () => t }))).toBe(1);
    expect(existsSync(join(root, 'rich4.db'))).toBe(false);
    expect(await runAccessCli(['invite', '--uses', '3', '--days', '2', '--note', 'friends', '--create'], x)).toBe(0);
    const code = x.outs[0]!;
    expect(x.errs.join('\n')).toContain(join(root, 'rich4.db'));
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);

    const dbPath = defaultAccessDbPath({ DATA_DIR: root }, root);
    expect(dbPath).toBe(join(root, 'rich4.db'));
    expect(defaultAccessDbPath({ DATA_DIR: 'd', STORE: 'json' }, '/srv')).toBe(join('/srv', 'd', 'access.db'));
    const { store, db } = openAccessStore(dbPath);
    expect(store.redeemInvite(code, t + 1000)).toBe(true);
    db.close();

    const l = io({ now: () => t });
    expect(await runAccessCli(['list'], l)).toBe(0);
    expect(l.outs[0]).toContain('epoch 0');
    expect(l.outs[1]).toMatch(/有效 {2}剩余 2 次 .* friends$/);

    const id = l.outs[1]!.split(' ')[0]!;
    expect(await runAccessCli(['revoke', '--invite', id], io())).toBe(0);
    expect(await runAccessCli(['revoke', '--invite', id], io())).toBe(1);
    const r = io();
    expect(await runAccessCli(['revoke'], r)).toBe(0);
    expect(r.outs[0]).toContain('epoch 0 → 1');
    expect(r.outs[0]).toContain(join(root, 'rich4.db'));
    const l2 = io({ now: () => t });
    await runAccessCli(['list'], l2);
    expect(l2.outs[0]).toContain('epoch 1');
    expect(l2.outs[1]).toContain('已撤销');

    const noExp = io();
    expect(await runAccessCli(['invite', '--no-expiry', '--db', join(root, 'other.db'), '--create'], noExp)).toBe(0);
    expect(noExp.errs[0]).toContain('不过期');
    expect(await runAccessCli(['invite', '--uses', '0'], io())).toBe(1);
  });

  it('DATA_DIR 打错：list / revoke / invite 报错退出，不新建数据库，也不报告吊销成功', async () => {
    const typo = join(root, 'typo-dir');
    for (const argv of [['revoke'], ['list'], ['invite'], ['revoke', '--invite', 'abc'], ['revoke', '--create']]) {
      const x = io({ env: { DATA_DIR: typo } });
      expect(await runAccessCli(argv, x), argv.join(' ')).toBe(1);
      expect(x.outs, argv.join(' ')).toEqual([]);
      expect(x.errs.join('\n')).toContain(join(typo, 'rich4.db'));
      expect(x.errs.join('\n')).toContain('不存在');
    }
    expect(existsSync(typo)).toBe(false);
    const viaDb = io();
    expect(await runAccessCli(['revoke', '--db', join(root, 'nope', 'x.db')], viaDb)).toBe(1);
    expect(existsSync(join(root, 'nope'))).toBe(false);
  });

  it('未知命令与多余参数：退出码 2 并打印用法', async () => {
    const x = io();
    expect(await runAccessCli(['bogus'], x)).toBe(2);
    expect(x.errs[0]).toContain('未知命令');
    expect(await runAccessCli(['list', 'extra'], io())).toBe(2);
    expect(await runAccessCli([], io())).toBe(2);
    expect(await runAccessCli(['help'], io())).toBe(0);
  });
});
