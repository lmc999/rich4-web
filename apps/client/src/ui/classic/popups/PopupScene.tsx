// 原版演出弹窗的外壳：Stage4x3 的只读场景（不抢焦点、不挡棋盘与工具列；与舞台同一落点与倍率，经 portal 挂到经典舞台），
// 根元素 data-testid="popup"、data-kind 与程序化弹窗层一致（E2E 两种皮肤共用）；最短展示时间之后出现「点一下跳过」
// （网页版的钮）。亮卡照原版：不画跳过钮，从一开始任意鼠标键放开或按键放开就结束（anyInputSkips）。
// 整块盖住工具列与棋盘视窗的板子（新闻板、命运板）在板面上接住指针、暂停经典快捷键（shield），不让输入穿到看不见的
// 工具列钮上。
// 另有 useTicker（演出用的真实时间节拍，减少动态时不走）。
import { useReducedMotion } from 'motion/react';
import { type ReactNode, type SyntheticEvent, useEffect, useRef, useState } from 'react';
import { useTx } from '../../../i18n/tx';
import { type SceneBackdrop, Stage4x3 } from '../common/Stage4x3';
import { TEXT } from '../common/textStyles';
import { useSwallowHotkeys } from '../keyboard';
import pp from './popups.module.css';

/** 场景逻辑坐标的矩形 */
export interface SceneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PopupSceneProps {
  kind: string;
  label: string;
  /** 最短展示时间（真实毫秒）：之后出现跳过钮 */
  minMs: number;
  onSkip: () => void;
  /**
   * 原版的跳过方式（亮卡）：不画跳过钮、没有最短时间，页面上任意鼠标左 / 右键放开或按键放开（焦点在输入框里打字时除外）
   * 就结束——exe 亮卡的等待 fcn.00450f9a(1500) 在 PeekMessage 循环里遇到 WM_LBUTTONUP / WM_RBUTTONUP / WM_KEYUP 即返回。
   * 只是监听、不拦截：点到的工具列、棋盘照常响应（盖住工具列的板子另用 shield 接住板面上的输入）；只算亮卡出现之后
   * 按下的（出卡确认那一下的放开不算）
   */
  anyInputSkips?: boolean;
  /**
   * 板面（场景逻辑坐标）：整块盖住工具列与棋盘视窗的板子（新闻板、命运板 440×480 贴 (0,0)）在这个矩形里接住指针。
   * 场景是只读的（pointer-events: none），不接住的话点板子会同时点到板子下面看不见的工具列钮（「查询」开资产表、
   * 「说明」开说明框、「托管」直接切换托管）或棋盘；原版板子期间程序停在等待循环里（fcn.00452c39），点不到工具列。
   * 接住的指针不往下传（stopPropagation，右键不弹浏览器菜单）；经典快捷键暂停（keyboard.useSwallowHotkeys，场景根另标
   * data-input-shield 供 shouldHandleHotkey 认），按 M、< > 跳过板子时不会顺带切大地图、转视角。
   * 跳过：anyInputSkips 时放开即跳过（useAnyInputSkip）；否则可跳过之后（最短时间到了）点板子等于点跳过钮
   */
  shield?: SceneRect;
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
  shield,
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
  useSwallowHotkeys(shield !== undefined);
  return (
    <Stage4x3
      testId={testId}
      label={label}
      readOnly
      interactive
      backdrop={backdrop}
      attrs={{
        'data-kind': kind,
        'data-skippable': skippable ? 'true' : 'false',
        'data-classic': 'true',
        'data-input-shield': shield ? 'true' : undefined,
        ...attrs,
      }}
    >
      {children}
      {shield && (
        <InputShield
          rect={shield}
          testId={`${testId}-shield`}
          onTap={skippable && !anyInputSkips ? onSkip : undefined}
        />
      )}
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

/** 接住的指针 / 鼠标事件：不往下传（React 祖先与窗口上的冒泡监听都收不到） */
function swallow(e: SyntheticEvent): void {
  e.stopPropagation();
}

/**
 * 板面上接住指针的透明层（见 PopupSceneProps.shield）：只读场景里唯一 pointer-events: auto 的一块（另有跳过钮），
 * 落点在板面上的按下、放开、点击、右键都停在这里；onTap 给出时点击即跳过（没有 anyInputSkips 的板子）
 */
function InputShield({ rect, testId, onTap }: { rect: SceneRect; testId: string; onTap?: () => void }): ReactNode {
  return (
    <div
      className={pp.shield}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      data-testid={testId}
      aria-hidden="true"
      onPointerDown={swallow}
      onPointerUp={swallow}
      onMouseDown={(e) => {
        // 不把焦点挪走、不开始选字（原版点板子只是结束等待）
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseUp={swallow}
      onDoubleClick={swallow}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        onTap?.();
      }}
    />
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
