// 已解码 AudioBuffer 的 LRU 缓存（按字节计）：1374 段语音全部解码约 400 MB，只能按需加载、超预算淘汰最久未用的。
// 同一键的并发加载合并成一个 Promise；失败记为 null（来源变化时 clear() 后可重试）。
import type { AudioBufferLike } from './webaudio';

interface Slot {
  promise: Promise<AudioBufferLike | null>;
  buffer: AudioBufferLike | null;
  bytes: number;
  settled: boolean;
}

export function bufferBytes(b: AudioBufferLike): number {
  return b.length * b.numberOfChannels * 4;
}

export class BufferCache {
  private readonly slots = new Map<string, Slot>();
  private total = 0;
  private gen = 0;

  constructor(private readonly budgetBytes: number) {}

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.slots.size;
  }

  /** 已加载完成的缓冲（命中时刷新 LRU 次序） */
  peek(key: string): AudioBufferLike | null {
    const s = this.slots.get(key);
    if (!s?.settled || !s.buffer) return null;
    this.touch(key, s);
    return s.buffer;
  }

  has(key: string): boolean {
    return this.slots.has(key);
  }

  get(key: string, load: () => Promise<AudioBufferLike | null>): Promise<AudioBufferLike | null> {
    const hit = this.slots.get(key);
    if (hit) {
      this.touch(key, hit);
      return hit.promise;
    }
    const gen = this.gen;
    const slot: Slot = { promise: Promise.resolve(null), buffer: null, bytes: 0, settled: false };
    slot.promise = load().then(
      (b) => this.settle(key, slot, gen, b),
      () => this.settle(key, slot, gen, null),
    );
    this.slots.set(key, slot);
    return slot.promise;
  }

  clear(): void {
    this.slots.clear();
    this.total = 0;
    this.gen++;
  }

  private settle(key: string, slot: Slot, gen: number, b: AudioBufferLike | null): AudioBufferLike | null {
    slot.settled = true;
    slot.buffer = b;
    if (gen !== this.gen || this.slots.get(key) !== slot) return b;
    if (b) {
      slot.bytes = bufferBytes(b);
      this.total += slot.bytes;
      this.evict(key);
    }
    return b;
  }

  private touch(key: string, s: Slot): void {
    this.slots.delete(key);
    this.slots.set(key, s);
  }

  /** 超预算时从最久未用的开始淘汰（刚加载的 keep 不淘汰） */
  private evict(keep: string): void {
    if (this.total <= this.budgetBytes) return;
    for (const [k, s] of this.slots) {
      if (this.total <= this.budgetBytes) break;
      if (k === keep || !s.settled) continue;
      this.slots.delete(k);
      this.total -= s.bytes;
    }
  }
}
