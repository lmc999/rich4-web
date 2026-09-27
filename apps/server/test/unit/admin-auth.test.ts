// 管理接口鉴权（AdminAuth）：常数时间比较；失败按 IP 退避（429）并记 warn 日志（不含 token）；未配置时 404
import { describe, expect, it } from 'vitest';
import { AccessLimiter } from '../../src/access/limiter';
import { AdminAuth } from '../../src/http/admin';
import { createLogger } from '../../src/infra/logger';

const TOKEN = 'admin-token-0123456789-abcdefghijklmnop';

function req(auth: string | undefined, ip = '203.0.113.1') {
  return {
    headers: auth === undefined ? {} : { authorization: auth },
    ip,
    url: '/admin/access/invites?x=1',
    method: 'POST',
  };
}

describe('AdminAuth', () => {
  it('未配置 ADMIN_TOKEN：404；正确的 Bearer 通过', () => {
    expect(new AdminAuth({ token: null }).check(req(`Bearer ${TOKEN}`))).toMatchObject({ ok: false, status: 404 });
    expect(new AdminAuth({ token: TOKEN }).check(req(`Bearer ${TOKEN}`))).toEqual({ ok: true });
    expect(new AdminAuth({ token: TOKEN }).check(req(`bearer   ${TOKEN}  `))).toEqual({ ok: true });
  });

  it('失败记 warn 日志（IP、路径、累计次数，不含 token）；5 次之后退避 429，退避期内不比对 token', () => {
    let t = 1_000_000;
    const now = () => t;
    const lines: string[] = [];
    const log = createLogger({ level: 'info', pretty: false, sink: (l) => lines.push(l) });
    const auth = new AdminAuth({ token: TOKEN, log, limiter: new AccessLimiter({ now }) });
    const results = Array.from({ length: 8 }, (_, i) => auth.check(req(`Bearer wrong-guess-${i}`)));
    expect(results.map((r) => (r.ok ? 200 : r.status))).toEqual([401, 401, 401, 401, 401, 401, 429, 429]);
    const failed = lines.filter((l) => l.includes('admin: auth failed'));
    expect(failed).toHaveLength(6);
    const first = JSON.parse(failed[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({ ip: '203.0.113.1', path: '/admin/access/invites', fails: 1, method: 'POST' });
    expect(lines.join('\n')).not.toContain('wrong-guess');
    expect(lines.some((l) => l.includes('admin: auth throttled'))).toBe(true);
    // 退避期内正确 token 也 429；别的 IP 不受影响；退避过后放行并清零
    expect(auth.check(req(`Bearer ${TOKEN}`))).toMatchObject({ ok: false, status: 429, retryAfterMs: 1000 });
    expect(auth.check(req(`Bearer ${TOKEN}`, '198.51.100.9'))).toEqual({ ok: true });
    t += 1000;
    expect(auth.check(req(`Bearer ${TOKEN}`))).toEqual({ ok: true });
    expect(auth.limiter.retryAfter('203.0.113.1')).toBe(0);
    // 缺少 Authorization 同样计失败
    expect(auth.check(req(undefined, '192.0.2.5'))).toMatchObject({ ok: false, status: 401 });
  });
});
