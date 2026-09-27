// 原版演出弹窗的外壳：Stage4x3 的只读场景（不抢焦点、不挡棋盘与工具列；与舞台同一落点与倍率，经 portal 挂到经典舞台），
// 根元素 data-testid="popup"、data-kind 与程序化弹窗层一致（E2E 两种皮肤共用）；最短展示时间之后出现「点一下跳过」。
// 另有 useTicker（演出用的真实时间节拍，减少动态时不走）。
import { useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useState } from 'react';
import { useTx } from '../../../i18n/tx';
import { type SceneBackdrop, Stage4x3 } from '../common/Stage4x3';
import { TEXT } from '../common/textStyles';
import pp from './popups.module.css';

export interface PopupSceneProps {
  kind: string;
  label: string;
  /** 最短展示时间（真实毫秒）：之后出现跳过钮 */
  minMs: number;
  onSkip: () => void;
  backdrop?: SceneBackdrop;
  testId?: string;
  attrs?: Readonly<Record<`data-${string}`, string | undefined>>;
  children?: ReactNode;
}

export function PopupScene({
  kind,
  label,
  minMs,
  onSkip,
  backdrop = 'none',
  testId = 'popup',
  attrs,
  children,
}: PopupSceneProps): ReactNode {
  const t = useTx();
  const [skippable, setSkippable] = useState(false);
  useEffect(() => {
    setSkippable(false);
    const id = setTimeout(() => setSkippable(true), Math.max(0, minMs));
    return () => clearTimeout(id);
  }, [minMs]);
  return (
    <Stage4x3
      testId={testId}
      label={label}
      readOnly
      interactive
      backdrop={backdrop}
      attrs={{ 'data-kind': kind, 'data-skippable': skippable ? 'true' : 'false', 'data-classic': 'true', ...attrs }}
    >
      {children}
      {skippable && (
        <button
          type="button"
          className={pp.skip}
          style={TEXT.small}
          onClick={onSkip}
          data-testid={testId === 'popup' ? 'popup-skip' : `${testId}-skip`}
        >
          {t('events:popup.skip')}
        </button>
      )}
    </Stage4x3>
  );
}

/** 真实时间节拍：active 时每 ms 加一（减少动态时不走，停在 0） */
export function useTicker(active: boolean, ms: number): number {
  const reduce = useReducedMotion();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active || reduce) return;
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [active, ms, reduce]);
  return n;
}

/** 从挂载起经过的真实毫秒数（每 stepMs 更新一次，到 untilMs 为止；减少动态时直接为 untilMs） */
export function useElapsed(untilMs: number, stepMs = 50): number {
  const reduce = useReducedMotion();
  const [t0] = useState(() => Date.now());
  const [ms, setMs] = useState(reduce ? untilMs : 0);
  useEffect(() => {
    if (reduce) {
      setMs(untilMs);
      return;
    }
    const id = setInterval(() => {
      const v = Math.min(untilMs, Date.now() - t0);
      setMs(v);
      if (v >= untilMs) clearInterval(id);
    }, stepMs);
    return () => clearInterval(id);
  }, [untilMs, stepMs, reduce, t0]);
  return ms;
}
