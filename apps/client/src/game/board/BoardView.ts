// 棋盘视图（design/client.md §3）：load(map) 建地面、地块、企业、地标、装饰与格标记；setRotation 重新布局；
// 地块状态（归属、等级、设施类型）与角色由调用方驱动（M3 后续由 EventPlayer / GameView 驱动 sync）。
import type { LotId, MapDef, TileId } from '@rich4/shared/data';
import { Container, Rectangle } from 'pixi.js';
import { PlayerActor, SEAT_OFFSETS } from '../actors/PlayerActor';
import type { AnimClock } from '../anim/AnimClock';
import type { WorldRect } from '../camera/Camera';
import { PickIndex, type PickResult } from '../iso/picking';
import { normRotation, type Pt, type Rotation, screenToLogical } from '../iso/projection';
import type { Layers } from '../layers';
import type { FacilityStyle } from '../procedural/building/styles';
import type { CharacterFrames } from '../procedural/character/atlas';
import type { TextureCache } from '../procedural/textureCache';
import { BoardGeometry } from './BoardGeometry';
import { CompanyView } from './CompanyView';
import { Decorations } from './Decorations';
import { FacilityView } from './FacilityView';
import { DEFAULT_GROUND_OPTIONS, GroundLayer, type GroundOptions } from './GroundLayer';
import { LandmarkView } from './LandmarkView';
import { LotView, type ViewContext } from './LotView';
import { buildRoadGraph, type RoadGraph } from './RoadPainter';
import { TileMarkers } from './TileMarkers';

export interface BoardLabels {
  /** i18n 查询，键形如 "tiles:industry.bank" / "ui:board.forSale" */
  label?: (key: string) => string | undefined;
  locale?: 'zh-CN' | 'zh-TW';
}

export interface LotVisualState {
  owner: number | null;
  level: number;
  /** 仅设施地 */
  facility?: FacilityStyle;
}

export interface BoardStats {
  tiles: number;
  roadCells: number;
  viaCells: number;
  lots: number;
  facilities: number;
  companies: number;
  landmarks: number;
  decorations: number;
  groundChunks: number;
  brokenRoadSteps: number;
}

export class BoardView {
  private geo: BoardGeometry | null = null;
  private road: RoadGraph | null = null;
  private pickIndex: PickIndex | null = null;
  private readonly ground: GroundLayer;
  private readonly decorations: Decorations;
  readonly markers: TileMarkers;
  private lots = new Map<string, LotView>();
  private facilities = new Map<string, FacilityView>();
  private companies = new Map<string, CompanyView>();
  private landmarks = new Map<string, LandmarkView>();
  private actors = new Map<number, PlayerActor>();
  private rot: Rotation = 0;
  /** marks 层内的地块底板子层（在格标记之下） */
  private readonly plates = new Container({ label: 'plates' });

  constructor(
    private readonly layers: Layers,
    private readonly cache: TextureCache,
    private readonly clock: AnimClock,
    private readonly labels: BoardLabels = {},
    groundOptions: GroundOptions = DEFAULT_GROUND_OPTIONS,
  ) {
    this.ground = new GroundLayer(layers.ground, groundOptions);
    this.decorations = new Decorations(layers.objects);
    layers.marks.addChild(this.plates);
    this.markers = new TileMarkers(layers.marks, clock);
  }

  get loaded(): boolean {
    return this.geo !== null;
  }

  get def(): MapDef {
    return this.geometry.def;
  }

  get geometry(): BoardGeometry {
    if (!this.geo) throw new Error('BoardView: no map loaded');
    return this.geo;
  }

  get rotation(): Rotation {
    return this.rot;
  }

  load(def: MapDef, rotation: Rotation = this.rot): void {
    this.unload();
    this.rot = rotation;
    this.geo = new BoardGeometry(def, rotation);
    this.road = buildRoadGraph(def);
    this.pickIndex = new PickIndex(def);
    const ctx = this.viewContext();
    for (const l of def.lots) {
      if (l.kind === 'land') this.lots.set(l.id, new LotView(ctx, l));
      else this.facilities.set(l.id, new FacilityView(ctx, l));
    }
    for (const c of def.companies) this.companies.set(c.id, new CompanyView(ctx, c));
    for (const m of def.landmarks) this.landmarks.set(m.id, new LandmarkView(ctx, m));
    this.decorations.build(this.geo);
    this.markers.attach(this.geo);
    this.relayout();
  }

  /** 重建全部视觉（上下文恢复后、地面缓存失效时） */
  refresh(): void {
    if (this.geo) this.relayout();
  }

  setRotation(r: number): void {
    const rot = normRotation(r);
    if (rot === this.rot && this.geo?.rotation === rot) return;
    this.rot = rot;
    if (!this.geo) return;
    this.geo.setRotation(rot);
    this.relayout();
  }

  /** 屏幕（world 本地像素）上一点对应的逻辑连续坐标（旋转前后镜头保持对准用） */
  screenToLogical(p: Pt): Pt {
    return screenToLogical(p.x, p.y, this.rot, this.geometry.grid);
  }

  /** 逻辑连续坐标 → 屏幕 */
  logicalToScreen(p: Pt): Pt {
    return this.geometry.toScreen(p);
  }

  tileScreenPos(id: TileId): Pt {
    return this.geometry.tileScreenPos(id);
  }

  bounds(): WorldRect {
    return this.geometry.bounds();
  }

  pick(worldPt: Pt): PickResult | null {
    if (!this.pickIndex) return null;
    return this.pickIndex.pickScreen(worldPt.x, worldPt.y, this.rot);
  }

  lotIds(): LotId[] {
    return [...this.lots.keys(), ...this.facilities.keys()] as LotId[];
  }

  landLotIds(): LotId[] {
    return [...this.lots.keys()] as LotId[];
  }

  facilityIds(): LotId[] {
    return [...this.facilities.keys()] as LotId[];
  }

  companyIds(): LotId[] {
    return [...this.companies.keys()] as LotId[];
  }

  setLotState(id: string, s: LotVisualState): void {
    const land = this.lots.get(id);
    if (land) {
      land.setState({ owner: s.owner, level: s.level });
      return;
    }
    const fac = this.facilities.get(id);
    if (fac) {
      fac.setState({ owner: s.owner, level: s.level, facility: s.facility ?? fac.state.facility });
      return;
    }
    const co = this.companies.get(id);
    if (co) co.setChairman(s.owner);
  }

  /** 地块、设施、企业的视图（动画用：建筑精灵、底板） */
  footprint(id: string): LotView | FacilityView | CompanyView | undefined {
    return this.lots.get(id) ?? this.facilities.get(id) ?? this.companies.get(id);
  }

  /** 地块矩形中心的屏幕坐标（world 本地像素） */
  lotScreenPos(id: string): Pt | null {
    const v = this.footprint(id);
    if (!v) return null;
    const r = v.rect;
    return this.geometry.toScreen({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  }

  clearLotStates(): void {
    for (const l of this.lots.values()) l.setState({ owner: null, level: 0 });
    for (const f of this.facilities.values()) f.setState({ owner: null, level: 0, facility: 'vacant' });
    for (const c of this.companies.values()) c.setChairman(null);
  }

  // ───────── 角色 ─────────

  addActor(seat: number, frames: CharacterFrames | null, name: string, tile: TileId): PlayerActor {
    this.removeActor(seat);
    const a = new PlayerActor({ seat, geo: this.geometry, clock: this.clock, frames, name });
    this.layers.objects.addChild(a.root);
    this.actors.set(seat, a);
    a.teleport(tile);
    this.spreadActors();
    return a;
  }

  actor(seat: number): PlayerActor | undefined {
    return this.actors.get(seat);
  }

  allActors(): PlayerActor[] {
    return [...this.actors.values()];
  }

  removeActor(seat: number): void {
    const a = this.actors.get(seat);
    if (!a) return;
    a.destroy();
    this.actors.delete(seat);
  }

  removeActors(): void {
    for (const seat of [...this.actors.keys()]) this.removeActor(seat);
  }

  /** 同格多人时按座位偏移，避免重叠 */
  spreadActors(): void {
    const byTile = new Map<TileId, PlayerActor[]>();
    for (const a of this.actors.values()) {
      if (a.tile === null || a.isWalking) continue;
      const list = byTile.get(a.tile) ?? [];
      list.push(a);
      byTile.set(a.tile, list);
    }
    for (const list of byTile.values()) {
      for (const a of list)
        a.setOffset(list.length > 1 ? (SEAT_OFFSETS[a.seat % 4] ?? { x: 0, y: 0 }) : { x: 0, y: 0 });
    }
  }

  stats(): BoardStats {
    const def = this.def;
    return {
      tiles: def.tiles.length,
      roadCells: this.road?.cells.length ?? 0,
      viaCells: this.road?.viaCells.size ?? 0,
      lots: this.lots.size,
      facilities: this.facilities.size,
      companies: this.companies.size,
      landmarks: this.landmarks.size,
      decorations: this.decorations.count,
      groundChunks: this.ground.chunkCount,
      brokenRoadSteps: this.road?.brokenSteps ?? 0,
    };
  }

  /** world 层命中区域（整个棋盘） */
  hitArea(): Rectangle {
    const b = this.bounds();
    return new Rectangle(b.x, b.y, b.w, b.h);
  }

  unload(): void {
    this.removeActors();
    for (const v of [
      ...this.lots.values(),
      ...this.facilities.values(),
      ...this.companies.values(),
      ...this.landmarks.values(),
    ]) {
      v.destroy();
    }
    this.lots.clear();
    this.facilities.clear();
    this.companies.clear();
    this.landmarks.clear();
    this.decorations.clear();
    this.ground.clear();
    this.geo = null;
    this.road = null;
    this.pickIndex = null;
  }

  destroy(): void {
    this.unload();
    this.markers.destroy();
    this.plates.destroy({ children: true });
  }

  // ───────── 内部 ─────────

  private relayout(): void {
    const geo = this.geometry;
    if (this.road) this.ground.build(geo, this.road);
    for (const v of [
      ...this.lots.values(),
      ...this.facilities.values(),
      ...this.companies.values(),
      ...this.landmarks.values(),
    ]) {
      v.layout();
    }
    this.decorations.layout(geo);
    this.markers.redraw();
    for (const a of this.actors.values()) a.setGeometry(geo);
  }

  private viewContext(): ViewContext {
    const layers = this.layers;
    const labels = this.labels;
    const self = this;
    return {
      get geo() {
        return self.geometry;
      },
      cache: this.cache,
      marks: this.plates,
      objects: layers.objects,
      label: (key) => labels.label?.(key),
      mapString: (key) => this.geo?.def.strings[labels.locale ?? 'zh-CN'][key],
    };
  }
}
