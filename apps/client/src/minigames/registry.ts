// 小游戏前端模块注册表（懒加载：首屏与棋盘 chunk 不含小游戏代码；决策出现或收到观战票据时才加载对应游戏）。
// 视图按皮肤选择（原版皮肤 A13；original-skin.md §3 修正 7）：原版皮肤且必需条目全部可用时建原版视图（orig/ 与各游戏的
// origView.ts，同样懒加载），预载失败或创建出错时整局回退程序化视图（不拼接）。
import type { MinigameId, SimBase } from '@rich4/shared/minigames';
import type { MgSound } from './orig/audio';
import type { MgPackSource } from './orig/keys';
import type { OrigMgKit } from './orig/kit';
import type { MinigameClientModule, MinigameView, ViewContext } from './types';

export const MINIGAME_MODULES: Readonly<Record<MinigameId, () => Promise<MinigameClientModule<SimBase>>>> = {
  penguin: () => import('./penguin/index').then((m) => m.default as unknown as MinigameClientModule<SimBase>),
  balloon: () => import('./balloon/index').then((m) => m.default as unknown as MinigameClientModule<SimBase>),
  xicong: () => import('./xicong/index').then((m) => m.default as unknown as MinigameClientModule<SimBase>),
};

export function loadMinigameModule(id: MinigameId): Promise<MinigameClientModule<SimBase>> {
  return MINIGAME_MODULES[id]();
}

/** 原版视图的选用条件（宿主按皮肤与素材包算出；null 表示用程序化视图） */
export interface OrigViewRequest {
  pack: MgPackSource;
  /** 必需条目（任一加载失败 → 回退） */
  keys: readonly string[];
  /** 可选条目（失败只少这一项表现） */
  optional: readonly string[];
  sound: MgSound;
}

/** 按皮肤建视图：原版可用时返回原版视图与它的素材工具（调用方负责销毁），否则程序化视图 */
export async function createMinigameView(
  mod: MinigameClientModule<SimBase>,
  ctx: ViewContext,
  orig: OrigViewRequest | null,
): Promise<{ view: MinigameView<SimBase>; kit: OrigMgKit | null }> {
  if (orig && mod.createOrigView) {
    const { OrigMgKit } = await import('./orig/kit');
    const kit = new OrigMgKit(orig.pack);
    try {
      if (await kit.preload(orig.keys, orig.optional)) {
        const view = await mod.createOrigView({ ...ctx, kit, sound: orig.sound });
        if (view) return { view, kit };
      } else {
        console.warn(`[minigame] ${mod.id} 原版素材加载不全，回退程序化视图`);
      }
    } catch (err) {
      console.warn(`[minigame] ${mod.id} 原版视图创建失败，回退程序化视图`, err);
    }
    kit.destroy();
  }
  return { view: await mod.createView(ctx), kit: null };
}
