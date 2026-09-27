// 小游戏前端模块注册表（懒加载：首屏与棋盘 chunk 不含小游戏代码；决策出现或收到观战票据时才加载对应游戏）。
import type { MinigameId, SimBase } from '@rich4/shared/minigames';
import type { MinigameClientModule } from './types';

export const MINIGAME_MODULES: Readonly<Record<MinigameId, () => Promise<MinigameClientModule<SimBase>>>> = {
  penguin: () => import('./penguin/index').then((m) => m.default as unknown as MinigameClientModule<SimBase>),
  balloon: () => import('./balloon/index').then((m) => m.default as unknown as MinigameClientModule<SimBase>),
  xicong: () => import('./xicong/index').then((m) => m.default as unknown as MinigameClientModule<SimBase>),
};

export function loadMinigameModule(id: MinigameId): Promise<MinigameClientModule<SimBase>> {
  return MINIGAME_MODULES[id]();
}
