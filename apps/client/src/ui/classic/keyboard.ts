// 经典画面的快捷键（沿用原版）：空格 = 前进（掷骰）、D = 骰子数、< > = 旋转视角、M = 大地图。
// 焦点在输入框 / 按钮 / 下拉框上、带修饰键、或有模态对话框打开时不处理（按钮上的空格照常触发按钮自己）；
// 新闻板、命运板显示期间也不处理（场景根标 data-input-shield：原版板子期间程序停在等待循环里，按键只用来结束等待）。
import { useEffect, useRef } from 'react';

export interface HotkeyActions {
  roll(): void;
  cycleDice(): void;
  rotate(dir: -1 | 1): void;
  bigMap(): void;
}

export type HotkeyAction = 'roll' | 'dice' | 'rotateLeft' | 'rotateRight' | 'bigMap';

/** 按键 → 动作（不认识的键为 null） */
export function hotkeyOf(key: string): HotkeyAction | null {
  switch (key) {
    case ' ':
    case 'Spacebar':
      return 'roll';
    case 'd':
    case 'D':
      return 'dice';
    case '<':
    case ',':
      return 'rotateLeft';
    case '>':
    case '.':
      return 'rotateRight';
    case 'm':
    case 'M':
      return 'bigMap';
    default:
      return null;
  }
}

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY', 'A']);

/** 按键本身像经典快捷键（没有修饰键、不在输入框 / 按钮 / 对话框里）；不看页面上开着什么 */
function hotkeyTarget(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  const el = e.target instanceof Element ? e.target : null;
  if (el) {
    if (TYPING.has(el.tagName)) return false;
    if ((el as HTMLElement).isContentEditable) return false;
    if (el.closest('[role="dialog"], [role="alertdialog"]')) return false;
  }
  return true;
}

/** 这个按键事件该不该交给经典画面处理 */
export function shouldHandleHotkey(e: KeyboardEvent, doc: Document = document): boolean {
  if (!hotkeyTarget(e)) return false;
  // 打开着的模态框（radix Dialog）
  if (doc.querySelector('[role="dialog"][data-state="open"]')) return false;
  // 盖住工具列与棋盘的原版板子（ui/classic/popups/PopupScene 的 shield）：按键只用来跳过板子
  if (doc.querySelector('[data-input-shield="true"]')) return false;
  return true;
}

/**
 * 板子期间吞掉经典快捷键（PopupScene 的 shield）：窗口捕获阶段对快捷键 preventDefault，useClassicHotkeys 与原版棋盘
 * 自己的 < > 监听（game/orig/OrigRenderer，看 defaultPrevented）都不再处理——按 M 跳过命运板不会顺带切大地图、
 * 按 < > 不会转视角。只吞快捷键本身：打字、按钮上的空格 / 回车照常；按键放开照样结束板子（useAnyInputSkip 另听）
 */
export function useSwallowHotkeys(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (hotkeyOf(e.key) !== null && hotkeyTarget(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);
}

export function useClassicHotkeys(actions: HotkeyActions, enabled = true): void {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      const a = hotkeyOf(e.key);
      if (!a || !shouldHandleHotkey(e)) return;
      e.preventDefault();
      const x = ref.current;
      if (a === 'roll') x.roll();
      else if (a === 'dice') x.cycleDice();
      else if (a === 'rotateLeft') x.rotate(-1);
      else if (a === 'rotateRight') x.rotate(1);
      else x.bigMap();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
