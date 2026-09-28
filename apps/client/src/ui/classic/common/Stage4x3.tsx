// 原版场景模态层（design-draft §4.3 Stage4x3；original-skin.md §4.2）：在经典舞台（ClassicStage）之内弹出的 640×480 场景。
// - 与舞台同一缩放、同一落点：经 portal 挂到舞台容器（.frame）上，left/top = 舞台矩形、transform: scale(舞台倍率)，
//   整数倍时 image-rendering: pixelated；子层按原坐标、原锚点绝对定位（见 SceneLayer、Sprite）；
// - 进出场动画（motion；在 AnimatePresence 之内被移除时播放退场，期间 data-testid 换成 <id>-exit 且不可操作）；
// - 模态时：焦点移入场景（缺省落在场景根上，不抢到「是」钮上，避免连按空格误触；焦点在场景外的输入框上时不抢）、
//   Tab 在场景内循环、卸载时还给之前的元素；
//   Esc 与关闭钮调用 onClose；data-state="open" 让经典热键（空格、D、M…）暂停；
// - 倒计时圆环叠在右上角；状态条（等待 X… / 已提交 / 时间到）在顶部居中；
// - 只读（托管中、非本人）：不抢焦点、不挡棋盘（pointer-events: none），控件全部禁用；
// - 背板为 opaque / dim 的模态场景登记中央决策倒计时小牌的位置（sceneCover；countdownBadgeAt，缺省舞台顶端中线），
//   倒计时据此避让；
// - 手机横屏（舞台缩小）或粗指针：data-hit="wide"，--hit 为 44px 折成的场景逻辑像素（Hotspots、ClassicButton 据此补透明热区）。
// 不在经典舞台之内时（单测、预览）就地渲染在父元素左上角，按 scale 缩放。
import clsx from 'clsx';
import { motion, useIsPresent, useReducedMotion } from 'motion/react';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { CountdownRing } from '../../components/Countdown';
import { useClassicBox } from '../ClassicStage';
import s from './common.module.css';
import { shouldTakeFocus } from './focus';
import { STAGE_BADGE_TOP, type StageBadgeAt, useFullStageCover } from './sceneCover';
import { coarsePointer, hitMinLogical, SCENE_H, SCENE_W, SCENE_Z, scenePlacement, wantsWideHit } from './stage';

export type SceneBackdrop = 'none' | 'dim' | 'opaque';
export type SceneStatusTone = 'wait' | 'sent' | 'expired' | 'info';

export interface Stage4x3Props {
  /** 根元素的 data-testid（决策场景用 decision-<KIND>，与程序化对话框同名，E2E 共用） */
  testId: string;
  /** 对话框名称（aria-label） */
  label: string;
  children?: ReactNode;
  /** 只读：不抢焦点、不挡棋盘、控件禁用 */
  readOnly?: boolean;
  /** 控件可操作（缺省 = !readOnly）；false 时场景内的表单控件整体禁用（<fieldset disabled>） */
  interactive?: boolean;
  /** 状态条（等待 X… / 已提交 / 时间到）；空则不显示 */
  status?: ReactNode;
  statusTone?: SceneStatusTone;
  /** 倒计时（给出时在右上角画圆环；remainingMs 为 null 表示不限时） */
  countdown?: { remainingMs: number | null; totalMs: number | null } | null;
  /** 圆环左上角的场景坐标（缺省场景右上角；只占棋盘视窗的小场景可以放到棋盘视窗右上角） */
  countdownAt?: { x: number; y: number };
  /**
   * 画面中央的决策倒计时在本场景开着时摆到哪（场景坐标，小牌上缘中点；common/sceneCover）。缺省：背板 opaque / dim
   * （盖住整个舞台）的在舞台顶端中线 STAGE_BADGE_TOP，none（棋盘仍可见）不登记、倒计时按决策框位置摆；
   * 顶端正中有内容的场景给一个空处；null 为明确不登记
   */
  countdownBadgeAt?: StageBadgeAt | null;
  /** Esc 与关闭钮 */
  onClose?: () => void;
  /** 显示右上角的关闭钮（缺省：给了 onClose 就显示；场景自己有 EXIT / NO 钮时可关掉） */
  closeButton?: boolean;
  closeLabel?: string;
  closeTestId?: string;
  /** 背板：none 透明（棋盘可见）、dim 半透明、opaque 全黑 */
  backdrop?: SceneBackdrop;
  /** 初始焦点（缺省为场景根） */
  initialFocus?: RefObject<HTMLElement | null>;
  /** 附加在根元素上的属性（data-kind、data-locked…） */
  attrs?: Readonly<Record<`data-${string}`, string | undefined>>;
  className?: string;
  /** 不在经典舞台之内时的缩放（缺省 1） */
  scale?: number;
  /** 场景根上的按键（在焦点位于场景内时触发） */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true' && !el.closest('[inert]'),
  );
}

/** 事件目标是否在场景里（或焦点落在 body / 场景根上） */
function ownsEvent(root: HTMLElement | null, target: EventTarget | null): boolean {
  if (!root) return false;
  if (target === null || target === document.body || target === document.documentElement) return true;
  return target instanceof Node && root.contains(target);
}

export function Stage4x3({
  testId,
  label,
  children,
  readOnly = false,
  interactive,
  status,
  statusTone = 'info',
  countdown,
  countdownAt,
  countdownBadgeAt,
  onClose,
  closeButton,
  closeLabel,
  closeTestId,
  backdrop = 'none',
  initialFocus,
  attrs,
  className,
  scale: standaloneScale = 1,
  onKeyDown,
}: Stage4x3Props): ReactNode {
  const box = useClassicBox();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // undefined：还没找过舞台容器（首帧先渲染锚点，布局阶段找到后同步重渲染，不闪）
  const [host, setHost] = useState<HTMLElement | null | undefined>(undefined);
  const isPresent = useIsPresent();
  const reduce = useReducedMotion();
  const modal = !readOnly && isPresent;
  const canAct = (interactive ?? !readOnly) && isPresent;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // 模态场景登记倒计时小牌的位置：画面中央的决策倒计时据此避让（sceneCover.ts）
  const badgeAt = countdownBadgeAt === undefined ? (backdrop === 'none' ? null : STAGE_BADGE_TOP) : countdownBadgeAt;
  useFullStageCover(modal ? badgeAt : null);

  useLayoutEffect(() => {
    setHost(anchorRef.current?.closest<HTMLElement>('[data-testid="classic-stage"]') ?? null);
  }, []);

  const place = scenePlacement(host && box ? box : null, standaloneScale);
  const wide = wantsWideHit(place.scale, coarsePointer());
  const mounted = host !== undefined;

  // 焦点：模态时移入场景，卸载时还给之前的元素（焦点还在场景里或落在 body 上时）。
  // 焦点在场景外的输入框（聊天框等）上时不抢：玩家正在打字，接着敲的 y / n / Esc 不能变成场景里的决定。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在变成模态 / 挂上容器时移一次焦点
  useEffect(() => {
    if (!modal || !mounted) return;
    const root = rootRef.current;
    if (!root) return;
    if (!shouldTakeFocus(root, document.activeElement)) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocus?.current ?? root).focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const inside = active === null || active === document.body || root.contains(active);
      if (inside && prev && prev !== document.body && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, [modal, mounted]);

  // Esc：焦点在场景里（或在 body 上）时关闭
  useEffect(() => {
    if (!modal || !onClose) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (!ownsEvent(rootRef.current, e.target)) return;
      e.preventDefault();
      onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, onClose]);

  const onRootKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(e);
    if (e.defaultPrevented || !modal || e.key !== 'Tab') return;
    const root = rootRef.current;
    if (!root) return;
    const list = focusables(root);
    if (list.length === 0) {
      e.preventDefault();
      return;
    }
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const showClose = !!onClose && (closeButton ?? true);
  const style = {
    left: place.left,
    top: place.top,
    width: SCENE_W,
    height: SCENE_H,
    transform: `scale(${place.scale})`,
    zIndex: SCENE_Z,
    '--hit': `${hitMinLogical(place.scale)}px`,
  } as CSSProperties;

  const scene = (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal={modal ? true : undefined}
      aria-label={label}
      tabIndex={-1}
      className={clsx(s.scene, className)}
      style={style}
      data-testid={isPresent ? testId : `${testId}-exit`}
      data-scene="classic"
      data-state={modal ? 'open' : 'closed'}
      data-readonly={readOnly ? 'true' : 'false'}
      data-pixelated={place.pixelated ? 'true' : 'false'}
      data-hit={wide ? 'wide' : 'normal'}
      data-scale={place.scale.toFixed(4)}
      inert={isPresent ? undefined : true}
      onKeyDown={onRootKey}
      {...attrs}
    >
      <motion.div
        className={s.sceneAnim}
        initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 6 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}
      >
        <div className={s.backdrop} data-backdrop={backdrop} aria-hidden="true" />
        <fieldset className={s.layers} disabled={!canAct}>
          {children}
        </fieldset>
        {status ? (
          <p className={s.status} data-tone={statusTone} role="status" data-testid={`${testId}-status`}>
            {status}
          </p>
        ) : null}
        {countdown ? (
          <span
            className={s.ring}
            style={countdownAt ? { left: countdownAt.x, top: countdownAt.y, right: 'auto' } : undefined}
            data-testid={`${testId}-ring`}
          >
            <CountdownRing remainingMs={countdown.remainingMs} totalMs={countdown.totalMs} size={32} />
          </span>
        ) : null}
        {showClose && (
          <button
            type="button"
            className={s.close}
            onClick={() => onCloseRef.current?.()}
            aria-label={closeLabel}
            title={closeLabel}
            disabled={!canAct}
            data-testid={closeTestId ?? `${testId}-close`}
          >
            ×
          </button>
        )}
      </motion.div>
    </div>
  );

  return (
    <>
      <span ref={anchorRef} hidden data-scene-anchor={testId} />
      {!mounted ? null : host ? createPortal(scene, host) : scene}
    </>
  );
}

export interface SceneLayerProps {
  /** 场景逻辑坐标 */
  x: number;
  y: number;
  w?: number;
  h?: number;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
  /** 叠放次序（同一场景内） */
  z?: number;
}

/** 场景里绝对定位的一层（DOM 文字、按钮、精灵的容器） */
export function SceneLayer({ x, y, w, h, children, className, style, testId, z }: SceneLayerProps): ReactNode {
  return (
    <div
      className={clsx(s.layer, className)}
      style={{ left: x, top: y, width: w, height: h, zIndex: z, ...style }}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
