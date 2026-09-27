// 门禁防暴力：按 IP 的退避延迟 + 全局软上限（排队而不是硬锁）
import { describe, expect, it } from 'vitest';
import { AccessLimiter } from '../../src/access/limiter';

function clock(t0 = 1_000_000) {
  let t = t0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('AccessLimiter', () => {
  it('前 5 次失败不退避；之后 1s、2s、4s… 封顶 30s；窗口内 429，过了窗口可以再试', () => {
    const c = clock();
    const l = new AccessLimiter({ now: c.now, globalPerMin: 1e6, globalBurst: 1e6 });
    for (let i = 0; i < 5; i++) {
      expect(l.admit('1.1.1.1')).toEqual({ ok: true, waitMs: 0 });
      l.fail('1.1.1.1');
      l.release('1.1.1.1');
    }
    expect(l.retryAfter('1.1.1.1')).toBe(0);
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      expect(l.admit('1.1.1.1').ok).toBe(true);
      l.fail('1.1.1.1');
      l.release('1.1.1.1');
      const wait = l.retryAfter('1.1.1.1');
      delays.push(wait);
      const blocked = l.admit('1.1.1.1');
      expect(blocked).toEqual({ ok: false, retryAfterMs: wait, scope: 'ip' });
      c.advance(wait);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    // 别的 IP 不受影响
    expect(l.admit('2.2.2.2')).toEqual({ ok: true, waitMs: 0 });
  });

  it('成功一次清零；距上次失败超过 30 分钟也清零（不是硬锁）', () => {
    const c = clock();
    const l = new AccessLimiter({ now: c.now, globalPerMin: 1e6, globalBurst: 1e6 });
    for (let i = 0; i < 7; i++) l.fail('ip');
    expect(l.retryAfter('ip')).toBeGreaterThan(0);
    l.success('ip');
    expect(l.retryAfter('ip')).toBe(0);
    for (let i = 0; i < 7; i++) l.fail('ip');
    c.advance(30 * 60_000 + 1);
    expect(l.retryAfter('ip')).toBe(0);
    l.fail('ip');
    expect(l.retryAfter('ip')).toBe(0); // 重新从第 1 次算
    expect(l.trackedIps).toBe(1);
  });

  it('全局软上限：名额用完后排队等待（waitMs 递增），预计等待超过 maxWaitMs 才 429', () => {
    const c = clock();
    const l = new AccessLimiter({ now: c.now, globalPerMin: 60, globalBurst: 2, maxWaitMs: 3000 });
    expect(l.admit('a')).toEqual({ ok: true, waitMs: 0 });
    expect(l.admit('b')).toEqual({ ok: true, waitMs: 0 });
    expect(l.admit('c')).toEqual({ ok: true, waitMs: 1000 });
    expect(l.admit('d')).toEqual({ ok: true, waitMs: 2000 });
    expect(l.admit('e')).toEqual({ ok: true, waitMs: 3000 });
    expect(l.admit('f')).toMatchObject({ ok: false, scope: 'global' });
    c.advance(5000);
    expect(l.admit('g')).toEqual({ ok: true, waitMs: 0 });
  });

  it('同一 IP 并发：在途的验证按失败预计——免费额度内最多 6 个并行，进入退避后同一时刻至多 1 个；占不满全局名额', () => {
    const c = clock();
    // 默认参数：前 5 次免费、全局每分钟 30 个、桶容量 6、排队最多 10 秒
    const l = new AccessLimiter({ now: c.now });
    const attacker = '203.0.113.66';
    const burst = Array.from({ length: 20 }, () => l.admit(attacker));
    const admitted = burst.filter((a) => a.ok).length;
    expect(admitted).toBe(6);
    expect(burst.slice(6).every((a) => !a.ok && a.scope === 'ip')).toBe(true);
    expect(l.inFlight(attacker)).toBe(6);
    // 同一时刻别的 IP 仍能排上队（不会 429 scope=global）
    const other = l.admit('198.51.100.1');
    expect(other.ok).toBe(true);
    l.release('198.51.100.1');
    // 在途的全部失败
    for (let i = 0; i < admitted; i++) {
      l.fail(attacker);
      l.release(attacker);
    }
    expect(l.inFlight(attacker)).toBe(0);
    // 退避窗口过后再并发 20 个：只放行 1 个
    for (let round = 0; round < 3; round++) {
      c.advance(l.retryAfter(attacker));
      const again = Array.from({ length: 20 }, () => l.admit(attacker));
      expect(again.filter((a) => a.ok).length, `round ${round}`).toBe(1);
      expect(again.filter((a) => !a.ok).every((a) => !a.ok && a.scope === 'ip')).toBe(true);
      l.fail(attacker);
      l.release(attacker);
      // 正常用户：每轮之后都能进（最多排队，不被全局 429）
      c.advance(1);
      const user = l.admit(`192.0.2.${round}`);
      expect(user.ok, `user after round ${round}`).toBe(true);
      l.release(`192.0.2.${round}`);
    }
  });

  it('30 秒退避上限下，单个 IP 并发攻击每个窗口只能验证 1 次', () => {
    const c = clock();
    const l = new AccessLimiter({ now: c.now });
    const ip = '203.0.113.7';
    for (let i = 0; i < 12; i++) {
      c.advance(l.retryAfter(ip));
      expect(l.admit(ip).ok).toBe(true);
      l.fail(ip);
      l.release(ip);
    }
    expect(l.retryAfter(ip)).toBe(30_000);
    let verified = 0;
    for (let t = 0; t < 60_000; t += 500) {
      const batch = Array.from({ length: 5 }, () => l.admit(ip));
      for (const a of batch) {
        if (!a.ok) continue;
        verified++;
        l.fail(ip);
        l.release(ip);
      }
      c.advance(500);
    }
    expect(verified).toBeLessThanOrEqual(2);
  });

  it('release 不配对时不会变成负数；在途数为 0 时 retryAfter 只看已记的失败', () => {
    const c = clock();
    const l = new AccessLimiter({ now: c.now });
    l.release('x');
    expect(l.inFlight('x')).toBe(0);
    expect(l.admit('x').ok).toBe(true);
    expect(l.inFlight('x')).toBe(1);
    l.release('x');
    l.release('x');
    expect(l.inFlight('x')).toBe(0);
    expect(l.retryAfter('x')).toBe(0);
  });

  it('每分钟全局失败达到阈值时报一次告警', () => {
    const c = clock();
    const l = new AccessLimiter({ now: c.now, alarmPerMin: 3 });
    expect(l.fail('a').alarm).toBe(false);
    expect(l.fail('b').alarm).toBe(false);
    expect(l.fail('c').alarm).toBe(true);
    expect(l.fail('d').alarm).toBe(false);
    c.advance(60_000);
    l.fail('e');
    l.fail('f');
    expect(l.fail('g').alarm).toBe(true);
  });
});
