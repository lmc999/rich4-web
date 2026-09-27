// 经典舞台（original-skin.md §4.1）：640×480 逻辑坐标的舞台按 scale = min(W/640, H/480) 等比缩放（整数倍最近邻，
// 否则平滑）、letterbox 居中；棋盘视窗 (0,40) 440×440 用真实像素摆放（画布按设备分辨率渲染，不随 transform 模糊），
// 决策层叠在它上方；舞台左右剩余宽度放联机侧栏，宽度不足时收成抽屉按钮（抽屉内容常驻 DOM，只是隐藏）。
// - 抽屉模式下，侧栏里的倒计时与等待条（status）改叠在棋盘视窗左上角，抽屉关着也看得到；
// - 舞台随 transform 缩小（scale < 1）或粗指针设备：data-hit="wide"，舞台钮按 44 CSS 像素补透明热区（design-draft §4.5）；
// - 舞台里的钮被鼠标 / 触摸点过后不留焦点（键盘触发的保留），空格始终是「前进」；
// - 安全区（刘海、home 指示条）由 .frame 的 inset 让出，舞台与抽屉都在安全区内计算。
import clsx from 'clsx';
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTx } from '../../i18n/tx';
import c from './classic.module.css';
import { type ClassicLayoutBox, computeClassicLayout, REGION, type Rect, stageToScreen } from './layout';

const BoxContext = createContext<ClassicLayoutBox | null>(null);

/** 抽屉内容区的估计宽度（CSS 为 min(320px, 86vw)） */
export const DRAWER_W = 300;

/** 当前舞台布局（ClassicStage 之内） */
export function useClassicBox(): ClassicLayoutBox | null {
  return useContext(BoxContext);
}

export type RailSide = 'left' | 'right';

export interface RailRenderInfo {
  /** 侧栏内容当前是否可见（整栏显示，或抽屉已打开） */
  visible: boolean;
  mode: ClassicLayoutBox['rails'];
  /** 内容区宽度（CSS 像素；抽屉按 300 估算） */
  width: number;
}

export interface ClassicStageProps {
  /** 舞台内容（640×480 逻辑坐标，绝对定位） */
  children: ReactNode;
  /** 棋盘视窗（真实像素） */
  board?: ReactNode;
  /** 叠在棋盘画布之上的舞台层（同样是 640×480 逻辑坐标：GO 钮、骰子） */
  front?: ReactNode;
  /** 叠在棋盘视窗上方（决策层、横幅） */
  overlay?: ReactNode;
  /** 抽屉模式下叠在棋盘视窗左上角的状态（倒计时、等待条；整栏模式由侧栏自己显示） */
  status?: ReactNode;
  left?: (info: RailRenderInfo) => ReactNode;
  right?: (info: RailRenderInfo) => ReactNode;
  leftLabel: string;
  rightLabel: string;
  /** 抽屉按钮上的角标（例如未读聊天） */
  rightBadge?: number;
  /** 测试：固定容器尺寸（否则量容器） */
  size?: { w: number; h: number };
  className?: string;
}

function measure(el: HTMLElement | null): { w: number; h: number } {
  if (!el) return { w: 0, h: 0 };
  const w = el.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
  const h = el.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0);
  return { w, h };
}

function rectStyle(r: Rect): CSSProperties {
  return { left: r.x, top: r.y, width: r.w, height: r.h };
}

/** 粗指针（触摸屏）设备 */
function coarsePointer(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false;
  } catch {
    return false;
  }
}

/**
 * 舞台钮被鼠标 / 触摸点过（detail > 0）后交还焦点：空格留给「前进」；键盘触发（detail 0）的保留焦点。
 * 原生监听（冒泡到舞台层时，先于 React 的根监听）：钮随后打开的对话框记下的「之前的焦点」是 body，关上后也不回到钮上
 */
function releasePointerFocus(e: MouseEvent): void {
  if (e.detail === 0) return;
  const layer = e.currentTarget;
  const el = e.target instanceof Element ? e.target.closest('button') : null;
  if (el instanceof HTMLElement && layer instanceof Element && layer.contains(el) && document.activeElement === el) {
    el.blur();
  }
}

export function ClassicStage({
  children,
  board,
  front,
  overlay,
  status,
  left,
  right,
  leftLabel,
  rightLabel,
  rightBadge = 0,
  size,
  className,
}: ClassicStageProps): ReactNode {
  const t = useTx();
  const ref = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [drawer, setDrawer] = useState<RailSide | null>(null);

  useLayoutEffect(() => {
    if (size) return;
    const el = ref.current;
    const update = (): void => {
      const m = measure(el);
      setMeasured((cur) => (cur.w === m.w && cur.h === m.h ? cur : m));
    };
    update();
    window.addEventListener('resize', update);
    let ro: ResizeObserver | null = null;
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      ro.observe(el);
    }
    return () => {
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [size]);

  const dims = size ?? measured;
  const box = computeClassicLayout(dims.w, dims.h);
  const full = box.rails === 'full';
  const wideHit = box.scale < 1 || coarsePointer();

  // 换成整栏模式时收起抽屉；Esc 关闭抽屉
  useEffect(() => {
    if (full) setDrawer(null);
  }, [full]);
  useEffect(() => {
    if (drawer === null) return;
    const root = ref.current;
    // 打开时焦点移到抽屉的关闭钮；关上后还给抽屉按钮（读屏与键盘操作）
    root?.querySelector<HTMLElement>(`[data-testid="classic-drawer-${drawer}-close"]`)?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDrawer(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const inside = root?.querySelector(`#classic-drawer-${drawer}`)?.contains(document.activeElement) ?? false;
      if (inside || document.activeElement === document.body) {
        root?.querySelector<HTMLElement>(`[data-testid="classic-drawer-${drawer}-btn"]`)?.focus();
      }
    };
  }, [drawer]);

  const toggle = useCallback((side: RailSide) => setDrawer((d) => (d === side ? null : side)), []);

  // 棋盘视窗太小时（手机横屏）决策层改叠在整个舞台下半部（工具列以下）
  const overlayRect = stageToScreen(box, box.board.w >= 420 ? REGION.board : { x: 0, y: 40, w: 640, h: 440 });
  const ready = dims.w > 0 && dims.h > 0;

  // 舞台层与前层：鼠标 / 触摸点过的钮交还焦点
  useEffect(() => {
    if (!ready) return;
    const layers = [stageRef.current, frontRef.current].filter((x): x is HTMLDivElement => x !== null);
    for (const l of layers) l.addEventListener('click', releasePointerFocus);
    return () => {
      for (const l of layers) l.removeEventListener('click', releasePointerFocus);
    };
  }, [ready]);

  const renderRail = (side: RailSide): ReactNode => {
    const fn = side === 'left' ? left : right;
    if (!fn) return null;
    const rect = side === 'left' ? box.left : box.right;
    if (full) {
      return (
        <aside
          className={c.rail}
          style={rectStyle(rect)}
          aria-label={side === 'left' ? leftLabel : rightLabel}
          data-testid={`classic-rail-${side}`}
          data-mode="full"
        >
          {fn({ visible: true, mode: 'full', width: rect.w })}
        </aside>
      );
    }
    const open = drawer === side;
    const label = side === 'left' ? leftLabel : rightLabel;
    return (
      <>
        <div className={c.drawerBtns} style={rectStyle(rect)}>
          <button
            type="button"
            className={c.drawerBtn}
            aria-expanded={open}
            aria-controls={`classic-drawer-${side}`}
            onClick={() => toggle(side)}
            data-testid={`classic-drawer-${side}-btn`}
          >
            {label}
            {side === 'right' && rightBadge > 0 && !open && <span className={c.badge}>{rightBadge}</span>}
          </button>
        </div>
        <aside
          id={`classic-drawer-${side}`}
          className={c.drawer}
          data-side={side}
          hidden={!open}
          aria-label={label}
          data-testid={`classic-rail-${side}`}
          data-mode="drawer"
          data-open={open ? 'true' : 'false'}
        >
          <div className={c.drawerHead}>
            <span>{label}</span>
            <button
              type="button"
              className={c.drawerClose}
              onClick={() => setDrawer(null)}
              aria-label={t('classic:rail.close')}
              data-testid={`classic-drawer-${side}-close`}
            >
              ×
            </button>
          </div>
          {fn({ visible: open, mode: 'drawer', width: DRAWER_W })}
        </aside>
      </>
    );
  };

  return (
    <BoxContext.Provider value={box}>
      <div
        ref={ref}
        className={clsx(c.frame, className)}
        data-testid="classic-stage"
        data-scale={box.scale.toFixed(4)}
        data-rails={box.rails}
        data-pixelated={box.pixelated ? 'true' : 'false'}
        data-stage={`${box.stage.x},${box.stage.y},${box.stage.w},${box.stage.h}`}
        data-hit={wideHit ? 'wide' : 'normal'}
        style={{ '--classic-scale': String(box.scale) } as CSSProperties}
      >
        {ready && (
          <>
            <div
              className={c.stage}
              style={{ transform: `translate(${box.stage.x}px, ${box.stage.y}px) scale(${box.scale})` }}
              data-pixelated={box.pixelated ? 'true' : 'false'}
              data-testid="classic-stage-inner"
              ref={stageRef}
            >
              {children}
            </div>
            <div className={c.boardSlot} style={rectStyle(box.board)} data-testid="classic-board-slot">
              {board}
            </div>
            <div
              className={clsx(c.stage, c.front)}
              style={{ transform: `translate(${box.stage.x}px, ${box.stage.y}px) scale(${box.scale})` }}
              data-pixelated={box.pixelated ? 'true' : 'false'}
              data-testid="classic-stage-front"
              ref={frontRef}
            >
              {front}
            </div>
            {!full && status && (
              <div
                className={c.stageStatus}
                style={{ left: box.board.x, top: box.board.y, maxWidth: Math.max(160, Math.round(box.board.w * 0.6)) }}
                data-testid="classic-stage-status"
              >
                {status}
              </div>
            )}
            <div className={c.boardOverlay} style={rectStyle(overlayRect)} data-testid="classic-board-overlay">
              {overlay}
            </div>
            {renderRail('left')}
            {renderRail('right')}
          </>
        )}
      </div>
    </BoxContext.Provider>
  );
}
