// 框架无关的渲染器（design/client.md §1.1、§3.3）：持有 Pixi Application、分层、动画时钟、镜头、手势、棋盘与纹理缓存。
// React 只在挂载点调用一次 create()，之后通过方法驱动；本文件不 import React。
// 原版皮肤 A5（original-skin.md §3 修正 7）：程序化渲染器经 `surface`（ProceduralSurface）实现 skin/BoardSurface，
// 对局页、小地图与测试钩子只经由接口访问棋盘。rotation / rotate 保留程序化口径 0..3（90° 一档，开发页与测试沿用），
// 接口上的 rotation 为统一口径 0..7（只用偶数值）。
import type { MapDef, TileId } from '@rich4/shared/data';
import { Application } from 'pixi.js';
import type { Anchor } from '../presentation/types';
import {
  type BoardSurface,
  type BoardSurfaceHooks,
  fromProceduralRotation,
  type SurfaceDoubleTapHandler,
  type SurfaceRotation,
  type SurfaceTapHandler,
} from '../skin/BoardSurface';
import { loadFontGlyphs } from '../ui/theme/fontFamilies';
import { AnimClock } from './anim/AnimClock';
import { type BoardLabels, BoardView } from './board/BoardView';
import { TILE_GLYPHS } from './board/tileStyles';
import { Camera, MAX_ZOOM, MIN_ZOOM } from './camera/Camera';
import { attachGestures } from './camera/gestures';
import { followHostSize } from './followHost';
import type { PickResult } from './iso/picking';
import { normRotation, type Pt, type Rotation } from './iso/projection';
import { createLayers, type Layers } from './layers';
import { CharacterAtlas, type CharacterFrames } from './procedural/character/atlas';
import { characterByKey } from './procedural/character/defs';
import { TextureCache } from './procedural/textureCache';

export type Quality = 'high' | 'mid' | 'low';

export interface QualityPreset {
  maxDpr: number;
  fps: number;
  antialias: boolean;
  groundResolution: number;
  /** 粒子上限（FxSystem 使用） */
  particles: number;
}

export const QUALITY_PRESETS: Readonly<Record<Quality, QualityPreset>> = {
  high: { maxDpr: 2, fps: 60, antialias: true, groundResolution: 2, particles: 400 },
  mid: { maxDpr: 1.5, fps: 60, antialias: true, groundResolution: 1.5, particles: 150 },
  low: { maxDpr: 1, fps: 30, antialias: false, groundResolution: 1, particles: 0 },
};

export const BOARD_BACKGROUND = 0x8fd3f4;

/** 程序化棋盘的缩放范围（等角格原始大小 = 1） */
export const PROCEDURAL_ZOOM = { min: MIN_ZOOM, max: MAX_ZOOM } as const;

/** 角色头顶飘字的高度（像素，与 BoardController 一致） */
const HEAD_Y = 92;

export interface GameRendererOptions {
  host: HTMLElement;
  quality?: Quality;
  labels?: BoardLabels;
  /** 轻点棋盘（未拖动） */
  onTap?: (pick: PickResult | null, screen: Pt) => void;
  /** 双击：例如回到当前玩家 */
  onDoubleTap?: (screen: Pt) => void;
  /** WebGL 上下文丢失 / 恢复通知（UI 显示「图形重建中…」） */
  onContextLost?: (lost: boolean) => void;
  /**
   * 外部动画时钟（对局页与 EventPlayer 共用一个时钟，由客户端服务驱动）；给出时渲染器不再推进它，
   * 缺省时渲染器自带时钟并在 ticker 里推进（开发页）。
   */
  clock?: AnimClock;
}

export class GameRenderer {
  readonly clock: AnimClock;
  private readonly ownsClock: boolean;
  readonly atlas = new CharacterAtlas(2);
  camera!: Camera;
  board!: BoardView;
  layers!: Layers;
  cache!: TextureCache;
  private detachGestures: (() => void) | null = null;
  private unfollowHost: (() => void) | null = null;
  private destroyed = false;
  private followSeat: number | null = null;
  private readonly quality: QualityPreset;
  /** 轻点 / 双击回调（可随时替换：BoardSurface.onTap / onDoubleTap） */
  tapHandler: GameRendererOptions['onTap'] | null;
  doubleTapHandler: GameRendererOptions['onDoubleTap'] | null;
  private surfaceObj: ProceduralSurface | null = null;
  private readonly onLost = (e: Event): void => {
    e.preventDefault();
    this.opts.onContextLost?.(true);
  };
  private readonly onRestored = (): void => {
    // Pixi 自己先恢复 GL 对象；下一帧再把程序化纹理内容重新渲染进同一批纹理对象，并重建地面缓存
    this.app.ticker.addOnce(() => {
      if (this.destroyed) return;
      this.cache.rebuildAll();
      if (this.board.loaded) this.board.refresh();
      this.opts.onContextLost?.(false);
    });
  };

  private constructor(
    readonly app: Application,
    private readonly opts: GameRendererOptions,
  ) {
    this.quality = QUALITY_PRESETS[opts.quality ?? 'high'];
    this.ownsClock = !opts.clock;
    this.clock = opts.clock ?? new AnimClock();
    this.tapHandler = opts.onTap ?? null;
    this.doubleTapHandler = opts.onDoubleTap ?? null;
  }

  /** 棋盘表面接口（skin/BoardSurface）的程序化实现 */
  get surface(): BoardSurface {
    this.surfaceObj ??= new ProceduralSurface(this);
    return this.surfaceObj;
  }

  /** 画质档的粒子上限（棋盘特效 FxSystem 按它设置预算） */
  get particleLimit(): number {
    return this.quality.particles;
  }

  /** 创建并挂载到 host（host 需要有尺寸；画布铺满 host） */
  static async create(opts: GameRendererOptions): Promise<GameRenderer> {
    const q = QUALITY_PRESETS[opts.quality ?? 'high'];
    const app = new Application();
    await app.init({
      resizeTo: opts.host,
      autoDensity: true,
      resolution: Math.min(globalThis.devicePixelRatio || 1, q.maxDpr),
      antialias: q.antialias,
      preference: 'webgl',
      powerPreference: 'high-performance',
      background: BOARD_BACKGROUND,
    });
    const r = new GameRenderer(app, opts);
    r.setup();
    return r;
  }

  private setup(): void {
    const { app, opts } = this;
    app.ticker.maxFPS = this.quality.fps;
    const canvas = app.canvas;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    opts.host.appendChild(canvas);
    this.layers = createLayers(app.stage);
    this.cache = new TextureCache(app.renderer, 2);
    this.camera = new Camera(this.layers.world, { w: app.screen.width, h: app.screen.height }, this.clock, {
      minZoom: PROCEDURAL_ZOOM.min,
      maxZoom: PROCEDURAL_ZOOM.max,
      relaxMinToFit: true,
    });
    this.board = new BoardView(this.layers, this.cache, this.clock, opts.labels ?? {}, {
      cacheChunks: true,
      resolution: this.quality.groundResolution,
      chunkCells: 12,
    });
    app.renderer.on('resize', (w: number, h: number) => this.camera.setViewport(w, h));
    // resizeTo 只跟 window 'resize'：宿主尺寸晚一步变化时画布会停在旧尺寸，另外观察宿主（见 followHost）
    this.unfollowHost = followHostSize(app, opts.host);
    app.ticker.add((t) => {
      const dt = Math.min(100, t.deltaMS);
      if (this.ownsClock) this.clock.advance(dt);
      this.camera.update(dt);
    });
    this.detachGestures = attachGestures(canvas, this.camera, {
      onTap: (screen) => this.tapHandler?.(this.pickScreen(screen), screen),
      onDoubleTap: (screen) => this.doubleTapHandler?.(screen),
    });
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  /** 预载棋盘字形分片后加载地图；镜头适配全图 */
  async loadMap(def: MapDef, rotation: Rotation = this.board.rotation): Promise<void> {
    await loadFontGlyphs(`${TILE_GLYPHS}0123456789出售招商商场研究所加油医院监狱银行百货保险`);
    if (this.destroyed) return;
    this.board.load(def, rotation);
    this.camera.setBounds(this.board.bounds());
    await this.camera.fitAll(0);
  }

  get rotation(): Rotation {
    return this.board.rotation;
  }

  /** 旋转 90°×delta，镜头保持对准同一逻辑点 */
  rotate(delta: number): Rotation {
    if (!this.board.loaded) return this.board.rotation;
    const focus = this.board.screenToLogical(this.camera.center);
    this.board.setRotation(normRotation(this.board.rotation + delta));
    this.camera.setBounds(this.board.bounds());
    this.camera.lookAt(this.board.logicalToScreen(focus));
    return this.board.rotation;
  }

  setSpeed(speed: number): void {
    this.clock.speed = speed;
  }

  setInstant(on: boolean): void {
    this.clock.instant = on;
  }

  /** 画布坐标 → world 本地像素 → 拾取 */
  pickScreen(screen: Pt): PickResult | null {
    if (!this.board.loaded) return null;
    return this.board.pick(this.camera.screenToWorld(screen));
  }

  /** 锚点的 world 坐标（座位 / 格 / 地块；lift 时按对象高度抬高，用于飘字） */
  anchorPos(at: Anchor, lift = false): Pt | null {
    if (!this.board?.loaded) return null;
    if ('seat' in at) {
      const a = this.board.actor(at.seat);
      if (!a) return null;
      const p = a.screenPos();
      return { x: p.x, y: p.y - (lift ? HEAD_Y : 30) };
    }
    if ('tile' in at) {
      try {
        const p = this.board.tileScreenPos(at.tile);
        return { x: p.x, y: p.y - (lift ? 40 : 0) };
      } catch {
        return null;
      }
    }
    const p = this.board.lotScreenPos(at.lot);
    if (!p) return null;
    const h = this.board.footprint(at.lot)?.heightPx ?? 0;
    return { x: p.x, y: p.y - (lift ? Math.max(40, h) : 0) };
  }

  /** 格中心的画布坐标 */
  tileCanvasPos(id: TileId): Pt | null {
    if (!this.board?.loaded) return null;
    try {
      return this.camera.worldToScreen(this.board.tileScreenPos(id));
    } catch {
      return null;
    }
  }

  /** 画布四角的 world 坐标（小地图视口框） */
  viewportCorners(): Pt[] | null {
    if (this.destroyed || !this.board?.loaded) return null;
    const { width: w, height: h } = this.app.screen;
    return [
      this.camera.screenToWorld({ x: 0, y: 0 }),
      this.camera.screenToWorld({ x: w, y: 0 }),
      this.camera.screenToWorld({ x: w, y: h }),
      this.camera.screenToWorld({ x: 0, y: h }),
    ];
  }

  /** 镜头跟随某座位的角色（null 取消） */
  follow(seat: number | null): void {
    this.followSeat = seat;
    if (seat === null) {
      this.camera.follow(null);
      return;
    }
    this.camera.follow(() => {
      const a = this.followSeat === null ? undefined : this.board.actor(this.followSeat);
      if (!a) return this.camera.center;
      const p = a.screenPos();
      return { x: p.x, y: p.y - 40 };
    });
  }

  /** 栅格化角色帧（按需、缓存） */
  loadCharacter(key: string): Promise<CharacterFrames> {
    return this.atlas.load(characterByKey(key));
  }

  /** 场景对象计数（冒烟测试与调试面板用） */
  sceneStats(): { objects: number; marks: number; ground: number; textures: number } {
    return {
      objects: this.layers.objects.children.length,
      marks: this.layers.marks.children.length,
      ground: this.layers.ground.children.length,
      textures: this.cache.size,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.detachGestures?.();
    this.detachGestures = null;
    this.unfollowHost?.();
    this.unfollowHost = null;
    const canvas = this.app.canvas;
    if (!this.ownsClock) this.camera.follow(null);
    // 共享时钟上可能还有镜头补间（没带 signal 的 zoomTo 等）：先让镜头失效，再销毁 world
    this.camera.dispose();
    canvas.removeEventListener('webglcontextlost', this.onLost);
    canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (this.ownsClock) this.clock.flushAll();
    this.board.destroy();
    void this.atlas.destroy();
    this.cache.clear();
    this.app.destroy({ removeView: true }, { children: true });
  }
}

/** 程序化渲染器的 BoardSurface 门面：旋转换算到统一口径 0..7（偶数），其余直接委托 GameRenderer */
class ProceduralSurface implements BoardSurface {
  readonly kind = 'procedural' as const;
  readonly rotationStep = 2 as const;

  constructor(private readonly r: GameRenderer) {}

  get camera(): Camera {
    return this.r.camera;
  }

  get loaded(): boolean {
    return this.r.board?.loaded === true;
  }

  get rotation(): SurfaceRotation {
    return fromProceduralRotation(this.r.rotation);
  }

  rotate(steps: number): SurfaceRotation {
    return fromProceduralRotation(this.r.rotate(steps));
  }

  loadMap(def: MapDef): Promise<void> {
    return this.r.loadMap(def);
  }

  anchorPos(at: Anchor, lift?: boolean): Pt | null {
    return this.r.anchorPos(at, lift);
  }

  viewportCorners(): Pt[] | null {
    return this.r.viewportCorners();
  }

  tileCanvasPos(id: TileId): Pt | null {
    return this.r.tileCanvasPos(id);
  }

  viewportSize(): { w: number; h: number } {
    return { w: this.r.app.screen.width, h: this.r.app.screen.height };
  }

  get onTap(): SurfaceTapHandler | null {
    // 程序化的命中结果（PickResult）是 SurfacePick 的超集
    return (this.r.tapHandler ?? null) as SurfaceTapHandler | null;
  }

  set onTap(fn: SurfaceTapHandler | null) {
    this.r.tapHandler = fn;
  }

  get onDoubleTap(): SurfaceDoubleTapHandler | null {
    return this.r.doubleTapHandler ?? null;
  }

  set onDoubleTap(fn: SurfaceDoubleTapHandler | null) {
    this.r.doubleTapHandler = fn;
  }

  get board(): BoardSurfaceHooks {
    return this.r.board;
  }

  /** 程序化渲染器本体（开发页与程序化专用代码用） */
  get renderer(): GameRenderer {
    return this.r;
  }

  destroy(): void {
    this.r.destroy();
  }
}
