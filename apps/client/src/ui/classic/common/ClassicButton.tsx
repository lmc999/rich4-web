// 原版按钮（original-skin.md §4.2）：一颗 <button> 摆在精灵帧的矩形上，按状态换帧——常态 / 悬停（含键盘焦点）/ 按下 / 禁用；
// 没给的状态帧退回常态帧。精灵不可用时画木框金边的回退钮（label 文字）。手机横屏 / 粗指针时补 ≥44px 透明热区。
import clsx from 'clsx';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { type SpriteOrigin, spriteStyle, useSheetStatus, useSpriteFrame } from '../Sprite';
import s from './common.module.css';
import { useEnsureSceneSprites } from './sceneAssets';

export interface ButtonFrames {
  normal: number;
  hover?: number;
  pressed?: number;
  disabled?: number;
}

export type ButtonState = 'normal' | 'hover' | 'pressed' | 'disabled';

/** 状态 → 帧号（缺的状态退回：按下 → 悬停 → 常态；禁用 → 常态） */
export function buttonFrame(frames: ButtonFrames, state: ButtonState): number {
  switch (state) {
    case 'disabled':
      return frames.disabled ?? frames.normal;
    case 'pressed':
      return frames.pressed ?? frames.hover ?? frames.normal;
    case 'hover':
      return frames.hover ?? frames.normal;
    default:
      return frames.normal;
  }
}

/** 键盘焦点（:focus-visible）；环境不支持该伪类时按键盘焦点处理 */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

export interface ClassicButtonProps {
  sheet: string;
  frames: ButtonFrames;
  /** 画点（场景坐标）；origin 为 anchor 时减去常态帧的锚点 */
  x: number;
  y: number;
  origin?: SpriteOrigin;
  /** 读屏名称（精灵不可用时也是回退钮上的文字） */
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 命中矩形尺寸（缺省取常态帧尺寸；精灵不可用时必须给出才画得出回退钮） */
  w?: number;
  h?: number;
  /** 叠在钮上的可见文字（原版多数钮的字已画在图里，不需要） */
  children?: ReactNode;
  /** 手机扩展热区（缺省 grow：以自身为中心补到 ≥44px；left/right/up/down 只往一侧补） */
  hitPad?: 'grow' | 'none' | 'left' | 'right' | 'up' | 'down';
  testId?: string;
  className?: string;
  title?: string;
}

export function ClassicButton({
  sheet,
  frames,
  x,
  y,
  origin = 'topLeft',
  label,
  onClick,
  disabled = false,
  w,
  h,
  children,
  hitPad = 'grow',
  testId,
  className,
  title,
}: ClassicButtonProps): ReactNode {
  useEnsureSceneSprites([sheet]);
  const [hover, setHover] = useState(false);
  const [down, setDown] = useState(false);
  const state: ButtonState = disabled ? 'disabled' : down ? 'pressed' : hover ? 'hover' : 'normal';
  const base = useSpriteFrame(sheet, frames.normal);
  const art = useSpriteFrame(sheet, buttonFrame(frames, state));
  const status = useSheetStatus(sheet);
  const fw = w ?? base?.w;
  const fh = h ?? base?.h;
  if (fw === undefined || fh === undefined) return null;
  if (!base && status === 'loading') return null;
  const left = origin === 'anchor' && base ? x - base.ax : x;
  const top = origin === 'anchor' && base ? y - base.ay : y;
  const shown = art ?? base;
  const artStyle: CSSProperties | null = shown
    ? {
        ...spriteStyle(shown, 0, 0, 1, 'topLeft'),
        // 状态帧与常态帧锚点不同时（原版部分钮的悬停帧更大）按锚点对齐
        left: base ? base.ax - shown.ax : 0,
        top: base ? base.ay - shown.ay : 0,
      }
    : null;
  return (
    <button
      type="button"
      className={clsx(s.btn, className)}
      style={{ left, top, width: fw, height: fh }}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      data-state={state}
      data-hitpad={hitPad}
      data-testid={testId}
      onClick={onClick}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => {
        setHover(false);
        setDown(false);
      }}
      onPointerDown={() => setDown(true)}
      onPointerUp={() => setDown(false)}
      onPointerCancel={() => setDown(false)}
      onFocus={(e) => {
        if (focusVisible(e.currentTarget)) setHover(true);
      }}
      onBlur={() => setHover(false)}
    >
      {artStyle ? (
        <span
          className={s.btnArt}
          style={artStyle}
          aria-hidden="true"
          data-sprite={`${sheet}/${buttonFrame(frames, state)}`}
        />
      ) : (
        <span className={s.btnFallback} aria-hidden="true">
          {children ?? label}
        </span>
      )}
      {artStyle && children ? <span className={s.btnText}>{children}</span> : null}
    </button>
  );
}
