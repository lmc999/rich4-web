// 决策倒计时（design/client.md §5.1）：对话框右上角圆环，最后 10 秒变红并跳动。
// deadlineAt 是服务器时间戳；now() 由调用方给出服务器时间估计（Date.now() + 时钟偏移）。
// 与画面中央的决策倒计时（ui/common/DecisionCountdown）同屏：紧急阈值同一个（COUNTDOWN_URGENT_S），轮询也对齐到整秒
// 边界（msToNextSecond），相邻的两个数字在同一时刻变化、同一时刻变红，不会一个 9 一个 10、一个红一个绿。
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { COUNTDOWN_URGENT_S, msToNextSecond } from '../common/countdownLogic';
import s from './components.module.css';

/** 进入最后这么多毫秒：变红、跳动（与中央倒计时的 COUNTDOWN_URGENT_S 同一档） */
export const URGENT_MS = COUNTDOWN_URGENT_S * 1000;
const TICK_MS = 200;

export interface Remaining {
  /** 剩余毫秒（≥0）；不限时为 null */
  remainingMs: number | null;
  /** 圆环满格对应的总时长：本决策首次出现时的剩余时间 */
  totalMs: number | null;
}

/**
 * 按 tickMs 轮询剩余时间（圆弧平滑），每次都不越过下一个整秒边界：显示的整秒数在跨秒的那一刻更新，
 * 与中央倒计时同步；resetKey（通常是 decisionId）变化时重新计总时长。到 0 后停止轮询。
 */
export function useRemainingMs(
  deadlineAt: number | null,
  now: () => number,
  resetKey: string,
  tickMs = TICK_MS,
): Remaining {
  const nowRef = useRef(now);
  nowRef.current = now;
  const compute = (): number | null => (deadlineAt === null ? null : Math.max(0, deadlineAt - nowRef.current()));
  const [ms, setMs] = useState<number | null>(compute);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 总时长只在决策或截止时间变化时重算
  const totalMs = useMemo(compute, [deadlineAt, resetKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: compute 读 ref，依赖 deadlineAt 即可
  useEffect(() => {
    const first = compute();
    setMs(first);
    if (first === null || first <= 0) return;
    let id: ReturnType<typeof setTimeout> | null = null;
    const next = (v: number): void => {
      id = setTimeout(loop, Math.min(tickMs, msToNextSecond(v)));
    };
    const loop = (): void => {
      id = null;
      const v = compute();
      setMs(v);
      if (v !== null && v > 0) next(v);
    };
    next(first);
    return () => {
      if (id !== null) clearTimeout(id);
    };
  }, [deadlineAt, resetKey, tickMs]);
  // 截止时间刚变化、effect 尚未跑时，用即时值，避免闪一下旧数字
  const live = deadlineAt === null ? null : (ms ?? compute());
  return { remainingMs: live, totalMs };
}

export interface CountdownRingProps {
  remainingMs: number | null;
  totalMs: number | null;
  size?: number;
}

export function CountdownRing({ remainingMs, totalMs, size = 44 }: CountdownRingProps): ReactNode {
  const { t } = useTranslation();
  if (remainingMs === null) {
    return (
      <span
        className={s.countdown}
        role="timer"
        aria-label={t('cmp.countdown.unlimited')}
        title={t('cmp.countdown.unlimited')}
        data-testid="countdown"
        style={{ width: size, height: size }}
      >
        <span className={s.countdownNum} aria-hidden="true">
          ∞
        </span>
      </span>
    );
  }
  const secs = Math.ceil(remainingMs / 1000);
  const frac = totalMs && totalMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalMs)) : remainingMs > 0 ? 1 : 0;
  const stroke = 5;
  const r = size / 2 - stroke / 2 - 1;
  const c = 2 * Math.PI * r;
  const urgent = remainingMs <= URGENT_MS;
  return (
    <span
      className={s.countdown}
      role="timer"
      aria-label={t('cmp.countdown.aria', { n: secs })}
      data-urgent={urgent ? 'true' : 'false'}
      data-testid="countdown"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className={s.countdownTrack} cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle
          className={s.countdownArc}
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
        />
      </svg>
      {/* 最后 10 秒每秒换 key：重新挂载数字，跳动从整秒边界播一次（与中央倒计时的提示音同拍） */}
      <span key={urgent ? secs : 'calm'} className={s.countdownNum}>
        {secs}
      </span>
    </span>
  );
}
