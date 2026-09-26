import { RATE_LIMITS } from '@rich4/shared/net';
import { describe, expect, it } from 'vitest';
import { bucketOf, RateLimiter, TokenBucket } from '../../src/net/rateLimit';

describe('rateLimit', () => {
  it('令牌桶：突发额度用完后拒绝，按速率补充', () => {
    const b = new TokenBucket({ count: 10, perMs: 1000, burst: 20 }, 0);
    for (let i = 0; i < 20; i++) expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(99)).toBe(false);
    expect(b.take(100)).toBe(true);
    expect(b.take(100)).toBe(false);
    expect(b.peek(10_000)).toBe(true);
    for (let i = 0; i < 20; i++) expect(b.take(10_000)).toBe(true);
    expect(b.take(10_000)).toBe(false);
  });

  it('聊天每 10 秒 5 条；表情冷却 1.5 秒；不同 socket、不同分组互不影响', () => {
    let now = 0;
    const rl = new RateLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) expect(rl.take('s1', 'chat:send')).toBe(true);
    expect(rl.take('s1', 'chat:send')).toBe(false);
    expect(rl.take('s2', 'chat:send')).toBe(true);
    expect(rl.take('s1', 'chat:emote')).toBe(true);
    expect(rl.take('s1', 'chat:emote')).toBe(false);
    now = 1500;
    expect(rl.take('s1', 'chat:emote')).toBe(true);
    now = 2000;
    expect(rl.take('s1', 'chat:send')).toBe(true);
    expect(rl.take('s1', 'chat:send')).toBe(false);
  });

  it('bucketOf：有专属额度的事件用自己的桶，其余 room/lobby/saves/game 共用 room 桶', () => {
    expect(bucketOf('game:act')).toBe('game:act');
    expect(bucketOf('time:ping')).toBe('time:ping');
    expect(bucketOf('room:join')).toBe('room');
    expect(bucketOf('lobby:list')).toBe('room');
    expect(bucketOf('game:resync')).toBe('room');
    expect(bucketOf('saves:list')).toBe('room');
    expect(RATE_LIMITS['game:act']).toEqual({ count: 10, perMs: 1000, burst: 20 });
  });

  it('按 IP：join 失败每分钟 20 次（peek 不扣）；建房每分钟 5 次', () => {
    let now = 0;
    const rl = new RateLimiter({ now: () => now });
    for (let i = 0; i < 20; i++) {
      expect(rl.peekIp('1.2.3.4', 'joinFail')).toBe(true);
      expect(rl.takeIp('1.2.3.4', 'joinFail')).toBe(true);
    }
    expect(rl.peekIp('1.2.3.4', 'joinFail')).toBe(false);
    expect(rl.peekIp('5.6.7.8', 'joinFail')).toBe(true);
    for (let i = 0; i < 5; i++) expect(rl.takeIp('1.2.3.4', 'create')).toBe(true);
    expect(rl.takeIp('1.2.3.4', 'create')).toBe(false);
    now = 60_000;
    expect(rl.peekIp('1.2.3.4', 'joinFail')).toBe(true);
  });

  it('forget 释放会话的桶；scale 放宽额度，scale=0 关闭限流', () => {
    const rl = new RateLimiter({ now: () => 0 });
    rl.take('s1', 'game:act');
    rl.take('s1', 'room');
    rl.take('s2', 'room');
    expect(rl.size).toBe(3);
    rl.forget('s1');
    expect(rl.size).toBe(1);
    const wide = new RateLimiter({ now: () => 0, scale: 10 });
    for (let i = 0; i < 50; i++) expect(wide.take('s', 'chat:send')).toBe(true);
    expect(wide.take('s', 'chat:send')).toBe(false);
    const off = new RateLimiter({ now: () => 0, scale: 0 });
    for (let i = 0; i < 1000; i++) expect(off.take('s', 'chat:send')).toBe(true);
  });

  it('prune 清理空闲超过 10 分钟的桶（按会话与按 IP 一视同仁）', () => {
    let now = 0;
    const rl = new RateLimiter({ now: () => now });
    rl.takeIp('1.1.1.1', 'create');
    rl.take('tok-1', 'room');
    now = 11 * 60_000;
    rl.takeIp('2.2.2.2', 'create');
    rl.take('tok-2', 'room');
    rl.prune();
    expect(rl.size).toBe(2);
    expect(rl.peekIp('2.2.2.2', 'create')).toBe(true);
  });

  it('按会话计：同一 tokenHash 的新连接沿用同一个桶（重连不重置额度）', () => {
    let now = 0;
    const rl = new RateLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) expect(rl.take('tok-A', 'chat:send')).toBe(true);
    expect(rl.take('tok-A', 'chat:send')).toBe(false);
    // 断开后不再 forget：「重连」用同一 tokenHash 仍然受限，直到按速率补充
    expect(rl.take('tok-A', 'chat:send')).toBe(false);
    now = 2000;
    expect(rl.take('tok-A', 'chat:send')).toBe(true);
    expect(rl.take('tok-A', 'chat:send')).toBe(false);
  });
});
