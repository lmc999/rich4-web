// 测试钩子（design/client.md §12.2）：开发与测试模式下挂到 window.__rich4，供 Playwright / 手工调试读取。
//   window.__rich4 = { store, eventPlayer: { idle }, board: { tileScreenPos(id) }, renderer, client, skin, audio }
// 对局页由 app/testHooksInstall 填 store / eventPlayer / client，BoardCanvas 挂载时填 board 与 renderer，
// useGameSkin 填 skin，app/audioWiring 填 audio（音频引擎状态与逻辑日志）；开发页用 exposeRenderer。
// 原版皮肤 A5（original-skin.md §3 修正 6/7）：renderer 是棋盘表面接口 BoardSurface（程序化或原版），
// E2E 读的 renderer.board.allActors() / actor(seat) / roads.counts() 两种皮肤同形。
import type { AudioTestHooks } from '../audio';
import type { GameRenderer } from '../game/GameRenderer';
import type { BoardSurface } from '../skin/BoardSurface';
import type { PackState, SkinKind, SkinResolution } from '../skin/types';

/** 皮肤判定的快照（E2E：skin-*.spec） */
export interface SkinHookSnapshot {
  resolution: SkinResolution;
  pack: PackState['status'];
  packId: string | null;
  failedGroups: string[];
  /** BoardCanvas 实际创建的棋盘 */
  boardInUse: SkinKind | null;
  /** 已应用到页面的皮肤（语言与主题） */
  applied: SkinKind | null;
  lang: string;
}

/** 一次倒计时提示音请求（E2E：最后 10 秒每秒一次、提交后停止） */
export interface CountdownBeepRecord {
  decisionId: string;
  /** 响的是剩余第几秒 */
  secs: number;
  level: 'tick' | 'final';
  /** 本机时间（ms） */
  at: number;
  /** 请求时音频系统已接好（?audio=off、没有 Web Audio 或音频模块还没载入时为 false） */
  audio: boolean;
}

export interface Rich4TestHooks {
  /** zustand store（getState() 可读全部状态） */
  store: Record<string, { getState(): unknown }>;
  eventPlayer: { readonly idle: boolean; whenIdle(): Promise<void>; skipAll(): void };
  board: {
    /** 格中心的画布坐标（E2E 必须点画布时使用；一般应走 DOM 备用按钮） */
    tileScreenPos(id: number): { x: number; y: number } | null;
  };
  /** 当前棋盘表面（程序化或原版）；没有棋盘时为 null */
  renderer: BoardSurface | null;
  /** GameClient（调试：debug(op)、act(intent)） */
  client: unknown;
  /** 皮肤判定（对局页挂载后可用） */
  readonly skin: SkinHookSnapshot | null;
  /** 音频（?audio=off 或未加载时为 null）：state、log（逻辑动作日志）、music()、clearLog() */
  audio: AudioTestHooks | null;
  /** 中央决策倒计时的提示音请求（ui/common/countdownSound；?audio=off 时照样记录，audio 为 false） */
  countdown?: { beeps: CountdownBeepRecord[] };
  /** 旧名（开发页）：等同 board.tileScreenPos */
  tileScreenPos(id: number): { x: number; y: number } | null;
}

declare global {
  interface Window {
    __rich4?: Rich4TestHooks;
  }
}

const EMPTY_PLAYER = { idle: true, whenIdle: () => Promise.resolve(), skipAll: () => {} };

let skinSource: (() => SkinHookSnapshot) | null = null;

/** 取得（必要时创建）钩子对象 */
export function testHooks(): Rich4TestHooks | null {
  if (typeof window === 'undefined') return null;
  if (!window.__rich4) {
    const hooks = {
      store: {},
      eventPlayer: EMPTY_PLAYER,
      board: { tileScreenPos: () => null },
      renderer: null,
      client: null,
      audio: null,
      get skin(): SkinHookSnapshot | null {
        return skinSource ? skinSource() : null;
      },
      tileScreenPos: (id: number) => hooks.board.tileScreenPos(id),
    } as Rich4TestHooks;
    window.__rich4 = hooks;
  }
  return window.__rich4;
}

/** 棋盘坐标来源与棋盘表面（BoardCanvas 挂载 / 卸载） */
export function exposeBoard(
  pos: ((id: number) => { x: number; y: number } | null) | null,
  surface: BoardSurface | null,
): void {
  const h = testHooks();
  if (!h) return;
  h.board = { tileScreenPos: pos ?? (() => null) };
  h.renderer = surface;
}

/** 皮肤判定的来源（useGameSkin 挂载时设置；返回撤销函数） */
export function exposeSkin(source: () => SkinHookSnapshot): () => void {
  if (!testHooks()) return () => {};
  skinSource = source;
  return () => {
    if (skinSource === source) skinSource = null;
  };
}

/** 开发页：直接暴露程序化渲染器（经它的 BoardSurface 门面） */
export function exposeRenderer(renderer: GameRenderer | null): void {
  exposeBoard(renderer ? (id) => renderer.surface.tileCanvasPos(id) : null, renderer ? renderer.surface : null);
}
