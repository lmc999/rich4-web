import { ROOM_CODE_RE } from '@rich4/shared/net';
import { describe, expect, it } from 'vitest';
import { ROOM_CODE_REUSE_MS, RoomCodeAllocator } from '../../src/rooms/roomCode';

function clockAt(t: { now: number }) {
  return { now: () => t.now };
}

describe('roomCode', () => {
  it('6 位数字，范围 100000–999999，默认用 CSPRNG', () => {
    const a = new RoomCodeAllocator({ clock: clockAt({ now: 0 }) });
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = a.allocate((x) => seen.has(x))!;
      expect(c).toMatch(ROOM_CODE_RE);
      expect(Number(c)).toBeGreaterThanOrEqual(100000);
      expect(Number(c)).toBeLessThanOrEqual(999999);
      expect(seen.has(c)).toBe(false);
      seen.add(c);
    }
  });

  it('碰撞时重试；重试耗尽返回 null', () => {
    const seq = [123456, 123456, 234567];
    let i = 0;
    const a = new RoomCodeAllocator({ clock: clockAt({ now: 0 }), randomInt: () => seq[i++ % seq.length]! });
    expect(a.allocate((c) => c === '123456')).toBe('234567');
    const stuck = new RoomCodeAllocator({ clock: clockAt({ now: 0 }), randomInt: () => 555555, maxAttempts: 5 });
    expect(stuck.allocate((c) => c === '555555')).toBeNull();
  });

  it('释放后 24 小时内不复用，之后可以复用', () => {
    const t = { now: 1000 };
    const a = new RoomCodeAllocator({ clock: clockAt(t), randomInt: () => 777777, maxAttempts: 3 });
    expect(a.allocate(() => false)).toBe('777777');
    a.release('777777');
    expect(a.coolingCount()).toBe(1);
    t.now += ROOM_CODE_REUSE_MS - 1;
    expect(a.allocate(() => false)).toBeNull();
    t.now += 1;
    expect(a.allocate(() => false)).toBe('777777');
    expect(a.coolingCount()).toBe(0);
  });
});
