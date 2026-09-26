/**
 * 6 位数字房间号（design/net.md §3.1）：100000–999999，CSPRNG 生成，碰撞重试，释放后 24 小时内不复用。
 */
import { randomInt as cryptoRandomInt } from 'node:crypto';
import { ROOM_CODE_MAX, ROOM_CODE_MIN } from '@rich4/shared/net';
import type { Clock } from '../infra/clock';

export const ROOM_CODE_REUSE_MS = 24 * 60 * 60 * 1000;

export interface RoomCodeAllocatorOptions {
  clock: Clock;
  /** [min, maxExclusive) 的均匀随机整数 */
  randomInt?: (min: number, maxExclusive: number) => number;
  reuseAfterMs?: number;
  maxAttempts?: number;
}

export class RoomCodeAllocator {
  private readonly clock: Clock;
  private readonly randomInt: (min: number, maxExclusive: number) => number;
  private readonly reuseAfterMs: number;
  private readonly maxAttempts: number;
  /** 最近释放的房间号 → 释放时间 */
  private readonly released = new Map<string, number>();

  constructor(o: RoomCodeAllocatorOptions) {
    this.clock = o.clock;
    this.randomInt = o.randomInt ?? cryptoRandomInt;
    this.reuseAfterMs = o.reuseAfterMs ?? ROOM_CODE_REUSE_MS;
    this.maxAttempts = o.maxAttempts ?? 64;
  }

  private purge(now: number): void {
    for (const [code, at] of this.released) {
      if (now - at >= this.reuseAfterMs) this.released.delete(code);
    }
  }

  /** 分配一个未占用且 24 小时内未释放过的房间号；重试耗尽时返回 null */
  allocate(isTaken: (code: string) => boolean): string | null {
    const now = this.clock.now();
    this.purge(now);
    for (let i = 0; i < this.maxAttempts; i++) {
      const code = String(this.randomInt(ROOM_CODE_MIN, ROOM_CODE_MAX + 1));
      if (!isTaken(code) && !this.released.has(code)) return code;
    }
    return null;
  }

  release(code: string): void {
    this.released.set(code, this.clock.now());
  }

  /** 冷却中的房间号数量（测试与统计用） */
  coolingCount(): number {
    this.purge(this.clock.now());
    return this.released.size;
  }
}
