// 原版精灵（CSS 背景图）：落点 = 画点 − 锚点；scale 用于舞台之外（侧栏）按比例缩放，舞台内缩放交给舞台的 transform。
// 帧不可用时渲染 fallback（CSS 回退画法）。
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { type SpriteFrame, useClassicAssets } from './assets';
import c from './classic.module.css';

/** 取精灵帧（加载中或不可用为 null） */
export function useSpriteFrame(sheet: string, frame: number): SpriteFrame | null {
  return useClassicAssets((s) => s.sprites[sheet]?.frames[frame] ?? null);
}

/** 精灵表的状态：'loading' | 'ready' | 'missing' */
export function useSheetStatus(sheet: string): 'loading' | 'ready' | 'missing' {
  return useClassicAssets((s) => {
    if (!Object.hasOwn(s.sprites, sheet)) return s.packId === null ? 'missing' : 'loading';
    return s.sprites[sheet] ? 'ready' : 'missing';
  });
}

export function spriteStyle(
  f: SpriteFrame,
  x: number | null,
  y: number | null,
  scale = 1,
  origin: SpriteOrigin = 'anchor',
): CSSProperties {
  const st: CSSProperties = {
    width: f.w * scale,
    height: f.h * scale,
    backgroundImage: `url("${f.url}")`,
    backgroundPosition: `${-f.x * scale}px ${-f.y * scale}px`,
    backgroundSize: `${f.sheetW * scale}px ${f.sheetH * scale}px`,
  };
  if (x !== null && y !== null) {
    st.left = origin === 'anchor' ? x - f.ax * scale : x;
    st.top = origin === 'anchor' ? y - f.ay * scale : y;
  }
  return st;
}

/** anchor：画点 − 锚点（原版语义）；topLeft：画点即左上角（整张底图、按框排版时） */
export type SpriteOrigin = 'anchor' | 'topLeft';

export interface SpriteProps {
  sheet: string;
  frame: number;
  /** 画点（舞台逻辑坐标或父元素像素）；省略时按普通行内块排版 */
  x?: number;
  y?: number;
  scale?: number;
  origin?: SpriteOrigin;
  className?: string;
  fallback?: ReactNode;
  testId?: string;
}

export function Sprite({
  sheet,
  frame,
  x,
  y,
  scale = 1,
  origin = 'anchor',
  className,
  fallback = null,
  testId,
}: SpriteProps): ReactNode {
  const f = useSpriteFrame(sheet, frame);
  const status = useSheetStatus(sheet);
  // 素材还在加载：先什么都不画（避免回退画法闪一下）；确定不可用才画回退
  if (!f) return status === 'loading' ? null : fallback;
  const placed = x !== undefined && y !== undefined;
  return (
    <span
      aria-hidden="true"
      className={clsx(c.sprite, placed && c.placed, className)}
      style={spriteStyle(f, placed ? x : null, placed ? y : null, scale, origin)}
      data-sprite={`${sheet}/${frame}`}
      data-testid={testId}
    />
  );
}
