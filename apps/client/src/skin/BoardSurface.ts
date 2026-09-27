// 棋盘表面抽象（original-skin.md §3 修正 7：完整接缝清单）。程序化渲染器（game/GameRenderer）与 A6 的原版渲染器
// （game/orig/OrigRenderer）实现同一个接口；对局页（GameScreen）、棋盘挂载点（BoardCanvas）、小地图（MiniMap）
// 与测试钩子（dev/testHooks）只经由它访问棋盘，不再直接碰 GameRenderer 的内部。
//
// - camera 门面：panTo、screenToWorld / worldToScreen、setInsets、zoomTo、fitAll、onUserGesture（缩放上下限由各渲染器决定）；
// - rotation：统一口径 0..7，每档 45°（view + 1 画面顺时针转 45°，与原版 θ = −22.5° + 45°·view 一致）。
//   程序化渲染器只有 4 个方向，只用偶数值 0/2/4/6（toProceduralRotation / fromProceduralRotation）；
//   rotate(steps) 按「本渲染器的一档」旋转（程序化一档 90°、原版一档 45°），返回新的统一口径值；
// - anchorPos：座位 / 格 / 地块的 world 坐标（镜头对准、飘字位置）；
// - loadMap、onTap / onDoubleTap（可随时替换）、destroy；
// - board：测试钩子（E2E 读 allActors / actor(seat) / roads.counts()，两种渲染器必须同形）。
// 本文件只含类型与纯函数，不引入 Pixi。
import type { LotId, MapDef, TileId } from '@rich4/shared/data';
import type { SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import type { AnimClock } from '../game/anim/AnimClock';
import type { Insets } from '../game/camera/Camera';
import type { Pt } from '../game/iso/projection';
import type { StagePort } from '../presentation/handlers/stage';
import type { Anchor, BoardPort } from '../presentation/types';
import type { SkinKind } from './types';

// ───────────────────────── 旋转口径 ─────────────────────────

/** 统一旋转口径：0..7，每档 45° */
export type SurfaceRotation = number;
export const SURFACE_VIEWS = 8;

export function normSurfaceRotation(r: number): SurfaceRotation {
  return ((Math.trunc(r) % SURFACE_VIEWS) + SURFACE_VIEWS) % SURFACE_VIEWS;
}

/** 统一口径 → 程序化渲染器的 0..3（90° 一档；奇数值向下取到相邻的偶数方向） */
export function toProceduralRotation(r: SurfaceRotation): 0 | 1 | 2 | 3 {
  return (normSurfaceRotation(r) >> 1) as 0 | 1 | 2 | 3;
}

/** 程序化 0..3 → 统一口径 0/2/4/6 */
export function fromProceduralRotation(r4: number): SurfaceRotation {
  return (((Math.trunc(r4) % 4) + 4) % 4) * 2;
}

// ───────────────────────── 镜头门面 ─────────────────────────

export interface BoardCamera {
  readonly zoom: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  /** 镜头对准的 world 点 */
  readonly center: Pt;
  /** 跟随是否因用户手势暂停中 */
  readonly followPaused: boolean;
  panTo(p: Pt, ms: number, signal?: AbortSignal): Promise<void>;
  zoomTo(z: number, ms: number, anchorScreen?: Pt, signal?: AbortSignal): Promise<void>;
  /** 缩放并居中，使全图落在有效可视区内 */
  fitAll(ms?: number): Promise<void>;
  screenToWorld(p: Pt): Pt;
  worldToScreen(p: Pt): Pt;
  /** 有效可视区（扣除 HUD insets）中心的画布坐标 */
  screenAnchor(): Pt;
  setInsets(i: Partial<Insets>): void;
  /** 手动拖动 / 缩放后暂停跟随 */
  onUserGesture(): void;
}

// ───────────────────────── 测试钩子（E2E 读取的形状） ─────────────────────────

export interface BoardActorHook {
  readonly seat: number;
  readonly tile: TileId | null;
  readonly isWalking: boolean;
  /** 显示对象根：visible 与子节点标签（头顶气泡 label 为 'speech'） */
  readonly root: { readonly visible: boolean; readonly children: readonly { readonly label?: string }[] };
  /** 状态外观（坐牢 / 住院 / 梦游……），结构由各渲染器的角色定义，E2E 读 confined.where */
  readonly currentStatus: unknown;
}

export interface BoardSurfaceHooks {
  allActors(): readonly BoardActorHook[];
  actor(seat: number): BoardActorHook | undefined;
  /** 路面物件、路上神明、乞丐、恶人的计数 */
  readonly roads: { counts(): { objects: number; gods: number; beggars: number; villains: number } };
}

// ───────────────────────── 棋盘表面 ─────────────────────────

/** 轻点 / 双击命中（程序化按等角格拾取；原版按世界坐标最近节点 / 地块） */
export interface SurfacePick {
  tile: TileId | null;
  lot: LotId | null;
}

export type SurfaceTapHandler = (pick: SurfacePick | null, screen: Pt) => void;
export type SurfaceDoubleTapHandler = (screen: Pt) => void;

export interface BoardSurface {
  readonly kind: SkinKind;
  readonly camera: BoardCamera;
  /** 地图已加载 */
  readonly loaded: boolean;
  /** 统一口径 0..7 */
  readonly rotation: SurfaceRotation;
  /** 本渲染器一档旋转等于几个 45°（程序化 2、原版 1） */
  readonly rotationStep: 1 | 2;
  /** 旋转 steps 档（±1 为本渲染器的一档），镜头保持对准同一个世界点；返回新的统一口径值 */
  rotate(steps: number): SurfaceRotation;
  loadMap(def: MapDef): Promise<void>;
  /** 座位 / 格 / 地块的 world 坐标；lift 时按对象高度抬高（飘字位置） */
  anchorPos(at: Anchor, lift?: boolean): Pt | null;
  /** 画布四角对应的 world 坐标（小地图视口框）；未就绪为 null */
  viewportCorners(): Pt[] | null;
  /** 格中心的画布坐标（测试钩子 tileScreenPos） */
  tileCanvasPos(id: TileId): Pt | null;
  /** 画布尺寸（CSS 像素） */
  viewportSize(): { w: number; h: number };
  onTap: SurfaceTapHandler | null;
  onDoubleTap: SurfaceDoubleTapHandler | null;
  /** 测试钩子 */
  readonly board: BoardSurfaceHooks;
  destroy(): void;
}

// ───────────────────────── 控制器（演出端口 + 对局页用到的操作） ─────────────────────────

/** BoardCanvas / GameScreen / GameClient 用到的棋盘控制器能力（game/BoardController 与 A6 的 OrigBoardController 满足） */
export interface BoardControllerLike extends BoardPort {
  readonly stage: StagePort | null;
  readonly followed: SeatIndex | null;
  refollow(): void;
  highlight(tiles: readonly TileId[], selected: TileId | null): void;
  say(seat: SeatIndex, text: string, ms: number, emote?: boolean): void;
  tileCanvasPos(id: TileId): Pt | null;
  anchorPos(at: Anchor, lift?: boolean): Pt | null;
  syncView(view: GameView): void;
}

export interface BoardControllerOptions {
  nameOf(seat: SeatIndex, view: GameView): string;
  autoFollow(): boolean;
  pinned?(): SeatIndex | null;
}

export interface CreateBoardOptions {
  host: HTMLElement;
  clock: AnimClock;
  quality: 'high' | 'mid' | 'low';
  def: MapDef;
  /** 加载地图前先设好的 HUD insets（loadMap 的 fitAll 依赖它） */
  insets: Insets;
  /** 棋盘内招牌文字的 i18n 查询 */
  label?(key: string): string | undefined;
  onTap?: SurfaceTapHandler;
  onDoubleTap?: SurfaceDoubleTapHandler;
  onContextLost?(lost: boolean): void;
  controller: BoardControllerOptions;
  /** 中止（棋盘在创建途中被卸载）：工厂销毁已建的渲染器并以 AbortError reject */
  signal?: AbortSignal;
}

export interface CreatedBoard {
  surface: BoardSurface;
  controller: BoardControllerLike;
}

/** 棋盘工厂：创建渲染器、设 insets、加载地图、建控制器 */
export type BoardFactory = (opts: CreateBoardOptions) => Promise<CreatedBoard>;

/** 工厂在中止时抛出的错误 */
export function boardAbortError(): Error {
  const e = new Error('棋盘创建已中止');
  e.name = 'AbortError';
  return e;
}
