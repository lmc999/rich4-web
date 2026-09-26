// 测试钩子（design/client.md §12.2）：开发与测试模式下挂到 window.__rich4，供 Playwright / 手工调试读取。
//   window.__rich4 = { store, eventPlayer: { idle }, board: { tileScreenPos(id) }, renderer, client }
// 对局页由 app/testHooksInstall 填 store / eventPlayer / client，BoardCanvas 挂载时填 board；开发页用 exposeRenderer。
import type { GameRenderer } from '../game/GameRenderer';

export interface Rich4TestHooks {
  /** zustand store（getState() 可读全部状态） */
  store: Record<string, { getState(): unknown }>;
  eventPlayer: { readonly idle: boolean; whenIdle(): Promise<void>; skipAll(): void };
  board: {
    /** 格中心的画布坐标（E2E 必须点画布时使用；一般应走 DOM 备用按钮） */
    tileScreenPos(id: number): { x: number; y: number } | null;
  };
  renderer: GameRenderer | null;
  /** GameClient（调试：debug(op)、act(intent)） */
  client: unknown;
  /** 旧名（开发页）：等同 board.tileScreenPos */
  tileScreenPos(id: number): { x: number; y: number } | null;
}

declare global {
  interface Window {
    __rich4?: Rich4TestHooks;
  }
}

const EMPTY_PLAYER = { idle: true, whenIdle: () => Promise.resolve(), skipAll: () => {} };

/** 取得（必要时创建）钩子对象 */
export function testHooks(): Rich4TestHooks | null {
  if (typeof window === 'undefined') return null;
  if (!window.__rich4) {
    const hooks: Rich4TestHooks = {
      store: {},
      eventPlayer: EMPTY_PLAYER,
      board: { tileScreenPos: () => null },
      renderer: null,
      client: null,
      tileScreenPos: (id) => hooks.board.tileScreenPos(id),
    };
    window.__rich4 = hooks;
  }
  return window.__rich4;
}

/** 棋盘坐标来源（BoardCanvas 挂载 / 卸载） */
export function exposeBoard(
  pos: ((id: number) => { x: number; y: number } | null) | null,
  renderer: GameRenderer | null,
): void {
  const h = testHooks();
  if (!h) return;
  h.board = { tileScreenPos: pos ?? (() => null) };
  h.renderer = renderer;
}

/** 开发页：直接暴露渲染器 */
export function exposeRenderer(renderer: GameRenderer | null): void {
  exposeBoard(
    renderer
      ? (id) => (renderer.board.loaded ? renderer.camera.worldToScreen(renderer.board.tileScreenPos(id)) : null)
      : null,
    renderer,
  );
}
