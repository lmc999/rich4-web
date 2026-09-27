// 原版热区（design-draft §4.3）：每个热区是一个透明 <button>（DOM 可访问：Tab 可达、Enter/空格触发、aria-label、data-testid），
// 摆在它的矩形上；有命中掩膜（8 位灰度 PNG，区号 = 像素值）时按像素判定——包围盒相互重叠的不规则区域以掩膜为准，
// 点到区与区之间的空白不触发。手机横屏 / 粗指针（祖先 data-hit="wide"）时按钮补透明扩展热区（≥44px）：
// hit = 'grow' 以自身为中心补足；hit = 矩形 扩展到给定范围（密集键盘用它，扩展区互不重叠）；hit = 'none' 不扩展。
// 扩展区里的点击不再查掩膜，直接算这个热区。
import clsx from 'clsx';
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from 'react';
import type { MaskAsset } from '../assets';
import type { Rect } from '../layout';
import s from './common.module.css';
import { type HotspotShape, localPoint, resolveActivation, spotAt } from './hitTest';
import { useSceneMask } from './mask';

export type HitPad = 'grow' | 'none' | 'left' | 'right' | 'up' | 'down' | Rect;

export interface HotspotSpec extends HotspotShape {
  /** 读屏名称 */
  label: string;
  /** 触发（也可以用 Hotspots 的 onActivate 统一处理） */
  onActivate?: () => void;
  testId?: string;
  /**
   * 手机扩展热区：grow（缺省，以自身为中心补到 ≥44px）| none | left / right / up / down（只往这一侧补，
   * 相邻两钮各往外侧补、互不遮挡）| 矩形（容器坐标，扩展到给定范围）
   */
  hit?: HitPad;
  /** 按钮里的可见内容（通常为空：画面由精灵层负责） */
  children?: ReactNode;
  /** 切换类按钮的按下态 */
  pressed?: boolean;
  /** 附加属性 */
  title?: string;
}

export interface HotspotsProps {
  /** 容器在场景里的位置与尺寸（= 掩膜尺寸） */
  x: number;
  y: number;
  w: number;
  h: number;
  spots: readonly HotspotSpec[];
  /** 命中掩膜的逻辑键（素材包里的 mask 条目） */
  maskKey?: string;
  /** 直接给掩膜（优先于 maskKey；测试、合成） */
  mask?: MaskAsset | null;
  onActivate?: (id: string) => void;
  /** 指针悬停的热区变化（精灵换悬停帧用） */
  onHotChange?: (id: string | null) => void;
  /** 按下的热区变化（精灵换按下帧用） */
  onPressChange?: (id: string | null) => void;
  /** 整组禁用 */
  disabled?: boolean;
  /** 组名（role=group 的 aria-label） */
  label?: string;
  testId?: string;
  className?: string;
}

function padVars(own: Rect, pad: Rect): CSSProperties {
  return {
    '--pad-l': `${pad.x - own.x}px`,
    '--pad-t': `${pad.y - own.y}px`,
    '--pad-w': `${pad.w}px`,
    '--pad-h': `${pad.h}px`,
  } as CSSProperties;
}

export function Hotspots({
  x,
  y,
  w,
  h,
  spots,
  maskKey,
  mask: maskProp,
  onActivate,
  onHotChange,
  onPressChange,
  disabled = false,
  label,
  testId,
  className,
}: HotspotsProps): ReactNode {
  const loaded = useSceneMask(maskProp === undefined ? maskKey : null);
  const mask = maskProp === undefined ? loaded : maskProp;
  const ref = useRef<HTMLFieldSetElement>(null);
  const [hot, setHot] = useState<string | null>(null);
  const pressedRef = useRef<string | null>(null);

  const live = spots.map((sp) => (disabled && !sp.disabled ? { ...sp, disabled: true } : sp));

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const el = ref.current;
    if (!el) return null;
    return localPoint(el.getBoundingClientRect(), e.clientX, e.clientY, w, h);
  };

  /** 指针下的热区：在某个热区按钮上（含手机扩展区）时与点击同一套判定；落在按钮之间的空白时按坐标找 */
  const spotOfEvent = (e: ReactPointerEvent<HTMLElement>): HotspotSpec | null => {
    const p = local(e);
    const btn = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-spot]') : null;
    const own = btn ? live.find((sp) => sp.id === btn.dataset.spot) : undefined;
    if (own) return resolveActivation(live, mask, own, p);
    const hit = p ? spotAt(live, mask, p.x, p.y) : null;
    return hit && !hit.disabled ? hit : null;
  };

  const hotRef = useRef<string | null>(null);
  const setHotId = (id: string | null): void => {
    if (hotRef.current === id) return;
    hotRef.current = id;
    setHot(id);
    onHotChange?.(id);
  };

  const setPressed = (id: string | null): void => {
    if (pressedRef.current === id) return;
    pressedRef.current = id;
    onPressChange?.(id);
  };

  const onMove = (e: ReactPointerEvent<HTMLFieldSetElement>): void => {
    setHotId(spotOfEvent(e)?.id ?? null);
  };

  const onDown = (e: ReactPointerEvent<HTMLFieldSetElement>): void => {
    setPressed(spotOfEvent(e)?.id ?? null);
  };

  const clear = (): void => {
    setHotId(null);
    setPressed(null);
  };

  const fire = (sp: HotspotSpec): void => {
    sp.onActivate?.();
    onActivate?.(sp.id);
  };

  const onClick = (own: HotspotSpec, e: ReactMouseEvent<HTMLButtonElement>): void => {
    // detail 0：键盘（Enter / 空格）触发的 click，没有指针坐标
    const p = e.detail === 0 ? null : local(e);
    const target = resolveActivation(live, mask, own, p);
    setPressed(null);
    if (target) fire(target);
  };

  return (
    // 容器只跟踪悬停 / 按下（换精灵帧）；可操作的是里面的 <button>
    <fieldset
      ref={ref}
      aria-label={label}
      className={clsx(s.hotspots, className)}
      style={{ left: x, top: y, width: w, height: h }}
      data-testid={testId}
      data-mask={mask ? 'true' : 'false'}
      data-hot={hot ?? ''}
      onPointerMove={onMove}
      onPointerDown={onDown}
      onPointerUp={() => setPressed(null)}
      onPointerCancel={clear}
      onPointerLeave={clear}
    >
      {live.map((sp) => {
        const mode = sp.hit === undefined ? 'grow' : typeof sp.hit === 'string' ? sp.hit : 'rect';
        const style: CSSProperties = {
          left: sp.rect.x,
          top: sp.rect.y,
          width: sp.rect.w,
          height: sp.rect.h,
          ...(typeof sp.hit === 'object' ? padVars(sp.rect, sp.hit) : null),
        };
        return (
          <button
            key={sp.id}
            type="button"
            className={s.hot}
            style={style}
            aria-label={sp.label}
            title={sp.title}
            aria-pressed={sp.pressed}
            disabled={sp.disabled}
            data-spot={sp.id}
            data-region={sp.region}
            data-hitpad={mode}
            data-hot={hot === sp.id ? 'true' : undefined}
            data-testid={sp.testId}
            onClick={(e) => onClick(sp, e)}
            onFocus={() => setHotId(sp.id)}
            onBlur={() => setHotId(null)}
          >
            {sp.children}
          </button>
        );
      })}
    </fieldset>
  );
}
