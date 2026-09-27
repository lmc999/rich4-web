// 弹窗用的造型图（神明、NPC、恶人）：SVG 纸娃娃生成后转 data URL 并缓存；纯字符串，不依赖 Pixi。
import type { GodKind } from '@rich4/shared/engine';
import { anyFigureSvg, type FigureId, godSvg } from '../../game/actors/figures';
import type { Pose } from '../../game/procedural/character/rig';
import { svgDataUrl } from '../../game/procedural/character/svg';

const cache = new Map<string, string>();

export function figureUrl(id: FigureId, pose: Pose = 'idle0'): string {
  const key = `${id}/${pose}`;
  let url = cache.get(key);
  if (!url) {
    url = svgDataUrl(anyFigureSvg(id, pose));
    cache.set(key, url);
  }
  return url;
}

export function godUrl(kind: GodKind, pose: Pose = 'idle0'): string {
  const key = `god:${kind}/${pose}`;
  let url = cache.get(key);
  if (!url) {
    url = svgDataUrl(godSvg(kind, pose));
    cache.set(key, url);
  }
  return url;
}
