/**
 * 时钟与调度（design/net.md §11.1）。GameRunner、Room 等只依赖这两个接口，测试注入 ManualScheduler。
 * 本文件不得引入 node:*（src/game 会 import 它的类型）。
 */

export interface Clock {
  /** 毫秒时间戳 */
  now(): number;
}

export interface TimerHandle {
  cancel(): void;
}

export interface Scheduler {
  /** ms 毫秒后调用 fn；ms ≤ 0 表示尽快（异步）执行 */
  after(ms: number, fn: () => void): TimerHandle;
}

export const realClock: Clock = { now: () => Date.now() };

/**
 * 基于 setTimeout 的调度器；定时器 unref，不阻止进程退出。
 * 回调抛出的异常在这里兜住并交给 onError（默认写 stderr）：setTimeout 里未捕获的异常会变成
 * uncaughtException，让所有房间一起掉线。GameRunner 自己的回调另有 guarded 包装（记日志并暂停房间）。
 */
export class RealScheduler implements Scheduler {
  constructor(private readonly onError: (err: unknown) => void = defaultTimerError) {}

  after(ms: number, fn: () => void): TimerHandle {
    const t = setTimeout(
      () => {
        try {
          fn();
        } catch (err) {
          try {
            this.onError(err);
          } catch {
            // onError 本身出错也不能外抛
          }
        }
      },
      Math.max(0, ms),
    );
    (t as { unref?: () => void }).unref?.();
    return { cancel: () => clearTimeout(t) };
  }
}

function defaultTimerError(err: unknown): void {
  console.error('timer callback threw', err);
}

export const NO_TIMER: TimerHandle = Object.freeze({ cancel() {} });

/** 毫秒时间戳 → 本地日期 DateNum（y*10000+m*100+d） */
export function dateNumOf(ms: number): number {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
