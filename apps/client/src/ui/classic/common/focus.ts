// 原版场景的焦点与按键归属：场景弹出时不从场景外的输入框（聊天框等）抢走焦点，单字母热键只认场景里的按键。

/** 元素接收文字输入（输入框、多行文本、下拉框、可编辑区）——焦点在这类元素上时按键属于它自己 */
export function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit', 'hidden'].includes(
    type,
  );
}

/** 场景挂载时是否把焦点移入：焦点在场景外的文字输入元素上（玩家正在打字）时不移，免得后续按键被当成场景热键 */
export function shouldTakeFocus(root: HTMLElement, active: Element | null): boolean {
  if (active === null || active === document.body || active === document.documentElement) return true;
  if (root.contains(active)) return true;
  return !isTextEntry(active);
}
