// 语音通道：同一时刻只播一条（design-draft §3.7；r_minigames_chars §2.4「讲话气泡 + 语音，至少停留 1000 ms（阻塞）」）。
//
// 原版讲话是阻塞的：气泡与语音至少停留 1000 ms 才继续，所以两句话不会重叠，后一句最早在前一句开始 1000 ms 后才开口；
// 网页版不能阻塞演出，于是按「原版阻塞语义」排队：
// - original（缺省）：先进先出；当前一句开口满 minHoldMs 后，下一句打断它开口（前一句若已自然结束，也要等满 minHoldMs）；
// - queue：先进先出，等当前一句自然结束（且满 minHoldMs）再开口（开局宣言逐人播完整句）；
// - interrupt：清空队列、立即打断当前一句。
// 排队超过 maxWaitMs 仍未开口的语音作废（dropped），避免与演出错位；队列超过 maxQueue 时丢最早的。
import type { AudioBufferLike } from './webaudio';

export type VoicePolicy = 'original' | 'queue' | 'interrupt';

export type VoiceOutcome = 'ended' | 'interrupted' | 'dropped' | 'missing' | 'disabled' | 'cancelled';

export interface VoiceRequest {
  key: string;
  /** 说话者（`seat:2`、`npc`、`news`），只用于日志与试听页 */
  speaker?: string;
  policy?: VoicePolicy;
  /** 排队上限（毫秒），缺省取通道设置 */
  maxWaitMs?: number;
}

export interface VoiceChannelOptions {
  minHoldMs: number;
  maxWaitMs: number;
  maxQueue: number;
}

export const DEFAULT_VOICE_OPTIONS: Readonly<VoiceChannelOptions> = Object.freeze({
  minHoldMs: 1000,
  maxWaitMs: 2500,
  maxQueue: 4,
});

/** 通道依赖（引擎注入；测试注入假实现） */
export interface VoiceDeps {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  load(key: string): Promise<AudioBufferLike | null>;
  /** 开始播放；onEnd 在自然结束时调用（stop() 之后不再调用） */
  start(key: string, buffer: AudioBufferLike, onEnd: () => void): { stop(): void };
  /** 有语音在播时 true（引擎据此压低 BGM） */
  onActive(active: boolean): void;
  log(op: string, key: string, detail?: string): void;
}

interface Item {
  req: VoiceRequest;
  policy: VoicePolicy;
  maxWaitMs: number;
  requestedAt: number;
  buffer: AudioBufferLike | null | undefined;
  loading: Promise<void>;
  resolve(o: VoiceOutcome): void;
}

interface Current {
  item: Item;
  startedAt: number;
  handle: { stop(): void };
}

export interface VoiceStatus {
  key: string;
  speaker: string | undefined;
  startedAt: number;
}

export class VoiceChannel {
  private readonly queue: Item[] = [];
  private current: Current | null = null;
  /** 最近一句开口的时刻（当前一句已结束时仍用于 minHold） */
  private lastStart = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private readonly opts: VoiceChannelOptions;

  constructor(
    private readonly deps: VoiceDeps,
    opts?: Partial<VoiceChannelOptions>,
  ) {
    this.opts = { ...DEFAULT_VOICE_OPTIONS, ...opts };
  }

  get status(): VoiceStatus | null {
    const c = this.current;
    return c ? { key: c.item.req.key, speaker: c.item.req.speaker, startedAt: c.startedAt } : null;
  }

  get queued(): number {
    return this.queue.length;
  }

  speak(req: VoiceRequest): Promise<VoiceOutcome> {
    const policy = req.policy ?? 'original';
    return new Promise<VoiceOutcome>((resolve) => {
      const item: Item = {
        req,
        policy,
        maxWaitMs: req.maxWaitMs ?? this.opts.maxWaitMs,
        requestedAt: this.deps.now(),
        buffer: undefined,
        loading: Promise.resolve(),
        resolve,
      };
      // 立即开始加载（与排队并行）
      item.loading = this.deps.load(req.key).then(
        (b) => {
          item.buffer = b;
        },
        () => {
          item.buffer = null;
        },
      );
      if (policy === 'interrupt') {
        this.dropQueue('dropped');
        this.queue.push(item);
        this.stopCurrent('interrupted');
        this.lastStart = Number.NEGATIVE_INFINITY;
      } else {
        this.queue.push(item);
        while (this.queue.length > this.opts.maxQueue) this.finish(this.queue.shift()!, 'dropped');
      }
      this.deps.log('request', req.key, policy);
      void item.loading.then(() => this.pump());
      this.pump();
    });
  }

  /** 停止当前与排队中的全部语音 */
  stopAll(outcome: VoiceOutcome = 'cancelled'): void {
    this.dropQueue(outcome);
    this.stopCurrent(outcome);
    this.lastStart = Number.NEGATIVE_INFINITY;
  }

  private dropQueue(outcome: VoiceOutcome): void {
    for (const it of this.queue.splice(0)) this.finish(it, outcome);
  }

  private stopCurrent(outcome: VoiceOutcome): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    c.handle.stop();
    this.deps.log('stop', c.item.req.key, outcome);
    this.finish(c.item, outcome);
    this.deps.onActive(false);
  }

  private finish(it: Item, outcome: VoiceOutcome): void {
    if (outcome === 'dropped' || outcome === 'missing') this.deps.log(outcome, it.req.key);
    it.resolve(outcome);
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = this.deps.setTimeout(
      () => {
        this.timer = null;
        this.pump();
      },
      Math.max(0, ms),
    );
  }

  private pump(): void {
    for (;;) {
      const head = this.queue[0];
      if (!head) return;
      const now = this.deps.now();
      if (now - head.requestedAt > head.maxWaitMs) {
        this.queue.shift();
        this.finish(head, 'dropped');
        continue;
      }
      if (head.buffer === undefined) return; // 加载完成后 loading.then 会再 pump
      if (head.buffer === null) {
        this.queue.shift();
        this.finish(head, 'missing');
        continue;
      }
      const holdUntil = head.policy === 'interrupt' ? now : this.lastStart + this.opts.minHoldMs;
      if (this.current && head.policy === 'queue') return; // 等当前一句自然结束
      if (now < holdUntil) {
        // 等到可以开口，但不晚于作废时刻
        this.schedule(Math.min(holdUntil, head.requestedAt + head.maxWaitMs + 1) - now);
        return;
      }
      this.queue.shift();
      this.stopCurrent('interrupted');
      this.begin(head, head.buffer, now);
    }
  }

  private begin(item: Item, buffer: AudioBufferLike, now: number): void {
    const cur: Current = { item, startedAt: now, handle: { stop: () => {} } };
    this.current = cur;
    this.lastStart = now;
    this.deps.onActive(true);
    this.deps.log('start', item.req.key, item.req.speaker);
    cur.handle = this.deps.start(item.req.key, buffer, () => {
      if (this.current !== cur) return;
      this.current = null;
      this.deps.log('end', item.req.key);
      this.deps.onActive(false);
      item.resolve('ended');
      this.pump();
    });
  }
}
