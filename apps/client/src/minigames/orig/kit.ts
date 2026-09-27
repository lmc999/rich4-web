// 小游戏原版视图的 Pixi 素材工具（原版皮肤 A13）：
// - 精灵库沿用原版棋盘的 OrigAssets（图集 JSON + 页位图 → 纹理，逐帧锚点；位图向素材包客户端借、销毁时归还）；
// - 整图条目（喜从天降背景 Panel#92）自己建纹理源；
// - FLC 精灵：FlicPlayer 逐帧解码到一张画布（CanvasSource 纹理），由调用方按时间选帧（show）；
// - 缩放档：舞台到设备像素的倍率为整数时最近邻、非整数平滑（与原版棋盘同一规则 smoothingFor）。
import type { FlicEntry } from '@rich4/shared/assets';
import { CanvasSource, ImageSource, Rectangle, Sprite, Texture, type TextureSource } from 'pixi.js';
import { OrigAssets, type PackBitmap, type SpriteSheet, smoothingFor } from '../../game/orig/OrigAssets';
import type { FlcFile } from '../../skin/flic/FlcDecoder';
import { CanvasFrameSink, FlicPlayer } from '../../skin/flic/FlicPlayer';
import type { MgPackSource } from './keys';

/** 按原版语义摆放的精灵：落点 = 画点 − 锚点（用 pivot 表示，缩放围绕锚点） */
export class FrameSprite extends Sprite {
  sheet: SpriteSheet | null = null;
  frameIndex = -1;

  constructor(sheet: SpriteSheet | null = null, frame = 0) {
    super();
    if (sheet) this.show(sheet, frame);
  }

  show(sheet: SpriteSheet, frame: number): void {
    const i = Math.max(0, Math.min(sheet.count - 1, Math.trunc(frame)));
    if (this.sheet === sheet && this.frameIndex === i) return;
    this.sheet = sheet;
    this.frameIndex = i;
    this.texture = sheet.frames[i]!;
    const a = sheet.anchors[i]!;
    this.pivot.set(a[0], a[1]);
  }
}

/** 不推进时间的时钟（帧由调用方按服务器时间选择） */
const STILL_CLOCK = { now: () => 0, wait: () => Promise.resolve(), instant: false } as const;

/** FLC 画到画布纹理上的精灵（左上角对齐画点） */
export class FlcSprite {
  readonly sprite: Sprite;
  readonly frames: number;
  readonly frameMs: number;
  private readonly player: FlicPlayer;
  private readonly sink: CanvasFrameSink;
  private readonly tex: Texture;
  private dead = false;

  constructor(entry: FlicEntry, flc: FlcFile, smooth: boolean) {
    this.sink = new CanvasFrameSink(flc.width, flc.height);
    this.player = new FlicPlayer(flc, {
      clock: STILL_CLOCK,
      sink: this.sink,
      opaque: entry.transparency === 'opaque',
      label: 'minigame-flc',
      onFrame: () => {
        if (!this.tex.destroyed) this.tex.source.update();
      },
    });
    this.tex = new Texture({ source: new CanvasSource({ resource: this.sink.canvas as HTMLCanvasElement }) });
    this.tex.source.scaleMode = smooth ? 'linear' : 'nearest';
    this.sprite = new Sprite(this.tex);
    this.sprite.visible = false;
    this.frames = this.player.frames;
    this.frameMs = entry.frameMs;
  }

  get current(): number {
    return this.player.currentFrame;
  }

  /** 显示第 frame 帧；越界（未开始或已播完）时隐藏 */
  showAt(frame: number): void {
    if (this.dead) return;
    if (frame < 0 || frame >= this.frames) {
      this.sprite.visible = false;
      return;
    }
    if (this.player.currentFrame !== frame) this.player.show(frame);
    this.sprite.visible = true;
  }

  setSmooth(on: boolean): void {
    if (!this.tex.destroyed) this.tex.source.scaleMode = on ? 'linear' : 'nearest';
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.player.destroy();
    this.sprite.destroy();
    this.tex.destroy(true);
    this.sink.release();
  }
}

export class OrigMgKit {
  readonly assets: OrigAssets;
  private readonly images = new Map<string, { tex: Texture; file: string }>();
  private readonly extra: Texture[] = [];
  private readonly imageSources: TextureSource[] = [];
  private readonly flcs: FlcSprite[] = [];
  private smooth = false;
  private dead = false;

  constructor(readonly pack: MgPackSource) {
    this.assets = new OrigAssets(pack);
  }

  /**
   * 预载：必需条目任一失败 → false（调用方整局回退）；可选条目失败只告警。精灵 → 精灵库，整图 → 纹理；
   * FLC 与掩膜按需另取。
   */
  async preload(required: readonly string[], optional: readonly string[] = []): Promise<boolean> {
    const one = async (key: string): Promise<boolean> => {
      const e = this.pack.usableEntry(key);
      if (!e) return false;
      if (e.type === 'sprite') return (await this.assets.sheet(key)) !== null;
      if (e.type === 'image') return (await this.loadImage(key)) !== null;
      return e.type === 'flic' || e.type === 'mask';
    };
    const [req] = await Promise.all([
      Promise.all(required.map(one)),
      Promise.all(optional.map((k) => one(k).catch(() => false))),
    ]);
    return !this.dead && req.every(Boolean);
  }

  sheet(key: string): SpriteSheet | null {
    return this.assets.sheetNow(key);
  }

  image(key: string): Texture | null {
    return this.images.get(key)?.tex ?? null;
  }

  private async loadImage(key: string): Promise<Texture | null> {
    const hit = this.images.get(key);
    if (hit) return hit.tex;
    const e = this.pack.usableEntry(key);
    if (e?.type !== 'image') return null;
    let bmp: PackBitmap;
    try {
      bmp = await this.pack.loadImage(e.file);
    } catch (err) {
      console.warn(`[minigame] 整图 ${key} 加载失败`, err);
      return null;
    }
    if (this.dead) {
      this.pack.releaseImage?.(e.file);
      return null;
    }
    const source = new ImageSource({ resource: bmp, scaleMode: this.smooth ? 'linear' : 'nearest', label: key });
    this.imageSources.push(source);
    const tex = new Texture({ source, label: key });
    this.images.set(key, { tex, file: e.file });
    return tex;
  }

  /** 精灵库第 frame 帧从 y0 起的下半截（HUD 条盖层）；锚点按左上角 */
  strip(sheet: SpriteSheet, frame: number, y0: number): Texture {
    const f = sheet.frames[frame]!;
    const r = f.frame;
    const tex = new Texture({ source: f.source, frame: new Rectangle(r.x, r.y + y0, r.width, r.height - y0) });
    this.extra.push(tex);
    return tex;
  }

  /** 整图从 y0 起的下半截 */
  imageStrip(tex: Texture, y0: number): Texture {
    const t = new Texture({ source: tex.source, frame: new Rectangle(0, y0, tex.width, tex.height - y0) });
    this.extra.push(t);
    return t;
  }

  /** FLC 条目 → 精灵（失败为 null） */
  async flc(key: string): Promise<FlcSprite | null> {
    const e = this.pack.usableEntry(key);
    if (e?.type !== 'flic') return null;
    try {
      const { entry, flc } = await this.pack.loadFlic(key);
      if (this.dead) return null;
      const s = new FlcSprite(entry, flc, this.smooth);
      this.flcs.push(s);
      return s;
    } catch (err) {
      console.warn(`[minigame] FLC ${key} 加载失败`, err);
      return null;
    }
  }

  /** 舞台像素 → 设备像素的倍率（整数倍最近邻、非整数倍平滑） */
  setZoom(scale: number): void {
    this.assets.setZoom(scale);
    const smooth = smoothingFor(scale).sprites;
    if (smooth === this.smooth) return;
    this.smooth = smooth;
    for (const s of this.imageSources) {
      if (s.destroyed) continue;
      s.style.scaleMode = smooth ? 'linear' : 'nearest';
      s.style.update();
    }
    for (const f of this.flcs) f.setSmooth(smooth);
  }

  get smoothing(): boolean {
    return this.smooth;
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    for (const f of this.flcs) f.destroy();
    this.flcs.length = 0;
    for (const t of this.extra) t.destroy(false);
    this.extra.length = 0;
    for (const { tex } of this.images.values()) tex.destroy(false);
    for (const s of this.imageSources) s.destroy();
    this.imageSources.length = 0;
    // 纹理源已销毁，借来的位图归还给素材包客户端（没有别的使用者时由它关闭）
    for (const { file } of this.images.values()) this.pack.releaseImage?.(file);
    this.images.clear();
    this.assets.destroy();
  }
}
