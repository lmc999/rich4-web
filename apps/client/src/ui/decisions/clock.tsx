// 决策倒计时用的服务器时钟：主循环在上层提供 { now: () => Date.now() + clockOffsetMs }（time:ping 校准）。
import { createContext, type ReactNode, useContext, useMemo } from 'react';

export interface DecisionClock {
  /** 服务器时间估计（ms） */
  now(): number;
}

const SYSTEM_CLOCK: DecisionClock = { now: () => Date.now() };

export const DecisionClockContext = createContext<DecisionClock>(SYSTEM_CLOCK);

/** 以固定偏移构造时钟的 Provider（offsetMs = 服务器时间 − 本机时间） */
export function DecisionClockProvider({ offsetMs, children }: { offsetMs: number; children: ReactNode }): ReactNode {
  const value = useMemo<DecisionClock>(() => ({ now: () => Date.now() + offsetMs }), [offsetMs]);
  return <DecisionClockContext.Provider value={value}>{children}</DecisionClockContext.Provider>;
}

/** 返回 now 函数：优先用 override（DecisionProps.now），否则取上下文 */
export function useServerNow(override?: () => number): () => number {
  const ctx = useContext(DecisionClockContext);
  return override ?? ctx.now;
}
