/**
 * 手动推进的时钟与调度器（design/net.md §11.1）：单测用 advance() 精确触发超时；
 * 集成测试可开 autoRunZero，让 0 延迟的定时器（AI 思考时间设为 0 时）自动在下一轮事件循环执行。
 */
import type { Clock, Scheduler, TimerHandle } from '../../src/infra/clock';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
  cancelled: boolean;
}

export interface ManualSchedulerOptions {
  start?: number;
  /** ms ≤ 0 的定时器用 setImmediate 自动执行（仍可取消） */
  autoRunZero?: boolean;
}

export class ManualScheduler implements Scheduler, Clock {
  private t: number;
  private nextId = 1;
  private timers: Timer[] = [];
  private readonly autoRunZero: boolean;

  constructor(opts: ManualSchedulerOptions = {}) {
    this.t = opts.start ?? Date.UTC(2026, 8, 27, 4, 0, 0);
    this.autoRunZero = opts.autoRunZero ?? false;
  }

  now(): number {
    return this.t;
  }

  after(ms: number, fn: () => void): TimerHandle {
    const timer: Timer = { id: this.nextId++, at: this.t + Math.max(0, ms), fn, cancelled: false };
    if (this.autoRunZero && ms <= 0) {
      setImmediate(() => {
        if (!timer.cancelled) {
          timer.cancelled = true;
          fn();
        }
      });
    } else {
      this.timers.push(timer);
    }
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  private nextDue(limit: number): Timer | undefined {
    this.timers = this.timers.filter((x) => !x.cancelled);
    let best: Timer | undefined;
    for (const x of this.timers) {
      if (x.at <= limit && (!best || x.at < best.at || (x.at === best.at && x.id < best.id))) best = x;
    }
    return best;
  }

  /** 推进 ms 毫秒，按时间顺序执行到期的定时器（执行中新建的到期定时器也会执行） */
  advance(ms: number): void {
    const target = this.t + Math.max(0, ms);
    for (let guard = 0; guard < 100_000; guard++) {
      const x = this.nextDue(target);
      if (!x) break;
      x.cancelled = true;
      this.t = Math.max(this.t, x.at);
      x.fn();
    }
    this.t = target;
  }

  /** 只执行已经到期的定时器 */
  runDue(): void {
    this.advance(0);
  }

  /** 一直跳到下一个定时器并执行，直到没有定时器（或达到上限） */
  runAll(limit = 10_000): number {
    let n = 0;
    for (; n < limit; n++) {
      const at = this.nextAt();
      if (at === null) break;
      this.advance(at - this.t);
    }
    return n;
  }

  /** 最早的未取消定时器时间 */
  nextAt(): number | null {
    let best: number | null = null;
    for (const x of this.timers) if (!x.cancelled && (best === null || x.at < best)) best = x.at;
    return best;
  }

  pendingCount(): number {
    return this.timers.filter((x) => !x.cancelled).length;
  }
}
