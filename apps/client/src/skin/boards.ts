// 棋盘工厂（BoardCanvas 用）：按皮肤判定创建棋盘表面与控制器。程序化棋盘内置（GameRenderer + BoardController）；
// 原版棋盘由 A6 经 boardRegistry.registerBoardFactory('original', …) 注册——没有注册或创建失败时回退程序化，
// 并把回退原因报给 skinStore（设置页显示）。本模块引入 Pixi，只由懒加载的对局页使用。
import { BoardController } from '../game/BoardController';
import { GameRenderer } from '../game/GameRenderer';
import { type BoardFactory, boardAbortError, type CreateBoardOptions, type CreatedBoard } from './BoardSurface';
import { boardFactory } from './boardRegistry';
import type { SkinKind } from './types';

/** 程序化棋盘：创建渲染器 → 设 insets → 加载地图（fitAll）→ 建控制器 */
export const createProceduralBoard: BoardFactory = async (o: CreateBoardOptions): Promise<CreatedBoard> => {
  const r = await GameRenderer.create({
    host: o.host,
    clock: o.clock,
    quality: o.quality,
    labels: { label: (key) => o.label?.(key) },
    ...(o.onTap ? { onTap: (pick, screen) => o.onTap?.(pick, screen) } : {}),
    ...(o.onDoubleTap ? { onDoubleTap: (screen) => o.onDoubleTap?.(screen) } : {}),
    ...(o.onContextLost ? { onContextLost: o.onContextLost } : {}),
  });
  if (o.signal?.aborted) {
    r.destroy();
    throw boardAbortError();
  }
  const surface = r.surface;
  try {
    surface.camera.setInsets(o.insets);
    await surface.loadMap(o.def);
  } catch (e) {
    r.destroy();
    throw e;
  }
  if (o.signal?.aborted) {
    r.destroy();
    throw boardAbortError();
  }
  const controller = new BoardController(r, o.controller);
  return { surface, controller };
};

export interface BoardCreation extends CreatedBoard {
  /** 实际使用的棋盘 */
  kind: SkinKind;
  /** 请求原版但用了程序化：失败原因（未注册为 null） */
  fallback: 'renderer-unavailable' | 'renderer-failed' | null;
}

/**
 * 按判定创建棋盘：want 为 original 且已注册原版工厂时先试原版，失败（非中止）则回退程序化。
 */
export async function createBoard(want: SkinKind, o: CreateBoardOptions): Promise<BoardCreation> {
  if (want === 'original') {
    const factory = boardFactory('original');
    if (!factory) return { ...(await createProceduralBoard(o)), kind: 'procedural', fallback: 'renderer-unavailable' };
    try {
      return { ...(await factory(o)), kind: 'original', fallback: null };
    } catch (e) {
      if ((e as Error | null)?.name === 'AbortError' || o.signal?.aborted) throw e;
      console.warn('[skin] 原版棋盘创建失败，回退程序化', e);
      return { ...(await createProceduralBoard(o)), kind: 'procedural', fallback: 'renderer-failed' };
    }
  }
  return { ...(await createProceduralBoard(o)), kind: 'procedural', fallback: null };
}
