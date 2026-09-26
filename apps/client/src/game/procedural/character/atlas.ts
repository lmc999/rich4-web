// 角色图集（design/client.md §6.2）：把 characterSvg 栅格化到 Canvas，再切成子纹理。
// 每个角色一页：11 姿势 × 2 朝向 = 22 帧；scale=2 时单帧 256×320，8 列 × 3 行 = 2048×960。
// 纹理源是 Canvas，WebGL 上下文恢复后 Pixi 会从 Canvas 重新上传，无需重新栅格化。
import { CanvasSource, Rectangle, Texture } from 'pixi.js';
import type { CharacterConfig } from './defs';
import { FACINGS, type Facing, POSES, type Pose, VIEW_H, VIEW_W } from './rig';
import { characterSvg, svgDataUrl } from './svg';

export const ATLAS_MAX = 2048;

export function frameKey(characterKey: string, pose: Pose, facing: Facing): string {
  return `${characterKey}/${pose}/${facing}`;
}

/** 单帧布局：返回帧在页内的像素位置（逻辑像素，未乘 scale） */
export function atlasLayout(scale: number): {
  cols: number;
  rows: number;
  frames: { pose: Pose; facing: Facing; x: number; y: number }[];
} {
  const cols = Math.max(1, Math.floor(ATLAS_MAX / (VIEW_W * scale)));
  const frames: { pose: Pose; facing: Facing; x: number; y: number }[] = [];
  let i = 0;
  for (const facing of FACINGS) {
    for (const pose of POSES) {
      frames.push({ pose, facing, x: (i % cols) * VIEW_W, y: Math.floor(i / cols) * VIEW_H });
      i++;
    }
  }
  return { cols, rows: Math.ceil(i / cols), frames };
}

/** SVG 字符串 → 已解码的 Image（浏览器环境） */
export async function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = svgDataUrl(svg);
  await img.decode();
  return img;
}

export interface CharacterFrames {
  key: string;
  get(pose: Pose, facing: Facing): Texture;
  destroy(): void;
}

/** 栅格化一个角色的全部帧 */
export async function buildCharacterFrames(c: CharacterConfig, scale: 1 | 2 = 2): Promise<CharacterFrames> {
  const layout = atlasLayout(scale);
  const canvas = document.createElement('canvas');
  canvas.width = layout.cols * VIEW_W * scale;
  canvas.height = layout.rows * VIEW_H * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const images = await Promise.all(layout.frames.map((f) => loadSvgImage(characterSvg(c, f.pose, f.facing))));
  layout.frames.forEach((f, i) => {
    ctx.drawImage(images[i]!, f.x * scale, f.y * scale, VIEW_W * scale, VIEW_H * scale);
  });
  const source = new CanvasSource({ resource: canvas, resolution: scale });
  const textures = new Map<string, Texture>();
  for (const f of layout.frames) {
    textures.set(
      frameKey(c.key, f.pose, f.facing),
      new Texture({ source, frame: new Rectangle(f.x, f.y, VIEW_W, VIEW_H), label: frameKey(c.key, f.pose, f.facing) }),
    );
  }
  return {
    key: c.key,
    get(pose, facing) {
      const t = textures.get(frameKey(c.key, pose, facing));
      if (!t) throw new Error(`missing frame ${frameKey(c.key, pose, facing)}`);
      return t;
    },
    destroy() {
      for (const t of textures.values()) t.destroy(false);
      textures.clear();
      source.destroy();
    },
  };
}

/** 多个角色的图集（按需生成、缓存） */
export class CharacterAtlas {
  private readonly pages = new Map<string, Promise<CharacterFrames>>();

  constructor(private readonly scale: 1 | 2 = 2) {}

  load(c: CharacterConfig): Promise<CharacterFrames> {
    let p = this.pages.get(c.key);
    if (!p) {
      p = buildCharacterFrames(c, this.scale);
      this.pages.set(c.key, p);
    }
    return p;
  }

  async destroy(): Promise<void> {
    const all = [...this.pages.values()];
    this.pages.clear();
    for (const p of all) (await p).destroy();
  }
}
