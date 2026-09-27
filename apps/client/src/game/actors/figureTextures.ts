// 造型纹理缓存（神明、恶人、NPC、恶犬）：SVG → Image → Canvas → Pixi 纹理，按键缓存。
// 与角色图集同一条管线（procedural/character/atlas）；纹理源是 Canvas，WebGL 上下文恢复后由 Pixi 重新上传。
// node（单测）没有 DOM：一律得到 null，调用方保留占位图形。
import { CanvasSource, Rectangle, Texture } from 'pixi.js';
import { atlasLayout, type CharacterFrames, loadSvgImage } from '../procedural/character/atlas';
import type { Facing, Pose } from '../procedural/character/rig';
import { VIEW_H, VIEW_W } from '../procedural/character/rig';
import { type FigureId, figureSvg } from './figures';

export function canRasterize(): boolean {
  return typeof document !== 'undefined' && typeof Image !== 'undefined';
}

interface Owned {
  textures: Texture[];
  source: CanvasSource;
}

export class FigureTextures {
  private readonly singles = new Map<string, Promise<Texture | null>>();
  private readonly sheets = new Map<string, Promise<CharacterFrames | null>>();
  private readonly owned: Owned[] = [];
  private dead = false;

  constructor(private readonly scale: 1 | 2 = 2) {}

  /** 单帧纹理（128×160 的 SVG）；不可用或失败时为 null */
  texture(key: string, svg: () => string): Promise<Texture | null> {
    let p = this.singles.get(key);
    if (!p) {
      p = this.rasterize(svg());
      this.singles.set(key, p);
    }
    return p;
  }

  /** 全部姿势 × 两个朝向（恶人、恶犬行走用） */
  frames(id: FigureId): Promise<CharacterFrames | null> {
    let p = this.sheets.get(id);
    if (!p) {
      p = this.buildFrames(id);
      this.sheets.set(id, p);
    }
    return p;
  }

  destroy(): void {
    this.dead = true;
    for (const o of this.owned.splice(0)) {
      for (const t of o.textures) t.destroy(false);
      o.source.destroy();
    }
    this.singles.clear();
    this.sheets.clear();
  }

  private async rasterize(svg: string): Promise<Texture | null> {
    if (!canRasterize() || this.dead) return null;
    try {
      const img = await loadSvgImage(svg);
      if (this.dead) return null;
      const canvas = document.createElement('canvas');
      canvas.width = VIEW_W * this.scale;
      canvas.height = VIEW_H * this.scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const source = new CanvasSource({ resource: canvas, resolution: this.scale });
      const texture = new Texture({ source, frame: new Rectangle(0, 0, VIEW_W, VIEW_H) });
      this.owned.push({ textures: [texture], source });
      return texture;
    } catch {
      return null;
    }
  }

  private async buildFrames(id: FigureId): Promise<CharacterFrames | null> {
    if (!canRasterize() || this.dead) return null;
    try {
      const layout = atlasLayout(this.scale);
      const canvas = document.createElement('canvas');
      canvas.width = layout.cols * VIEW_W * this.scale;
      canvas.height = layout.rows * VIEW_H * this.scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const images = await Promise.all(layout.frames.map((f) => loadSvgImage(figureSvg(id, f.pose, f.facing))));
      if (this.dead) return null;
      layout.frames.forEach((f, i) => {
        ctx.drawImage(images[i]!, f.x * this.scale, f.y * this.scale, VIEW_W * this.scale, VIEW_H * this.scale);
      });
      const source = new CanvasSource({ resource: canvas, resolution: this.scale });
      const map = new Map<string, Texture>();
      for (const f of layout.frames) {
        map.set(`${f.pose}/${f.facing}`, new Texture({ source, frame: new Rectangle(f.x, f.y, VIEW_W, VIEW_H) }));
      }
      const owned: Owned = { textures: [...map.values()], source };
      this.owned.push(owned);
      return {
        key: id,
        get(pose: Pose, facing: Facing) {
          const t = map.get(`${pose}/${facing}`);
          if (!t) throw new Error(`missing frame ${id}/${pose}/${facing}`);
          return t;
        },
        destroy() {
          // 由 FigureTextures.destroy 统一释放
        },
      };
    } catch {
      return null;
    }
  }
}
