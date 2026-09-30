// 原版演出弹窗的外壳：Stage4x3 的只读场景（不抢焦点、不挡棋盘与工具列；与舞台同一落点与倍率，经 portal 挂到经典舞台），
// 根元素 data-testid="popup"、data-kind 与程序化弹窗层一致（E2E 两种皮肤共用）；最短展示时间之后出现「点一下跳过」
// （网页版的钮）。亮卡照原版：不画跳过钮，从一开始任意鼠标键放开或按键放开就结束（anyInputSkips）。
// 另有 useTicker（演出用的真实时间节拍，减少动态时不走）。
import { useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
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
  /**
   * 原版的跳过方式（亮卡）：不画跳过钮、没有最短时间，页面上任意鼠标左 / 右键放开或按键放开（焦点在输入框里打字时除外）
   * 就结束——exe 亮卡的等待 fcn.00450f9a(1500) 在 PeekMessage 循环里遇到 WM_LBUTTONUP / WM_RBUTTONUP / WM_KEYUP 即返回。
   * 只是监听、不拦截：点到的工具列、棋盘照常响应；只算亮卡出现之后按下的（出卡确认那一下的放开不算）
   */
  anyInputSkips?: boolean;
  backdrop?: SceneBackdrop;
  testId?: string;
  attrs?: Readonly<Record<`data-${string}`, string | undefined>>;
  children?: ReactNode;
}

/** 按键落在可编辑的元素上（聊天框等）：玩家在打字，不算跳过 */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/**
 * 原版的「任意放开即跳过」：window 上捕获阶段监听（只听不拦），active 为 false 时不装。
 * 只算亮卡出现之后按下的键 / 指针：联机版的亮卡在出卡确认之后才出现（DEV-22），按住确认键或手指稍久时，那一下的
 * 放开会落在亮卡里——原版亮卡在选目标之前，不会有这种情况，所以不能让它把亮卡直接跳掉
 */
function useAnyInputSkip(active: boolean, onSkip: () => void): void {
  const ref = useRef(onSkip);
  ref.current = onSkip;
  useEffect(() => {
    if (!active) return;
    const pointers = new Set<number>();
    const keys = new Set<string>();
    const down = (e: PointerEvent): void => {
      // 左键（含触屏、笔）与右键；中键、侧键不算（原版只看 WM_LBUTTONUP / WM_RBUTTONUP）
      if (e.button === 0 || e.button === 2) pointers.add(e.pointerId);
    };
    const up = (e: PointerEvent): void => {
      if (pointers.delete(e.pointerId) && (e.button === 0 || e.button === 2)) ref.current();
    };
    const keyDown = (e: KeyboardEvent): void => {
      if (!typing(e.target)) keys.add(e.code || e.key);
    };
    const keyUp = (e: KeyboardEvent): void => {
      if (keys.delete(e.code || e.key) && !typing(e.target)) ref.current();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
    };
  }, [active]);
}

export function PopupScene({
  kind,
  label,
  minMs,
  onSkip,
  anyInputSkips = false,
  backdrop = 'none',
  testId = 'popup',
  attrs,
  children,
}: PopupSceneProps): ReactNode {
  const t = useTx();
  const [skippable, setSkippable] = useState(anyInputSkips);
  useEffect(() => {
    if (anyInputSkips) {
      setSkippable(true);
      return;
    }
    setSkippable(false);
    const id = setTimeout(() => setSkippable(true), Math.max(0, minMs));
    return () => clearTimeout(id);
  }, [minMs, anyInputSkips]);
  useAnyInputSkip(anyInputSkips, onSkip);
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
      {skippable && !anyInputSkips && (
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
