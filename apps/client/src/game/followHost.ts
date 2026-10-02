// 画布跟随宿主尺寸（GameRenderer / OrigRenderer 共用）。
// Pixi 的 resizeTo 只监听 window 'resize'，并在下一帧读宿主的 clientWidth / clientHeight；宿主尺寸却常由 React 状态决定
// （经典舞台量过视口后 setState，棋盘视窗 classic-board-slot 跟着改），提交晚于 Pixi 那一帧时读到的是旧尺寸，
// autoDensity 再把画布 style 宽高写成旧的 px——单次视口变化（转屏、窗口最大化）后画布就停在上一次的尺寸，直到下一次 window resize。
// 这里另外观察宿主本身：布局后尺寸一变就同步 resize（ResizeObserver 回调在绘制之前，不会先画出一帧错位的画布）。
// 宿主须是尺寸与画布无关的块（绝对定位铺满等），否则 resize 改画布又撑大宿主会形成 ResizeObserver 循环。
import type { Application } from 'pixi.js';

/** 观察 host 尺寸并同步 app.resize()；返回撤销函数（须在 app.destroy() 之前调用） */
export function followHostSize(app: Application, host: HTMLElement): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const ro = new ResizeObserver(() => app.resize());
  ro.observe(host);
  return () => ro.disconnect();
}
