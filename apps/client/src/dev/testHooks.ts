// 测试钩子（design/client.md §12.2）：开发与测试模式下把渲染器挂到 window.__rich4，供 Playwright / 手工调试读取。
import type { GameRenderer } from '../game/GameRenderer';

export interface Rich4TestHooks {
  renderer: GameRenderer | null;
  /** 格中心的屏幕（画布）坐标，E2E 需要点画布时使用（一般应走 DOM 备用按钮） */
  tileScreenPos(id: number): { x: number; y: number } | null;
}

declare global {
  interface Window {
    __rich4?: Rich4TestHooks;
  }
}

export function exposeRenderer(renderer: GameRenderer | null): void {
  if (typeof window === 'undefined') return;
  window.__rich4 = {
    renderer,
    tileScreenPos(id) {
      if (!renderer?.board.loaded) return null;
      return renderer.camera.worldToScreen(renderer.board.tileScreenPos(id));
    },
  };
}
