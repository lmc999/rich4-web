// 棋盘渲染器注册处（original-skin.md §5 A6）：把原版棋盘（game/orig，OrigRenderer + OrigBoardController）注册为
// 'original' 棋盘工厂。skinStore 据 hasBoardFactory('original') 判定「原版渲染器可用」，判定为原版时 BoardCanvas 经
// skin/boards.createBoard 调这里的工厂；原版渲染器代码（Pixi）与素材包客户端都在调用时才动态 import。
// 由 skin/boards.ts（只被懒加载的对局页引用）在载入时安装，首屏不受影响。
import type { BoardFactory } from './BoardSurface';
import { boardFactory, registerBoardFactory } from './boardRegistry';
import { packClient } from './skinStore';

/** 原版棋盘工厂：取素材包客户端（manifest 已由 skinStore 发现并校验）与渲染器模块，再建棋盘 */
export const originalBoardFactory: BoardFactory = async (o) => {
  const [mod, client] = await Promise.all([import('../game/orig/createOrigBoard'), packClient()]);
  return mod.createOrigBoard(o, client);
};

/** 安装内置的棋盘渲染器（幂等；测试注销后可再次安装） */
export function installBoardRenderers(): void {
  if (boardFactory('original') !== originalBoardFactory) registerBoardFactory('original', originalBoardFactory);
}

installBoardRenderers();
