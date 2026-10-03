// 原版棋盘渲染器（original-skin.md §5 A6/A7；design-draft §3.2–§3.3）：实现 skin/BoardSurface，与程序化 GameRenderer 同形
// （camera 门面、rotation 0..7、rotate、anchorPos、loadMap、onTap / onDoubleTap、destroy、测试钩子 board.*）。
// - 世界容器的本地坐标 = 棋盘坐标（源像素）：Camera 以源像素为单位缩放，镜头平移按源像素取整（SnappedWorld）；
// - 缺省缩放：让视窗显示约原版 440×440 源像素（经典舞台的棋盘视窗里正好 1:1），范围 [0.5, 4]，可缩到看全图；
// - 8 视角：rotate(±1) 每档 45°，镜头保持对准同一个世界点；地面换仿射、建筑与棋子重选帧、深度重排；
// - 热键 < >（经典外壳已处理时让给它：按 defaultPrevented 判断）；
// - 载入地图后登记原版小地图（game/minimap/OrigMiniMap）。
import { type MapSkinV1, roadObjectFrame } from '@rich4/shared/assets';
import type { MapDef, TileId } from '@rich4/shared/data';
import { Application, Container, type ImageSource, Sprite } from 'pixi.js';
import type { Anchor } from '../../presentation/types';
import type {
  BoardActorHook,
  BoardSurface,
  BoardSurfaceHooks,
  SurfaceDoubleTapHandler,
  SurfacePick,
  SurfaceRotation,
  SurfaceTapHandler,
} from '../../skin/BoardSurface';
import { AnimClock } from '../anim/AnimClock';
import { Camera, type Transformable } from '../camera/Camera';
import { attachGestures } from '../camera/gestures';
import { followHostSize } from '../followHost';
import { QUALITY_PRESETS, type Quality } from '../GameRenderer';
import type { Pt } from '../iso/projection';
import { createLayers, type Layers } from '../layers';
import { registerOrigMiniMap } from '../minimap/OrigMiniMap';
import { OrigLayer } from './depth';
import { ORIG_SEAT_OFFSETS, ORIG_TAG_GAP, OrigActor } from './OrigActor';
import { OrigAssets, type OrigPackSource } from './OrigAssets';
import { OrigBoardView, type OwnerStyle } from './OrigBoardView';
import { OrigProjection } from './OrigProjection';
import { OrigRoads } from './OrigRoads';
import { OrigPickIndex } from './picking';

/** 原版棋盘的缩放范围（源像素倍数） */
export const ORIG_ZOOM = { min: 0.5, max: 4 } as const;
/** 原版棋盘视窗边长（源像素） */
export const ORIG_VIEWPORT_PX = 440;
export const ORIG_BACKGROUND = 0x000000;

/** 缺省缩放：视窗较短边显示约 440 源像素（夹在 [1, 3]；接近整数时取整数，像素更清楚） */
export function defaultOrigZoom(w: number, h: number): number {
  const z = Math.min(3, Math.max(1, Math.min(w, h) / ORIG_VIEWPORT_PX));
  const r = Math.round(z);
  return Math.abs(z - r) < 0.08 ? r : Math.round(z * 100) / 100;
}

/**
 * 镜头目标：把 world 容器的位置取整到「源像素 × 缩放」的格点上（镜头平移按源像素取整，
 * 精灵与地面在同一个源像素格上，像素不抖）
 */
class SnappedWorld implements Transformable {
  readonly position: Transformable['position'];
  readonly scale: Transformable['scale'];

  constructor(target: Container) {
    this.scale = target.scale;
    this.position = {
      get x() {
        return target.position.x;
      },
      get y() {
        return target.position.y;
      },
      set(x: number, y?: number) {
        const z = target.scale.x || 1;
        const yy = y ?? x;
        target.position.set(Math.round(x / z) * z, Math.round(yy / z) * z);
      },
    };
  }
}

export interface OrigRendererOptions {
  host: HTMLElement;
  pack: OrigPackSource;
  skin: MapSkinV1;
  quality?: Quality;
  /** 外部动画时钟（对局页与 EventPlayer 共用）；缺省自带并在 ticker 里推进 */
  clock?: AnimClock;
  onTap?: SurfaceTapHandler;
  onDoubleTap?: SurfaceDoubleTapHandler;
  onContextLost?(lost: boolean): void;
  /** 热键 < > 旋转视角（缺省开） */
  hotkeys?: boolean;
  /** 恶人名牌等棋盘内文字 */
  label?(key: string): string | undefined;
}

export class OrigRenderer implements BoardSurface {
  readonly kind = 'original' as const;
  readonly rotationStep = 1 as const;
  readonly clock: AnimClock;
  readonly proj: OrigProjection;
  readonly assets: OrigAssets;
  readonly skin: MapSkinV1;
  camera!: Camera;
  layers!: Layers;
  boardView: OrigBoardView | null = null;
  roads: OrigRoads | null = null;
  onTap: SurfaceTapHandler | null;
  onDoubleTap: SurfaceDoubleTapHandler | null;
  /** 旋转后（热键、按钮）通知 */
  onRotated: ((r: SurfaceRotation) => void) | null = null;
  private readonly ownsClock: boolean;
  private readonly quality: (typeof QUALITY_PRESETS)[Quality];
  private readonly actors = new Map<number, OrigActor>();
  /** 演出用的临时棋子（机器娃娃）：换视角时一起重排 */
  private readonly extras = new Set<OrigActor>();
  private readonly destroyHooks: (() => void)[] = [];
  /** 按锚点世界坐标登记的演出节点（原版 FLIC）：换视角时重新投影 */
  private readonly pins = new Map<Container, { world: Pt; dx: number; dy: number }>();
  private def: MapDef | null = null;
  private pickIndex: OrigPickIndex | null = null;
  private boatTiles: ReadonlySet<TileId> = new Set();
  private detachGestures: (() => void) | null = null;
  private unfollowHost: (() => void) | null = null;
  private unregisterMini: (() => void) | null = null;
  private followSeat: number | null = null;
  private lastZoom = -1;
  private autoZoom: number | null = null;
  private destroyed = false;
  /** 地图载入完成（地面、精灵、拾取索引、路面层都已就绪） */
  private mapReady = false;
  /** 座位 → 角色号与代表色（控制器按显示态设置） */
  owners: OwnerStyle = { character: () => null, color: () => 0xffffff };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const dir = e.key === '<' || e.key === ',' ? -1 : e.key === '>' || e.key === '.' ? 1 : 0;
    if (dir === 0 || !this.loaded) return;
    const el = e.target instanceof Element ? e.target : null;
    if (el && (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName) || (el as HTMLElement).isContentEditable)) return;
    if (el?.closest('[role="dialog"], [role="alertdialog"]')) return;
    e.preventDefault();
    this.onRotated?.(this.rotate(dir));
  };
  private readonly onLost = (e: Event): void => {
    e.preventDefault();
    this.opts.onContextLost?.(true);
  };
  private readonly onRestored = (): void => {
    // 纹理来自位图（ImageSource），Pixi 恢复上下文时自动重新上传
    this.app.ticker.addOnce(() => {
      if (!this.destroyed) this.opts.onContextLost?.(false);
    });
  };

  private constructor(
    readonly app: Application,
    private readonly opts: OrigRendererOptions,
  ) {
    this.quality = QUALITY_PRESETS[opts.quality ?? 'high'];
    this.ownsClock = !opts.clock;
    this.clock = opts.clock ?? new AnimClock();
    this.skin = opts.skin;
    this.proj = OrigProjection.fromSkin(opts.skin);
    this.assets = new OrigAssets(opts.pack);
    this.onTap = opts.onTap ?? null;
    this.onDoubleTap = opts.onDoubleTap ?? null;
  }

  /** 创建并挂载到 host（画布铺满 host） */
  static async create(opts: OrigRendererOptions): Promise<OrigRenderer> {
    const q = QUALITY_PRESETS[opts.quality ?? 'high'];
    const app = new Application();
    await app.init({
      resizeTo: opts.host,
      autoDensity: true,
      resolution: Math.min(globalThis.devicePixelRatio || 1, q.maxDpr),
      antialias: false,
      roundPixels: true,
      preference: 'webgl',
      powerPreference: 'high-performance',
      background: ORIG_BACKGROUND,
    });
    const r = new OrigRenderer(app, opts);
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
    canvas.dataset.skin = 'original';
    opts.host.appendChild(canvas);
    this.layers = createLayers(app.stage);
    this.camera = new Camera(
      new SnappedWorld(this.layers.world),
      { w: app.screen.width, h: app.screen.height },
      this.clock,
      { minZoom: ORIG_ZOOM.min, maxZoom: ORIG_ZOOM.max, relaxMinToFit: true },
    );
    app.renderer.on('resize', (w: number, h: number) => {
      this.camera.setViewport(w, h);
      // 用户没有手动缩放过：跟着视窗调整缺省缩放
      if (this.autoZoom !== null && Math.abs(this.camera.zoom - this.autoZoom) < 1e-6) {
        const ev = this.camera.effectiveViewport();
        this.autoZoom = defaultOrigZoom(ev.w, ev.h);
        this.camera.setZoom(this.autoZoom);
      }
    });
    // resizeTo 只跟 window 'resize'：宿主尺寸晚一步变化时画布会停在旧尺寸，另外观察宿主（见 followHost）
    this.unfollowHost = followHostSize(app, opts.host);
    app.ticker.add((t) => {
      const dt = Math.min(100, t.deltaMS);
      if (this.ownsClock) this.clock.advance(dt);
      this.camera.update(dt);
      // 平滑与否按「源像素 → 设备像素」的有效倍率判断（镜头缩放 × 画布分辨率）：DPR 1.25 / 1.5 时镜头缩放 1、2
      // 并不是整数倍，最近邻会把源像素画成宽窄不一的列
      const z = this.camera.zoom * this.app.renderer.resolution;
      if (z !== this.lastZoom) {
        this.lastZoom = z;
        this.assets.setZoom(z);
      }
    });
    this.detachGestures = attachGestures(canvas, this.camera, {
      onTap: (screen) => this.onTap?.(this.pickScreen(screen), screen),
      onDoubleTap: (screen) => this.onDoubleTap?.(screen),
    });
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    if (opts.hotkeys !== false && typeof window !== 'undefined') window.addEventListener('keydown', this.onKey);
  }

  // ───────────────────────── BoardSurface ─────────────────────────

  get loaded(): boolean {
    return this.mapReady && this.boardView !== null;
  }

  get rotation(): SurfaceRotation {
    return this.proj.view;
  }

  get mapDef(): MapDef | null {
    return this.def;
  }

  /** 载入地图：地面、棋盘精灵（地图组 + 通用组）、拾取索引；缺省缩放并对准地图中心；登记原版小地图 */
  async loadMap(def: MapDef): Promise<void> {
    if (this.destroyed) return;
    this.unload();
    this.def = def;
    this.proj.view = this.skin.projection.initialView;
    this.boatTiles = new Set(this.skin.boatTiles);
    const view = new OrigBoardView({
      proj: this.proj,
      assets: this.assets,
      skin: this.skin,
      def,
      clock: this.clock,
      ground: this.layers.ground,
      marks: this.layers.marks,
      objects: this.layers.objects,
      owners: { character: (s) => this.owners.character(s), color: (s) => this.owners.color(s) },
    });
    this.boardView = view;
    try {
      await view.load();
    } catch (e) {
      if (this.boardView === view) {
        view.destroy();
        this.boardView = null;
        this.def = null;
      }
      throw e;
    }
    if (this.destroyed || this.boardView !== view) return;
    this.pickIndex = new OrigPickIndex(def);
    this.roads = new OrigRoads({
      proj: this.proj,
      assets: this.assets,
      clock: this.clock,
      objects: this.layers.objects,
      tileWorld: (id) => view.tileWorld(id),
      boatTiles: this.boatTiles,
      characterOf: (s) => this.owners.character(s),
      colorOf: (s) => this.owners.color(s),
      villainName: (k) => this.opts.label?.(`events:villain.${k}`),
    });
    this.camera.setBounds(this.proj.bounds());
    const ev = this.camera.effectiveViewport();
    this.autoZoom = defaultOrigZoom(ev.w, ev.h);
    this.camera.setZoom(this.autoZoom);
    this.camera.lookAt(this.proj.project({ x: this.skin.world.w / 2, y: this.skin.world.h / 2 }));
    this.mapReady = true;
    await this.registerMiniMap(def);
  }

  private async registerMiniMap(def: MapDef): Promise<void> {
    const mm = this.skin.minimap;
    const sheet = mm ? await this.assets.sheet(mm.sprite) : null;
    if (this.destroyed || this.def !== def) return;
    const frame = mm && sheet ? (sheet.frames[mm.large ?? mm.small] ?? sheet.frames[mm.small] ?? null) : null;
    const res = frame ? ((frame.source as ImageSource).resource as CanvasImageSource | null) : null;
    const image =
      frame && res
        ? { bitmap: res, sx: frame.frame.x, sy: frame.frame.y, sw: frame.frame.width, sh: frame.frame.height }
        : null;
    this.unregisterMini?.();
    this.unregisterMini = registerOrigMiniMap({
      def,
      world: this.skin.world,
      image,
      view: () => this.proj.view,
      toWorld: (p) => this.proj.unproject(p),
      toBoard: (p) => this.proj.project(p),
      tileWorld: (id) => this.boardView?.tileWorld(id) ?? null,
      lotWorld: (id) => this.boardView?.lotWorld(id as never) ?? null,
      seatColor: (s) => this.owners.color(s),
    });
  }

  /** 旋转 steps 档（每档 45°），镜头保持对准同一个世界点；返回新视角 */
  rotate(steps: number): SurfaceRotation {
    if (!this.loaded || !Number.isFinite(steps) || Math.trunc(steps) === 0) return this.proj.view;
    const focus = this.proj.unproject(this.camera.center);
    this.proj.rotate(steps);
    this.relayout();
    this.camera.setBounds(this.proj.bounds());
    this.camera.lookAt(this.proj.project(focus));
    return this.proj.view;
  }

  /** 设视角（测试与开发页） */
  setView(v: number): SurfaceRotation {
    const d = (((v - this.proj.view) % 8) + 8) % 8;
    return d === 0 ? this.proj.view : this.rotate(d);
  }

  private relayout(): void {
    this.boardView?.relayout();
    this.roads?.relayout();
    for (const a of this.actors.values()) a.onViewChanged();
    for (const a of [...this.extras]) {
      if (a.destroyed) this.extras.delete(a);
      else a.onViewChanged();
    }
    for (const [node, pin] of [...this.pins]) {
      if (node.destroyed) {
        this.pins.delete(node);
        continue;
      }
      const p = this.proj.project(pin.world);
      node.position.set(Math.round(p.x + pin.dx), Math.round(p.y + pin.dy));
    }
  }

  /**
   * 演出节点（原版 FLIC 等）按锚点登记：at 为锚点的棋盘坐标，节点当前位置与它的差保持不变；换视角时按锚点的世界坐标
   * 重新投影（镜头也对准同一个世界点），节点不会留在旧视角的棋盘坐标上。返回注销函数（节点销毁后自动注销）
   */
  pinToBoard(node: Container, at: Pt): () => void {
    this.pins.set(node, { world: this.proj.unproject(at), dx: node.position.x - at.x, dy: node.position.y - at.y });
    return () => {
      this.pins.delete(node);
    };
  }

  anchorPos(at: Anchor, lift = false): Pt | null {
    const v = this.boardView;
    if (!v) return null;
    if ('seat' in at) {
      const a = this.actors.get(at.seat);
      if (!a) return null;
      const p = a.boardPos();
      return { x: p.x, y: p.y - (lift ? a.height + 8 : 16) };
    }
    if ('tile' in at) {
      const p = v.tilePos(at.tile);
      return p ? { x: p.x, y: p.y - (lift ? 20 : 0) } : null;
    }
    const p = v.lotPos(at.lot);
    if (!p) return null;
    return { x: p.x, y: p.y - (lift ? Math.max(20, v.lotHeight(at.lot)) : 0) };
  }

  viewportCorners(): Pt[] | null {
    if (this.destroyed || !this.loaded) return null;
    const { width: w, height: h } = this.app.screen;
    return [
      this.camera.screenToWorld({ x: 0, y: 0 }),
      this.camera.screenToWorld({ x: w, y: 0 }),
      this.camera.screenToWorld({ x: w, y: h }),
      this.camera.screenToWorld({ x: 0, y: h }),
    ];
  }

  tileCanvasPos(id: TileId): Pt | null {
    const p = this.boardView?.tilePos(id);
    return p ? this.camera.worldToScreen(p) : null;
  }

  viewportSize(): { w: number; h: number } {
    return { w: this.app.screen.width, h: this.app.screen.height };
  }

  /** 画布坐标 → 拾取（建筑 alpha → 最近节点 → 最近地块） */
  pickScreen(screen: Pt): SurfacePick | null {
    const v = this.boardView;
    if (!v || !this.pickIndex) return null;
    const board = this.camera.screenToWorld(screen);
    const world = this.proj.unproject(board);
    return this.pickIndex.pick(world, board, v.hitBoxes());
  }

  get board(): BoardSurfaceHooks {
    const actors = (): OrigActor[] => [...this.actors.values()];
    return {
      allActors: () => actors() as BoardActorHook[],
      actor: (seat) => this.actors.get(seat),
      roads: { counts: () => this.roads?.counts() ?? { objects: 0, gods: 0, beggars: 0, villains: 0 } },
    };
  }

  // ───────────────────────── 角色 ─────────────────────────

  addActor(seat: number, character: number, name: string, tile: TileId, color: number): OrigActor {
    this.removeActor(seat);
    const v = this.boardView!;
    const a = new OrigActor({
      seat,
      kind: { t: 'player', character },
      assets: this.assets,
      proj: this.proj,
      clock: this.clock,
      tileWorld: (id) => v.tileWorld(id),
      boatTiles: this.boatTiles,
      color,
      name,
    });
    a.flyLayer = this.layers.overlay;
    this.layers.objects.addChild(a.root);
    this.actors.set(seat, a);
    a.teleport(tile);
    // 冬眠 / 梦游的 ZZZ 出现或消失：同格多人的名牌按新的高度重排
    a.onClearanceChange = () => {
      if (!this.destroyed && this.actors.get(seat) === a) this.spreadActors();
    };
    return a;
  }

  actor(seat: number): OrigActor | undefined {
    return this.actors.get(seat);
  }

  allActors(): OrigActor[] {
    return [...this.actors.values()];
  }

  removeActor(seat: number): void {
    const a = this.actors.get(seat);
    if (!a) return;
    a.destroy();
    this.actors.delete(seat);
  }

  /** 机器娃娃（原版 npc.doll 站 / 走姿态；原版舞台的清道演出用，调用方负责 destroy） */
  spawnDoll(node: TileId): OrigActor | null {
    const v = this.boardView;
    if (!v || !this.loaded) return null;
    const a = new OrigActor({
      seat: 8,
      kind: { t: 'doll' },
      assets: this.assets,
      proj: this.proj,
      clock: this.clock,
      tileWorld: (id) => v.tileWorld(id),
      boatTiles: this.boatTiles,
      color: 0xbfc5cf,
      layer: OrigLayer.Npc,
    });
    this.layers.objects.addChild(a.root);
    a.teleport(node);
    for (const x of [...this.extras]) if (x.destroyed) this.extras.delete(x);
    this.extras.add(a);
    return a;
  }

  /** 原版物件精灵（8 向库取朝向 0 按当前视角的帧；锚点在原点）；精灵库未就绪或不可用为 null */
  objectSprite(key: string): Container | null {
    const sheet = this.assets.sheetNow(key);
    if (!sheet) return null;
    const f = sheet.dirs === 8 ? roadObjectFrame(0, this.proj.view) : 0;
    const tex = sheet.frames[f];
    if (!tex) return null;
    const [ax, ay] = sheet.anchors[f] ?? [0, 0];
    const c = new Container({ label: key });
    const spr = new Sprite(tex);
    spr.position.set(-ax, -ay);
    c.addChild(spr);
    return c;
  }

  /** 渲染器销毁时回调（控制器释放舞台与 FLIC 缓存） */
  onDestroy(fn: () => void): void {
    this.destroyHooks.push(fn);
  }

  /** 同格多人时按座位偏移 */
  spreadActors(): void {
    const byTile = new Map<TileId, OrigActor[]>();
    for (const a of this.actors.values()) {
      // 看不见本体的（在监狱 / 医院 / 旅馆里、出国、乞丐）不占格子，路过的人不为它错开（原版关押期间根本不画）
      if (a.tile === null || a.isWalking || !a.root.visible || a.offBoard) continue;
      const list = byTile.get(a.tile) ?? [];
      list.push(a);
      byTile.set(a.tile, list);
    }
    for (const a of this.actors.values()) {
      const list = a.tile === null ? undefined : byTile.get(a.tile);
      if (a.isWalking) continue;
      const shared = list !== undefined && list.length > 1 && list.includes(a);
      a.setOffset(shared ? (ORIG_SEAT_OFFSETS[a.seat % 4] ?? { x: 0, y: 0 }) : { x: 0, y: 0 });
      if (!shared) {
        a.setTagLift(0, null);
        continue;
      }
      // 名牌居中、按座位顺序在同一基线上逐个抬高：每层抬高前面各人的名牌高度 + 间隙，互不遮挡
      const order = [...list].sort((x, y) => x.seat - y.seat);
      let lift = 0;
      for (const x of order) {
        if (x === a) break;
        lift += x.tagHeight + ORIG_TAG_GAP;
      }
      a.setTagLift(lift, Math.max(...list.map((x) => x.tagClearance)));
    }
  }

  /** 镜头跟随座位（null 取消） */
  follow(seat: number | null): void {
    this.followSeat = seat;
    if (seat === null) {
      this.camera.follow(null);
      return;
    }
    this.camera.follow(() => {
      const a = this.followSeat === null ? undefined : this.actors.get(this.followSeat);
      if (!a?.root.visible) return this.camera.center;
      const p = a.boardPos();
      return { x: p.x, y: p.y - 16 };
    });
  }

  /** 统计（测试与调试） */
  sceneStats(): { objects: number; actors: number; view: number; zoom: number } & ReturnType<OrigBoardView['stats']> {
    const s = this.boardView?.stats() ?? { ground: 0, decor: 0, lots: 0, buildings: 0, scenery: 0, marks: 0 };
    return {
      ...s,
      objects: this.layers.objects.children.length,
      actors: this.actors.size,
      view: this.proj.view,
      zoom: this.camera.zoom,
    };
  }

  private unload(): void {
    this.mapReady = false;
    this.pins.clear();
    for (const seat of [...this.actors.keys()]) this.removeActor(seat);
    for (const a of this.extras) a.destroy();
    this.extras.clear();
    this.roads?.destroy();
    this.roads = null;
    this.boardView?.destroy();
    this.boardView = null;
    this.pickIndex = null;
    this.unregisterMini?.();
    this.unregisterMini = null;
    this.def = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const f of this.destroyHooks.splice(0)) {
      try {
        f();
      } catch (e) {
        console.warn('[orig] destroy hook failed', e);
      }
    }
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this.onKey);
    this.detachGestures?.();
    this.detachGestures = null;
    this.unfollowHost?.();
    this.unfollowHost = null;
    const canvas = this.app.canvas;
    if (!this.ownsClock) this.camera.follow(null);
    this.camera.dispose();
    canvas.removeEventListener('webglcontextlost', this.onLost);
    canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (this.ownsClock) this.clock.flushAll();
    this.unload();
    this.assets.destroy();
    this.app.destroy({ removeView: true }, { children: true });
  }
}
