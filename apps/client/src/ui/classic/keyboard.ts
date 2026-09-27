// 经典画面的快捷键（沿用原版）：空格 = 前进（掷骰）、D = 骰子数、< > = 旋转视角、M = 大地图。
// 焦点在输入框 / 按钮 / 下拉框上、带修饰键、或有模态对话框打开时不处理（按钮上的空格照常触发按钮自己）。
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

/** 这个按键事件该不该交给经典画面处理 */
export function shouldHandleHotkey(e: KeyboardEvent, doc: Document = document): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  const el = e.target instanceof Element ? e.target : null;
  if (el) {
    if (TYPING.has(el.tagName)) return false;
    if ((el as HTMLElement).isContentEditable) return false;
    if (el.closest('[role="dialog"], [role="alertdialog"]')) return false;
  }
  // 打开着的模态框（radix Dialog）
  if (doc.querySelector('[role="dialog"][data-state="open"]')) return false;
  return true;
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
