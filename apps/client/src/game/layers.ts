// 渲染分层（design/client.md §3.3）
// stage
//  └ world (Camera 控制 position/scale)
//     ├ ground     地形 + 道路 + 特殊格底板（静态，分块 cacheAsTexture）
//     ├ marks      地块归属色带 / 高亮 / 路径预览 / 目标选择（isRenderGroup）
//     ├ objects    建筑、地标、路面物件、角色、装饰（按深度排序）
//     ├ fx         粒子、光柱、爆炸
//     └ overlay    飘字、名牌、气泡（不排序，始终最上）
//  └ screenFx      全屏闪白、暗角（不受镜头影响）
//  └ minigameRoot  小游戏场景
import { Container } from 'pixi.js';

export interface Layers {
  stage: Container;
  world: Container;
  ground: Container;
  marks: Container;
  objects: Container;
  fx: Container;
  overlay: Container;
  screenFx: Container;
  minigameRoot: Container;
}

export function createLayers(stage: Container): Layers {
  const world = new Container({ label: 'world' });
  const ground = new Container({ label: 'ground' });
  const marks = new Container({ label: 'marks', isRenderGroup: true });
  const objects = new Container({ label: 'objects', sortableChildren: true });
  const fx = new Container({ label: 'fx' });
  const overlay = new Container({ label: 'overlay' });
  const screenFx = new Container({ label: 'screenFx' });
  const minigameRoot = new Container({ label: 'minigameRoot', visible: false });
  world.addChild(ground, marks, objects, fx, overlay);
  stage.addChild(world, screenFx, minigameRoot);
  return { stage, world, ground, marks, objects, fx, overlay, screenFx, minigameRoot };
}

/** 清空某层的子节点（销毁） */
export function clearLayer(layer: Container): void {
  for (const c of layer.removeChildren()) c.destroy({ children: true });
}
