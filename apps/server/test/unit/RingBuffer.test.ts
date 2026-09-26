import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../../src/game/RingBuffer';

const item = (seq: number) => ({ seq });

describe('RingBuffer', () => {
  it('保留最近 capacity 条，since 返回 (lastSeq, last]，丢失的区间返回 null', () => {
    const r = new RingBuffer<{ seq: number }>(3);
    expect(r.since(0)).toBeNull();
    for (let s = 1; s <= 5; s++) r.push(item(s));
    expect(r.size).toBe(3);
    expect(r.toArray().map((x) => x.seq)).toEqual([3, 4, 5]);
    expect(r.since(2)!.map((x) => x.seq)).toEqual([3, 4, 5]);
    expect(r.since(4)!.map((x) => x.seq)).toEqual([5]);
    expect(r.since(5)).toEqual([]);
    expect(r.since(9)).toEqual([]);
    expect(r.since(1)).toBeNull();
  });

  it('seq 必须递增；capacity 必须为正', () => {
    const r = new RingBuffer<{ seq: number }>(2);
    r.push(item(1));
    expect(() => r.push(item(1))).toThrow(RangeError);
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    r.clear();
    expect(r.size).toBe(0);
    r.push(item(1));
    expect(r.first()?.seq).toBe(1);
  });
});
