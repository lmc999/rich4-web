// 原版棋盘的素材（design-draft §3.1、§3.3）：按逻辑键从素材包取精灵库（图集 JSON + 页位图 + 主人色掩膜页），
// 建成 Pixi 纹理；地面切块；缩放档（nearest / linear + mipmap）切换；建筑精灵的 alpha 命中测试。
// 条目级回退：条目缺失、所属组失败或置信度 guess → sheet() 得到 null，调用方走程序化外观。
import type { AssetEntry, AtlasV1, FlicEntry, PackManifestV1, SpriteEntry } from '@rich4/shared/assets';
import { ImageSource, Rectangle, Texture, type TextureSource } from 'pixi.js';
import type { FlcFile } from '../../skin/flic/FlcDecoder';

export type PackBitmap = ImageBitmap | HTMLImageElement;

/** 原版渲染器用到的素材包能力（skin/pack/PackClient 满足；测试可换替身） */
export interface OrigPackSource {
  readonly manifest: PackManifestV1 | null;
  usableEntry(key: string, opts?: { allowGuess?: boolean }): AssetEntry | null;
  loadAtlas(logicalPath: string, signal?: AbortSignal): Promise<AtlasV1>;
  loadImage(logicalPath: string, signal?: AbortSignal): Promise<PackBitmap>;
  /** 归还 loadImage 取得的位图（与 loadImage 一一配对；最后一个使用者归还时素材包客户端关闭位图） */
  releaseImage?(logicalPath: string): void;
  loadFlic?(key: string, signal?: AbortSignal): Promise<{ entry: FlicEntry; flc: FlcFile }>;
  /** 映射表数据（原版舞台读 data.flic-map） */
  loadData?(key: string, signal?: AbortSignal): Promise<unknown>;
}

/** 一个精灵库（逻辑键对应的全部帧） */
export interface SpriteSheet {
  key: string;
  entry: SpriteEntry;
  dirs: 1 | 8;
  count: number;
  frames: Texture[];
  /** 每帧锚点（整数像素）：落点 = 画点 − 锚点 */
  anchors: [number, number][];
  /** 主人色掩膜（与 frames 同布局）；没有为 null */
  masks: Texture[] | null;
  /** 帧 i 的局部像素 (lx, ly) 是否不透明（alpha 命中；首次调用时读取页位图） */
  hit(frame: number, lx: number, ly: number): boolean;
}

interface PageData {
  source: TextureSource;
  bitmap: PackBitmap;
  alpha: Uint8Array | null;
  w: number;
  h: number;
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

function canvas2d(w: number, h: number): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h).getContext('2d');
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c.getContext('2d');
}

/**
 * 灰度掩膜 → 白色 RGBA（alpha = 灰度值，按预乘存）。extract 输出的掩膜页是不带 alpha 的 8 位灰度 PNG；
 * 画布或 createImageBitmap 不可用时原样返回（掩膜按不透明处理，调用方可以不画掩膜）。
 */
export async function grayToAlpha(bmp: PackBitmap): Promise<PackBitmap> {
  const w = bmp.width;
  const h = bmp.height;
  const ctx = canvas2d(w, h);
  if (!ctx || typeof createImageBitmap !== 'function') return bmp;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  // 写成「预乘后的白色」（RGB = A = 灰度）：Pixi 按预乘 alpha 混合，未预乘的 RGB=255、A=0 会把 tint 叠成一整块色
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i]!;
    d[i] = a;
    d[i + 1] = a;
    d[i + 2] = a;
    d[i + 3] = a;
  }
  return createImageBitmap(img);
}

/** 读位图的 alpha 通道（OffscreenCanvas 或 DOM 画布；不可用时返回 null → 按包围盒命中） */
function readAlpha(bmp: PackBitmap, w: number, h: number): Uint8Array | null {
  try {
    const ctx = canvas2d(w, h);
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const a = new Uint8Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3]!;
    return a;
  } catch {
    return null;
  }
}

export class OrigAssets {
  private readonly sheets = new Map<string, Promise<SpriteSheet | null>>();
  private readonly ready = new Map<string, SpriteSheet | null>();
  private readonly pages = new Map<string, Promise<PageData>>();
  private readonly spriteSources = new Set<TextureSource>();
  private readonly groundSources = new Set<TextureSource>();
  private readonly textures: Texture[] = [];
  /** 本类自己生成的位图（掩膜转换结果），销毁时释放 */
  private readonly ownedBitmaps: PackBitmap[] = [];
  /** 向素材包客户端借的位图（逻辑路径）：销毁时逐个归还，离开对局后地面、建筑、角色图集页不再常驻内存 */
  private readonly borrowed = new Set<string>();
  private pathToLogical: Map<string, string> | null = null;
  private smooth = false;
  private groundSmooth = false;
  private dead = false;

  constructor(readonly pack: OrigPackSource) {}

  get manifest(): PackManifestV1 | null {
    return this.pack.manifest;
  }

  /** 条目是否可用（存在、组未失败、非 guess） */
  usable(key: string): boolean {
    const e = this.pack.usableEntry(key);
    return e?.type === 'sprite';
  }

  /** 已加载的精灵库（同步；未加载或不可用为 null，未加载时同时触发加载） */
  sheetNow(key: string): SpriteSheet | null {
    if (this.ready.has(key)) return this.ready.get(key) ?? null;
    void this.sheet(key);
    return null;
  }

  /** 是否已经有结论（加载完成或确定不可用） */
  settled(key: string): boolean {
    return this.ready.has(key);
  }

  /** 精灵库（缓存）；条目不可用或加载失败为 null */
  sheet(key: string, signal?: AbortSignal): Promise<SpriteSheet | null> {
    let p = this.sheets.get(key);
    if (!p) {
      p = this.loadSheet(key, signal).then(
        (s) => {
          this.ready.set(key, s);
          return s;
        },
        (e: unknown) => {
          if (this.dead) return null;
          console.warn(`[orig] 精灵 ${key} 加载失败，回退程序化`, e);
          this.ready.set(key, null);
          return null;
        },
      );
      this.sheets.set(key, p);
    }
    return p;
  }

  private logicalOfPath(actual: string): string | null {
    const m = this.pack.manifest;
    if (!m) return null;
    if (!this.pathToLogical) {
      this.pathToLogical = new Map();
      for (const [lp, f] of Object.entries(m.files)) this.pathToLogical.set(f.path, lp);
    }
    return this.pathToLogical.get(actual) ?? null;
  }

  /** 图集页位图（与图集 JSON 同目录的带哈希文件名）→ 逻辑路径 */
  private pageLogical(atlasLogical: string, image: string): string {
    const m = this.pack.manifest;
    const f = m && Object.hasOwn(m.files, atlasLogical) ? m.files[atlasLogical] : undefined;
    if (!f) throw new Error(`素材包中没有图集 ${atlasLogical}`);
    const lp = this.logicalOfPath(dirOf(f.path) + image);
    if (!lp) throw new Error(`图集 ${atlasLogical} 的页 ${image} 不在素材包中`);
    return lp;
  }

  private page(logical: string, kind: 'sprite' | 'ground' | 'mask', signal?: AbortSignal): Promise<PageData> {
    if (this.dead) return Promise.reject(new Error(`[orig] 素材已释放：${logical}`));
    let p = this.pages.get(logical);
    if (!p) {
      p = this.pack.loadImage(logical, signal).then(async (loaded) => {
        // 成功借到的位图才需要归还；已经销毁就立刻归还，不再建纹理源
        if (this.dead) {
          this.pack.releaseImage?.(logical);
          throw new Error(`[orig] 素材已释放：${logical}`);
        }
        this.borrowed.add(logical);
        // 主人色掩膜页是 8 位灰度（白 = 调色板 255 的像素）：转成「白色 + alpha = 灰度」，才能按 tint 着色
        const bitmap = kind === 'mask' ? await grayToAlpha(loaded) : loaded;
        if (bitmap !== loaded) {
          if (this.dead) {
            if ('close' in bitmap) bitmap.close();
            throw new Error(`[orig] 素材已释放：${logical}`);
          }
          this.ownedBitmaps.push(bitmap);
          // 灰度原图转换后就用不到了：马上归还
          if (this.borrowed.delete(logical)) this.pack.releaseImage?.(logical);
        }
        const w = bitmap.width;
        const h = bitmap.height;
        const ground = kind === 'ground';
        const source = new ImageSource({
          resource: bitmap,
          scaleMode: ground ? (this.groundSmooth ? 'linear' : 'nearest') : this.smooth ? 'linear' : 'nearest',
          autoGenerateMipmaps: ground,
          label: logical,
        });
        (ground ? this.groundSources : this.spriteSources).add(source);
        return { source, bitmap, alpha: null, w, h };
      });
      this.pages.set(logical, p);
      p.catch(() => {
        if (this.pages.get(logical) === p) this.pages.delete(logical);
      });
    }
    return p;
  }

  private async loadSheet(key: string, signal?: AbortSignal): Promise<SpriteSheet | null> {
    const e = this.pack.usableEntry(key);
    if (e?.type !== 'sprite') return null;
    const atlases = await Promise.all(
      e.atlas.map(async (lp) => ({ lp, atlas: await this.pack.loadAtlas(lp, signal) })),
    );
    const pages = await Promise.all(
      atlases.map(async ({ lp, atlas }) => {
        const main = await this.page(this.pageLogical(lp, atlas.meta.image), 'sprite', signal);
        const maskName = e.ownerMask ? atlas.meta.r4.mask : null;
        const mask = maskName ? await this.page(this.pageLogical(lp, maskName), 'mask', signal) : null;
        return { atlas, main, mask };
      }),
    );
    if (this.dead) return null;
    const frames: Texture[] = [];
    const masks: Texture[] = [];
    const anchors: [number, number][] = [];
    const frameInfo: { page: PageData; x: number; y: number; w: number; h: number }[] = [];
    let hasMask = e.ownerMask;
    for (let i = 0; i < e.frames.count; i++) {
      const name = `${e.frames.base}/${e.frames.start + i}`;
      const pg = pages.find((p) => Object.hasOwn(p.atlas.frames, name));
      if (!pg) throw new Error(`${key}: 图集缺少帧 ${name}`);
      const f = pg.atlas.frames[name]!;
      const r = new Rectangle(f.frame.x, f.frame.y, f.frame.w, f.frame.h);
      const tex = new Texture({ source: pg.main.source, frame: r, label: name });
      frames.push(tex);
      this.textures.push(tex);
      frameInfo.push({ page: pg.main, x: f.frame.x, y: f.frame.y, w: f.frame.w, h: f.frame.h });
      if (e.anchor === 'center') anchors.push([f.frame.w >> 1, f.frame.h >> 1]);
      else {
        const px = pg.atlas.meta.r4.anchorsPx[name];
        anchors.push(px ? [px[0], px[1]] : [Math.round(f.anchor.x * f.frame.w), Math.round(f.anchor.y * f.frame.h)]);
      }
      if (pg.mask) {
        const mt = new Texture({ source: pg.mask.source, frame: r.clone(), label: `${name}#mask` });
        masks.push(mt);
        this.textures.push(mt);
      } else hasMask = false;
    }
    return {
      key,
      entry: e,
      dirs: e.dirs,
      count: e.frames.count,
      frames,
      anchors,
      masks: hasMask && masks.length === frames.length ? masks : null,
      hit: (frame, lx, ly) => {
        const fi = frameInfo[frame];
        if (!fi || lx < 0 || ly < 0 || lx >= fi.w || ly >= fi.h) return false;
        const pg = fi.page;
        pg.alpha ??= readAlpha(pg.bitmap, pg.w, pg.h);
        if (!pg.alpha) return true;
        return pg.alpha[(fi.y + ly) * pg.w + fi.x + lx]! > 0;
      },
    };
  }

  /** 地面切块纹理（按切块顺序）；地面源开 mipmap（缩放 < 1 时 linear + mipmap） */
  async ground(files: readonly string[], signal?: AbortSignal): Promise<Texture[]> {
    const pages = await Promise.all(files.map((f) => this.page(f, 'ground', signal)));
    return pages.map((p) => {
      const t = new Texture({ source: p.source, label: 'ground' });
      this.textures.push(t);
      return t;
    });
  }

  /**
   * 缩放档：精灵在非整数倍缩放时平滑（原版像素整数倍最近邻、非整数倍平滑）；地面在缩放 < 1 时 linear + mipmap，
   * 其余最近邻（与原版扫描线贴图的观感一致）。scale 是源像素到设备像素的有效倍率（镜头缩放 × 画布分辨率）。
   */
  setZoom(scale: number): void {
    const { sprites: spriteSmooth, ground: groundSmooth } = smoothingFor(scale);
    if (spriteSmooth !== this.smooth) {
      this.smooth = spriteSmooth;
      for (const s of this.spriteSources) setScale(s, spriteSmooth ? 'linear' : 'nearest');
    }
    if (groundSmooth !== this.groundSmooth) {
      this.groundSmooth = groundSmooth;
      for (const s of this.groundSources) setScale(s, groundSmooth ? 'linear' : 'nearest');
    }
  }

  get smoothing(): { sprites: boolean; ground: boolean } {
    return { sprites: this.smooth, ground: this.groundSmooth };
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    for (const t of this.textures) t.destroy(false);
    this.textures.length = 0;
    for (const s of [...this.spriteSources, ...this.groundSources]) s.destroy();
    this.spriteSources.clear();
    this.groundSources.clear();
    for (const b of this.ownedBitmaps) if ('close' in b) b.close();
    this.ownedBitmaps.length = 0;
    // 纹理源已销毁，借来的位图归还给素材包客户端（没有别的使用者时由它关闭并移出缓存）
    for (const lp of this.borrowed) this.pack.releaseImage?.(lp);
    this.borrowed.clear();
    this.sheets.clear();
    this.ready.clear();
    this.pages.clear();
  }
}

/** 有效倍率（源像素 → 设备像素）下的平滑档：精灵非整数倍或 < 1 时平滑；地面 < 1 时 linear + mipmap */
export function smoothingFor(scale: number): { sprites: boolean; ground: boolean } {
  return {
    sprites: Math.abs(scale - Math.round(scale)) > 1e-3 || scale < 1 - 1e-3,
    ground: scale < 1 - 1e-3,
  };
}

function setScale(s: TextureSource, mode: 'linear' | 'nearest'): void {
  if (s.destroyed) return;
  s.style.scaleMode = mode;
  s.style.update();
}
