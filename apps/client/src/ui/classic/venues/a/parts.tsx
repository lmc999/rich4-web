// 第一组场所屏的共用小件：文字按钮（原版底板或木框回退）、读屏 / E2E 用的数字框、定位文字、表情动画（眨眼、说话）、
// 场景里播放素材包 FLIC（循环或单次，动画时钟驱动，倍速与 instant 一致）。
import clsx from 'clsx';
import { useReducedMotion } from 'motion/react';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { useClient } from '../../../../app/services';
import type { FlicPlayer } from '../../../../skin/flic';
import { formatInt } from '../../../components/format';
import { useClassicAssets } from '../../assets';
import cs from '../../common/common.module.css';
import { useEnsureSceneSprites } from '../../common/sceneAssets';
import { TEXT } from '../../common/textStyles';
import type { Rect } from '../../layout';
import { spriteStyle, useSpriteFrame } from '../../Sprite';
import v from './venues.module.css';

// ───────────────────────── 文字按钮 ─────────────────────────

/** 选中 / 悬停时文字的亮黄 */
const LIT = '#ffe060';

/** 涨（红）跌（绿）的字色（与程序化股市面板同一约定） */
export const UP_COLOR = '#ff7a6a';
export const DOWN_COLOR = '#7ef08a';

/** 正负数的字色（0 为 undefined：沿用文字样式） */
export function signColor(n: number): string | undefined {
  return n > 0 ? UP_COLOR : n < 0 ? DOWN_COLOR : undefined;
}

export interface PlateButtonProps {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 读屏名称 */
  label: string;
  /** 可见文字（缺省同 label） */
  children?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** 切换钮的按下态（aria-pressed） */
  pressed?: boolean;
  /** 原版底板（缺省画木框金边回退） */
  plate?: { sheet: string; normal: number; hover?: number };
  testId?: string;
  title?: string;
  /** 手机扩展热区（缺省 grow） */
  hitPad?: 'grow' | 'none' | 'left' | 'right' | 'up' | 'down';
  /** role="tab" 时的选中态 */
  tab?: { selected: boolean };
  textStyle?: CSSProperties;
  /** 不画底板（钮的画面已烘焙在底图里，例如股市详情框的圆台） */
  bare?: boolean;
}

export function PlateButton({
  x,
  y,
  w,
  h,
  label,
  children,
  onClick,
  disabled = false,
  pressed,
  plate,
  testId,
  title,
  hitPad = 'grow',
  tab,
  textStyle,
  bare = false,
}: PlateButtonProps): ReactNode {
  useEnsureSceneSprites(plate ? [plate.sheet] : []);
  const [hover, setHover] = useState(false);
  const lit = !disabled && (hover || pressed === true || tab?.selected === true);
  const frameNo = plate ? (lit ? (plate.hover ?? plate.normal) : plate.normal) : -1;
  const f = useSpriteFrame(plate?.sheet ?? '', frameNo);
  return (
    <button
      type="button"
      {...(tab ? { role: 'tab', 'aria-selected': tab.selected } : { 'aria-pressed': pressed })}
      className={clsx(cs.btn, v.plateBtn)}
      style={{ left: x, top: y, width: w, height: h }}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      data-hitpad={hitPad}
      data-state={disabled ? 'disabled' : lit ? 'hover' : 'normal'}
      data-testid={testId}
      onClick={onClick}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      {bare ? null : f ? (
        // 底板按帧原尺寸画，按钮尺寸不同时拉伸（蓝条当宽钮用）
        <span
          className={cs.btnArt}
          style={{
            ...spriteStyle(f, 0, 0, 1, 'topLeft'),
            transformOrigin: '0 0',
            transform: w !== f.w || h !== f.h ? `scale(${w / f.w}, ${h / f.h})` : undefined,
          }}
          aria-hidden="true"
          data-sprite={`${plate?.sheet}/${frameNo}`}
        />
      ) : (
        <span className={cs.btnFallback} aria-hidden="true" />
      )}
      <span
        className={v.plateText}
        style={{ ...TEXT.body, ...textStyle, ...(lit || pressed || tab?.selected ? { color: LIT } : null) }}
        aria-hidden="true"
      >
        {children ?? label}
      </span>
    </button>
  );
}

// ───────────────────────── 数字框（读屏 / E2E 的备用控件） ─────────────────────────

export interface SrNumberProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  testId?: string;
}

/** 隐藏的原生数字框（role=spinbutton）：读屏与 E2E 直接填数；手机与桌面的可见输入走计算器 / 液晶屏 */
export function SrNumber({ label, value, min, max, onChange, disabled, testId }: SrNumberProps): ReactNode {
  return (
    <input
      type="number"
      className={cs.srOnly}
      aria-label={label}
      min={min}
      max={Math.max(min, max)}
      step={1}
      value={String(value)}
      disabled={disabled}
      data-testid={testId}
      onChange={(e) => {
        const raw = e.currentTarget.value.replace(/[^\d]/g, '');
        const n = raw === '' ? 0 : Number(raw);
        onChange(Math.min(Math.max(0, max), Math.max(0, Math.trunc(n))));
      }}
    />
  );
}

// ───────────────────────── 金额 ─────────────────────────

/** 千分位数字 + 单位；data-value 给 E2E 读原值 */
export function Amount({ value, unit, testId }: { value: number; unit?: string; testId?: string }): ReactNode {
  return (
    <span data-testid={testId} data-value={value}>
      {formatInt(value)}
      {unit ?? ''}
    </span>
  );
}

// ───────────────────────── 定位文字 ─────────────────────────

export function SceneText({
  rect,
  children,
  style,
  testId,
  className,
  attrs,
}: {
  rect: Rect;
  children?: ReactNode;
  style?: CSSProperties;
  testId?: string;
  className?: string;
  attrs?: Readonly<Record<`data-${string}`, string | number | undefined>>;
}): ReactNode {
  return (
    <div
      className={clsx(v.text, className)}
      style={{ ...TEXT.body, left: rect.x, top: rect.y, width: rect.w, height: rect.h, ...style }}
      data-testid={testId}
      {...attrs}
    >
      {children}
    </div>
  );
}

// ───────────────────────── 表情动画 ─────────────────────────

/** 眨眼：每 period 毫秒闭眼 closeMs（减少动态效果时不眨） */
export function useBlink(period = 3200, closeMs = 160): boolean {
  const reduce = useReducedMotion();
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (reduce) return;
    let t: ReturnType<typeof setTimeout>;
    const loop = (): void => {
      t = setTimeout(() => {
        setClosed(true);
        t = setTimeout(() => {
          setClosed(false);
          loop();
        }, closeMs);
      }, period);
    };
    loop();
    return () => clearTimeout(t);
  }, [reduce, period, closeMs]);
  return closed;
}

/** 说话：key 变化后 durationMs 内每 stepMs 换一帧嘴型（返回下标，-1 = 闭嘴） */
export function useTalk(key: string, frames: number, durationMs = 1400, stepMs = 140): number {
  const reduce = useReducedMotion();
  const [i, setI] = useState(-1);
  useEffect(() => {
    if (reduce || frames <= 0 || !key) {
      setI(-1);
      return;
    }
    const t0 = Date.now();
    let k = 0;
    setI(0);
    const id = setInterval(() => {
      if (Date.now() - t0 >= durationMs) {
        clearInterval(id);
        setI(-1);
        return;
      }
      k = (k + 1) % (frames + 1);
      setI(k === frames ? -1 : k);
    }, stepMs);
    return () => clearInterval(id);
  }, [key, frames, durationMs, stepMs, reduce]);
  return i;
}

// ───────────────────────── FLIC ─────────────────────────

export interface VenueFlicProps {
  flicKey: string;
  rect: Rect;
  /** loop：循环到卸载；once：播一遍停在末帧；off：不播（显示 fallback） */
  mode: 'loop' | 'once' | 'off';
  /** 播放器不可用（没有素材包、加载失败）时画的东西 */
  fallback?: ReactNode;
  testId?: string;
  className?: string;
}

/** 在场景里播放素材包里的 FLIC（加载器来自经典素材仓库；测试与无素材时为 null → fallback） */
export function VenueFlic({ flicKey, rect, mode, fallback = null, testId, className }: VenueFlicProps): ReactNode {
  const client = useClient();
  const loadFlic = useClassicAssets((s) => s.loadFlic);
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'on' | 'off'>(loadFlic && mode !== 'off' ? 'loading' : 'off');

  useEffect(() => {
    if (!loadFlic || mode === 'off') {
      setState('off');
      return;
    }
    const ac = new AbortController();
    let player: FlicPlayer | null = null;
    setState('loading');
    void (async () => {
      player = await loadFlic(flicKey, client.anim);
      const el = host.current;
      if (ac.signal.aborted) {
        player?.destroy();
        return;
      }
      const canvas = player?.canvas;
      if (!player || !el || !canvas || !(canvas instanceof HTMLCanvasElement)) {
        setState('off');
        return;
      }
      el.replaceChildren(canvas);
      setState('on');
      await player.play({ loop: mode === 'loop', signal: ac.signal });
    })().catch((e: unknown) => {
      console.warn(`[classic] 场所 FLIC ${flicKey} 播放失败`, e);
      setState('off');
    });
    return () => {
      ac.abort();
      player?.destroy();
      host.current?.replaceChildren();
    };
  }, [flicKey, mode, loadFlic, client]);

  return (
    <div
      className={clsx(v.flic, className)}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      data-testid={testId}
      data-flic={state}
      aria-hidden="true"
    >
      {state !== 'on' && fallback}
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
    </div>
  );
}
