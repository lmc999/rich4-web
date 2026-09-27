// 启动时的门禁态势：未设门禁的素材包只允许本机显式例外（其余拒绝启动）并高亮告警；门禁开启而没有 TRUST_PROXY 时提醒
// 限流按直连 IP 计；生产环境 PUBLIC_URL 不是 https 记 error；口令哈希参数偏弱、invite 模式没有 ADMIN_TOKEN 时提醒
import { describe, expect, it } from 'vitest';
import { hashPasscode, parsePasscodeHash, SCRYPT_LIMITS } from '../../src/access/passcode';
import { assertPackGated, warnAccessPosture } from '../../src/app';
import { ConfigError, loadConfig } from '../../src/config';
import { createLogger } from '../../src/infra/logger';

function capture() {
  const lines: string[] = [];
  const log = createLogger({ level: 'info', pretty: false, sink: (l) => lines.push(l) });
  return { log, lines };
}

describe('warnAccessPosture', () => {
  const base = loadConfig({});
  const ungated = { ...base, assets: { ...base.assets, present: true, ungated: true } };

  it('素材包已启用而门禁 off（本机显式例外）：高亮告警', () => {
    const { log, lines } = capture();
    warnAccessPosture(log, ungated, { enabled: true, dir: '/x' });
    expect(lines.length).toBe(3);
    expect(lines.join('\n')).toContain('未设访问门禁');
    expect(lines[0]).toContain('!'.repeat(72));
  });

  it('没有素材包、门禁 off：不告警', () => {
    const { log, lines } = capture();
    warnAccessPosture(log, base, { enabled: false, dir: null });
    expect(lines).toEqual([]);
  });

  it('门禁开启、公网 PUBLIC_URL、TRUST_PROXY=0：提醒设置 TRUST_PROXY；本机或已设时不提醒', () => {
    const access = { ...base.access, mode: 'passcode' as const };
    const a = capture();
    warnAccessPosture(a.log, { ...base, access, publicUrl: 'https://rich4.example.com' }, { enabled: true, dir: '/x' });
    expect(a.lines.join('\n')).toContain('TRUST_PROXY=1');
    const b = capture();
    warnAccessPosture(
      b.log,
      { ...base, access, publicUrl: 'https://rich4.example.com', trustProxy: true },
      { enabled: true, dir: '/x' },
    );
    expect(b.lines).toEqual([]);
    const c = capture();
    warnAccessPosture(c.log, { ...base, access }, { enabled: true, dir: '/x' });
    expect(c.lines).toEqual([]);
  });

  it('生产环境门禁开启而 PUBLIC_URL 是 http（非本机）：error 级提示 cookie 不带 Secure', () => {
    const access = { ...base.access, mode: 'invite' as const };
    const cfg = { ...base, access, trustProxy: true, production: true };
    const a = capture();
    warnAccessPosture(a.log, { ...cfg, publicUrl: 'http://rich4.example.com' }, { enabled: true, dir: '/x' });
    const line = a.lines.find((l) => l.includes('Secure'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!).level).toBe(50); // error
    for (const publicUrl of ['https://rich4.example.com', 'http://localhost:3000']) {
      const b = capture();
      warnAccessPosture(b.log, { ...cfg, publicUrl, adminToken: 'x'.repeat(32) }, { enabled: true, dir: '/x' });
      expect(
        b.lines.some((l) => l.includes('Secure')),
        publicUrl,
      ).toBe(false);
    }
  });

  it('口令哈希的 scrypt 计算量低于建议值时提醒重新生成；invite 模式在生产里没有 ADMIN_TOKEN 时提醒', async () => {
    const weak = parsePasscodeHash(await hashPasscode('posture-passcode', { N: SCRYPT_LIMITS.minN, r: 8, p: 1 }));
    if (!weak.ok) throw new Error(weak.reason);
    const a = capture();
    warnAccessPosture(
      a.log,
      { ...base, trustProxy: true, access: { ...base.access, mode: 'passcode', passcodeHash: weak.value } },
      { enabled: true, dir: '/x' },
    );
    expect(a.lines.join('\n')).toContain('scrypt 参数低于建议值');
    const strong = { ...weak.value, N: 1 << 15, p: 3 };
    const b = capture();
    warnAccessPosture(
      b.log,
      { ...base, trustProxy: true, access: { ...base.access, mode: 'passcode', passcodeHash: strong } },
      { enabled: true, dir: '/x' },
    );
    expect(b.lines).toEqual([]);
    const inv = { ...base, trustProxy: true, production: true, publicUrl: 'https://rich4.example.com' };
    const c = capture();
    warnAccessPosture(c.log, { ...inv, access: { ...base.access, mode: 'invite' } }, { enabled: true, dir: '/x' });
    expect(c.lines.join('\n')).toContain('ADMIN_TOKEN');
    const d = capture();
    warnAccessPosture(
      d.log,
      { ...inv, adminToken: 'y'.repeat(32), access: { ...base.access, mode: 'invite' } },
      { enabled: true, dir: '/x' },
    );
    expect(d.lines).toEqual([]);
  });
});

describe('assertPackGated（createApp 的纵深防御）', () => {
  const base = loadConfig({});

  it('素材包已启用 + 门禁 off + 不是配置里的本机例外 → ConfigError', () => {
    expect(() => assertPackGated(base, { enabled: true, dir: '/x' })).toThrow(ConfigError);
    expect(() => assertPackGated(base, { enabled: true, dir: '/x' })).toThrow(/拒绝启动/);
  });

  it('本机例外、门禁开启、没有素材包：放行', () => {
    expect(() =>
      assertPackGated({ ...base, assets: { ...base.assets, ungated: true } }, { enabled: true, dir: '/x' }),
    ).not.toThrow();
    expect(() =>
      assertPackGated({ ...base, access: { ...base.access, mode: 'passcode' } }, { enabled: true, dir: '/x' }),
    ).not.toThrow();
    expect(() => assertPackGated(base, { enabled: false, dir: null })).not.toThrow();
  });
});
