// 程序化纹理缓存（design/client.md §3.3、§8）：key → RenderTexture。
// 记住每个 key 的构建函数；WebGL 上下文恢复后 rebuildAll() 把内容重新渲染进「同一个」纹理对象，
// 精灵引用不变，无需重建场景。退出对局时 clear() 释放显存。
import { type Container, Matrix, Rectangle, type Renderer, type Texture } from 'pixi.js';

export interface CachedTexture {
  texture: Texture;
  /** 让局部原点对齐精灵位置的 anchor（0..1） */
  anchor: { x: number; y: number };
  /** 局部包围盒（含 padding） */
  frame: Rectangle;
}

interface Entry extends CachedTexture {
  build: () => Container;
}

const PAD = 4;

export class TextureCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly renderer: Renderer,
    private readonly resolution = 2,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** 取纹理；不存在时用 build() 生成一次（build 返回的容器在生成后销毁） */
  get(key: string, build: () => Container): CachedTexture {
    const hit = this.entries.get(key);
    if (hit) return hit;
    const node = build();
    const b = node.getLocalBounds();
    const frame = new Rectangle(
      Math.floor(b.x) - PAD,
      Math.floor(b.y) - PAD,
      Math.max(1, Math.ceil(b.width) + PAD * 2),
      Math.max(1, Math.ceil(b.height) + PAD * 2),
    );
    const texture = this.renderer.generateTexture({
      target: node,
      frame,
      resolution: this.resolution,
      antialias: true,
    });
    node.destroy({ children: true });
    const entry: Entry = {
      texture,
      frame,
      anchor: { x: -frame.x / frame.width, y: -frame.y / frame.height },
      build,
    };
    this.entries.set(key, entry);
    return entry;
  }

  /** 上下文恢复后：重新渲染全部纹理内容（保持 Texture 对象身份） */
  rebuildAll(): void {
    for (const e of this.entries.values()) {
      const node = e.build();
      this.renderer.render({
        container: node,
        target: e.texture,
        clear: true,
        transform: new Matrix().translate(-e.frame.x, -e.frame.y),
      });
      node.destroy({ children: true });
    }
  }

  delete(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.texture.destroy(true);
    this.entries.delete(key);
  }

  clear(): void {
    for (const e of this.entries.values()) e.texture.destroy(true);
    this.entries.clear();
  }
}
