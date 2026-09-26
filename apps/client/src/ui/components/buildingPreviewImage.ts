// 建筑外观预览图：用 M3a 的建筑生成器（Pixi Graphics）画一张 PNG，供 DOM 对话框（加盖、买地）显示。
// 全局只建一个离屏渲染器，按 buildingKey 缓存 data URL。本模块含 Pixi，只能经动态 import 懒加载。
import { autoDetectRenderer, type Renderer } from 'pixi.js';
import { type BuildingSpec, buildingKey, getBuildingTexture } from '../../game/procedural/building/generate';
import { TextureCache } from '../../game/procedural/textureCache';

let rendererP: Promise<{ renderer: Renderer; cache: TextureCache }> | null = null;
const urls = new Map<string, Promise<string>>();

function shared(): Promise<{ renderer: Renderer; cache: TextureCache }> {
  rendererP ??= autoDetectRenderer({
    width: 8,
    height: 8,
    preference: 'webgl',
    backgroundAlpha: 0,
    antialias: true,
  }).then((renderer) => ({ renderer, cache: new TextureCache(renderer, 2) }));
  return rendererP;
}

/** 生成（或取缓存的）建筑 PNG data URL */
export function buildingPreviewImage(spec: BuildingSpec): Promise<string> {
  const key = buildingKey(spec);
  let p = urls.get(key);
  if (!p) {
    p = shared().then(({ renderer, cache }) => {
      const tex = getBuildingTexture(cache, spec);
      return renderer.extract.base64({ target: tex.texture, format: 'png' });
    });
    p.catch(() => urls.delete(key));
    urls.set(key, p);
  }
  return p;
}
