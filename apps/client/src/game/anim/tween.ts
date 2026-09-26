// 由 AnimClock 驱动的补间：支持倍速（跟随时钟）、中止（直接跳到终值并 resolve）与 instant 模式。
import type { AnimClock } from './AnimClock';
import { type Ease, linear } from './easing';

export interface TweenOptions {
  clock: AnimClock;
  ease?: Ease;
  signal?: AbortSignal;
  /** 每次写入数值后回调（例如同步深度） */
  onUpdate?: (progress: number) => void;
}

type NumericKeys<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

/** 数值通用补间：apply(v) 每帧写入，v 从 from 到 to */
export function tweenValue(
  from: number,
  to: number,
  ms: number,
  apply: (v: number, progress: number) => void,
  o: TweenOptions,
): Promise<void> {
  const ease = o.ease ?? linear;
  const finish = (): void => {
    apply(to, 1);
    o.onUpdate?.(1);
  };
  if (o.clock.instant || ms <= 0 || o.signal?.aborted) {
    finish();
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const start = o.clock.now();
    let done = false;
    const end = (): void => {
      if (done) return;
      done = true;
      off();
      o.signal?.removeEventListener('abort', onAbort);
      finish();
      resolve();
    };
    const onAbort = (): void => end();
    const off = o.clock.onFrame((now) => {
      if (o.clock.instant) return end();
      const p = Math.min(1, (now - start) / ms);
      if (p >= 1) return end();
      apply(from + (to - from) * ease(p), p);
      o.onUpdate?.(p);
    });
    o.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 对象属性补间：to 中的每个数值属性从当前值补间到目标值 */
export function tween<T extends object>(
  obj: T,
  to: Partial<Pick<T, NumericKeys<T>>>,
  ms: number,
  o: TweenOptions,
): Promise<void> {
  const keys = Object.keys(to) as (keyof T)[];
  const target = obj as Record<keyof T, number>;
  const goal = to as unknown as Record<keyof T, number>;
  const from = keys.map((k) => target[k]);
  return tweenValue(
    0,
    1,
    ms,
    (v) => {
      keys.forEach((k, i) => {
        const a = from[i] ?? 0;
        target[k] = a + (goal[k] - a) * v;
      });
    },
    { ...o, ease: o.ease ?? linear },
  );
}
