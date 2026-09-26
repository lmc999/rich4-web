// 可变速、可中止、可在测试中手动推进的动画时钟（design/client.md §4.2）。
// GameRenderer 每帧以真实 dt 调用 advance；测试直接 advance 固定步长即为「假时钟」。
// speed 是倍速：speed=2 时动画在一半真实时间内播完。instant=true 时一切等待与补间立即完成（后台标签页 / ?anim=instant）。

export type FrameCallback = (now: number, dt: number) => void;

interface Waiter {
  at: number;
  seq: number;
  resolve: () => void;
  cleanup: () => void;
}

export class AnimClock {
  private t = 0;
  private seq = 0;
  private _speed = 1;
  private waiters: Waiter[] = [];
  private readonly frames = new Set<FrameCallback>();
  /** 立即模式：wait/tween 不等待，直接到终态 */
  instant = false;

  get speed(): number {
    return this._speed;
  }

  set speed(s: number) {
    if (!(s > 0) || !Number.isFinite(s)) throw new RangeError(`AnimClock speed must be > 0, got ${s}`);
    this._speed = s;
  }

  /** 时钟时间（毫秒，已乘倍速） */
  now(): number {
    return this.t;
  }

  /**
   * 推进真实毫秒 realDtMs；返回本次推进的时钟毫秒。
   * 帧回调彼此隔离：某个回调抛错（例如补间在写已销毁的 Pixi 对象）只注销它自己并报告，
   * 其余回调与到期的 wait 照常执行，调用方（rAF 驱动）不会因此中断。
   */
  advance(realDtMs: number): number {
    if (!(realDtMs > 0)) return 0;
    const dt = realDtMs * this._speed;
    this.t += dt;
    try {
      // 帧回调在迭代副本上执行，允许回调内注销自己
      for (const cb of [...this.frames]) {
        if (!this.frames.has(cb)) continue;
        try {
          cb(this.t, dt);
        } catch (err) {
          this.frames.delete(cb);
          this.onError(err);
        }
      }
    } finally {
      this.flushWaiters();
    }
    return dt;
  }

  /** 帧回调出错时的报告（测试可替换） */
  onError: (err: unknown) => void = (err) => console.error('[AnimClock] frame callback failed', err);

  /** 每次 advance 调用一次；返回注销函数 */
  onFrame(cb: FrameCallback): () => void {
    this.frames.add(cb);
    return () => {
      this.frames.delete(cb);
    };
  }

  get activeFrames(): number {
    return this.frames.size;
  }

  get pendingWaits(): number {
    return this.waiters.length;
  }

  /** 等待 ms 时钟毫秒；signal 中止或 instant 时立即 resolve（不 reject，便于 skip 流程直落终态） */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.instant || ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onAbort = (): void => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve();
      };
      const waiter: Waiter = {
        at: this.t + ms,
        seq: this.seq++,
        resolve,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** 立即完成所有等待（skipAll / reset 用） */
  flushAll(): void {
    const all = this.waiters;
    this.waiters = [];
    for (const w of all) {
      w.cleanup();
      w.resolve();
    }
  }

  private flushWaiters(): void {
    if (this.waiters.length === 0) return;
    const due = this.waiters.filter((w) => w.at <= this.t).sort((a, b) => a.at - b.at || a.seq - b.seq);
    if (due.length === 0) return;
    this.waiters = this.waiters.filter((w) => w.at > this.t);
    for (const w of due) {
      w.cleanup();
      w.resolve();
    }
  }
}
