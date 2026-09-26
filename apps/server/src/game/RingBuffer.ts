/**
 * 最近 N 个原始 batch 的环形缓冲（design/net.md §5.2）：补发时按观察者实时脱敏，缓冲里只存原始事件。
 */

export class RingBuffer<T extends { seq: number }> {
  private readonly items: (T | undefined)[];
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('RingBuffer capacity must be positive');
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** seq 必须严格递增 */
  push(item: T): void {
    const last = this.last();
    if (last && item.seq <= last.seq) throw new RangeError(`RingBuffer: seq ${item.seq} <= ${last.seq}`);
    if (this.count < this.capacity) {
      this.items[(this.start + this.count) % this.capacity] = item;
      this.count++;
    } else {
      this.items[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  first(): T | undefined {
    return this.count === 0 ? undefined : this.items[this.start];
  }

  last(): T | undefined {
    return this.count === 0 ? undefined : this.items[(this.start + this.count - 1) % this.capacity];
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.start + i) % this.capacity]!);
    return out;
  }

  /**
   * seq > lastSeq 的全部条目；缓冲已丢失 (lastSeq, first.seq) 之间的条目时返回 null。
   * seq 必须连续（GameRunner 每应用一个 action 加 1）。
   */
  since(lastSeq: number): T[] | null {
    const first = this.first();
    const last = this.last();
    if (!first || !last) return null;
    if (lastSeq >= last.seq) return [];
    if (lastSeq < first.seq - 1) return null;
    return this.toArray().filter((x) => x.seq > lastSeq);
  }

  clear(): void {
    this.items.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}
