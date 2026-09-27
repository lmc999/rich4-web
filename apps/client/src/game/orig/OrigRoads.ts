// 原版路面层（original-skin.md §3 修正 2「OrigStage-lite 的 syncWorld」；design-draft §3.4）：
// 路障 / 地雷 / 定时炸弹 / 礼物 / 宝箱（object.<kind>，原版 Data#370–372 与 354+t）、路上神明（object.<神明>）、
// 乞丐（char.<c>.beggar）与四大恶人棋子（npc.villain.<kind>.*，OrigActor）。sync(world) 按显示态做键控增删，
// 与程序化 RoadObjectView 同一套键（物件按 id、路上神明按 种类@节点、乞丐按座位、恶人按种类），counts() 同形。
// 帧 = (8 − view + facing) & 7；RoadObject 与路上神明没有朝向字段 → 确定性默认（按 id / 种类与节点哈希，critique 第 5 条）。
// 素材不可用时按条目回退到程序化外观（缩小的 drawRoadObject / 圆点）。
import { roadObjectFrame } from '@rich4/shared/assets';
import { GOD_KEYS, type TileId } from '@rich4/shared/data';
import type { Beggar, GodKind, GodSlot, RoadObject, VillainKind, VillainState } from '@rich4/shared/engine';
import { Container, Graphics, Sprite } from 'pixi.js';
import type { AnimClock } from '../anim/AnimClock';
import { drawRoadObject, godKey, type RoadWorld } from '../board/RoadObjectView';
import type { Pt } from '../iso/projection';
import { INK } from '../procedural/building/styles';
import { OrigLayer, origDepth } from './depth';
import { OrigActor } from './OrigActor';
import type { OrigAssets, SpriteSheet } from './OrigAssets';
import type { OrigProjection } from './OrigProjection';
import { sheetFrame } from './poses';

/** 恶人棋子的座位号（与程序化一致：0..3 是玩家） */
export const ORIG_VILLAIN_SEAT: Readonly<Record<VillainKind, number>> = { thief: 4, robber: 5, thug: 6, spy: 7 };

/** 路面物件的确定性朝向（没有 facing 字段）：按 id 哈希 */
export function objectFacing(id: number): number {
  return (Math.imul(id + 1, 0x9e3779b1) >>> 29) & 7;
}

/** 路上神明的确定性朝向：按种类与节点哈希 */
export function godFacing(kind: GodKind, node: TileId): number {
  return (Math.imul(kind * 131 + node, 0x9e3779b1) >>> 29) & 7;
}

/** 路面物件的逻辑键：object.roadblock / mine / bomb / gift / chest */
export function objectKey(kind: RoadObject['kind']): string {
  return `object.${kind}`;
}

/** 路上神明（原版 Data#354+t）的逻辑键：object.<神明键> */
export function godObjectKey(kind: GodKind): string {
  return `object.${GOD_KEYS[kind]}`;
}

interface Placed {
  root: Container;
  sprite: Sprite;
  fallback: Container | null;
  key: string;
  node: TileId;
  facing: number;
}

export interface OrigRoadsOptions {
  proj: OrigProjection;
  assets: OrigAssets;
  clock: AnimClock;
  objects: Container;
  tileWorld(id: TileId): Pt | null;
  boatTiles: ReadonlySet<TileId>;
  /** 座位 → 角色号（乞丐外观） */
  characterOf(seat: number): number | null;
  colorOf(seat: number): number;
  /** 恶人名牌（i18n）；undefined 时不挂名牌 */
  villainName?(kind: VillainKind): string | undefined;
}

export class OrigRoads {
  private readonly objects = new Map<number, Placed & { obj: RoadObject }>();
  private readonly gods = new Map<string, Placed & { kind: GodKind }>();
  private readonly beggars = new Map<number, Placed & { seat: number }>();
  private readonly villains = new Map<VillainKind, OrigActor>();
  private readonly villainNodes = new Map<VillainKind, TileId>();
  private dead = false;

  constructor(private readonly o: OrigRoadsOptions) {}

  // ───────────────────────── 同步 ─────────────────────────

  sync(w: RoadWorld): void {
    if (this.dead) return;
    this.syncObjects(w.objects);
    this.syncGods(w.gods);
    this.syncBeggars(w.beggars);
    this.syncVillains(w.villains);
  }

  private has(node: TileId): boolean {
    return node > 0 && this.o.tileWorld(node) !== null;
  }

  syncObjects(list: readonly RoadObject[]): void {
    const keep = new Set<number>();
    for (const obj of list) {
      if (!this.has(obj.node)) continue;
      keep.add(obj.id);
      const cur = this.objects.get(obj.id);
      if (cur && cur.obj.kind === obj.kind && cur.obj.node === obj.node) continue;
      if (cur) this.dropPlaced(this.objects, obj.id);
      this.addObject(obj);
    }
    for (const id of [...this.objects.keys()]) if (!keep.has(id)) this.dropPlaced(this.objects, id);
  }

  syncGods(slots: readonly GodSlot[]): void {
    const keep = new Set<string>();
    for (const s of slots) {
      if (s.where.t !== 'road' || !this.has(s.where.node)) continue;
      const key = godKey(s.kind, s.where.node);
      keep.add(key);
      if (!this.gods.has(key)) this.addGod(s.kind, s.where.node);
    }
    for (const key of [...this.gods.keys()]) if (!keep.has(key)) this.dropPlaced(this.gods, key);
  }

  syncBeggars(list: readonly Beggar[]): void {
    const keep = new Set<number>();
    for (const b of list) {
      if (!this.has(b.node)) continue;
      keep.add(b.seat);
      const cur = this.beggars.get(b.seat);
      if (cur && cur.node === b.node) continue;
      if (cur) {
        cur.node = b.node;
        this.place(cur);
        continue;
      }
      const ch = this.o.characterOf(b.seat);
      const key = ch === null ? '' : `char.${ch}.beggar`;
      const p = this.makePlaced(key, b.node, 0, () => beggarFallback(this.o.colorOf(b.seat)));
      p.root.label = `beggar:${b.seat}`;
      this.beggars.set(b.seat, { ...p, seat: b.seat });
    }
    for (const seat of [...this.beggars.keys()]) if (!keep.has(seat)) this.dropPlaced(this.beggars, seat);
  }

  syncVillains(list: readonly VillainState[]): void {
    for (const v of list) {
      const onBoard = v.onBoard && this.has(v.node);
      let a = this.villains.get(v.kind);
      if (!onBoard) {
        if (a) a.root.visible = false;
        this.villainNodes.delete(v.kind);
        continue;
      }
      a ??= this.addVillain(v.kind, v.node);
      a.root.visible = true;
      this.villainNodes.set(v.kind, v.node);
      a.settleAt(v.node);
    }
  }

  // ───────────────────────── 演出用的直接操作 ─────────────────────────

  addObject(obj: RoadObject): Container | null {
    if (this.dead || !this.has(obj.node)) return null;
    const cur = this.objects.get(obj.id);
    if (cur) return cur.root;
    const p = this.makePlaced(objectKey(obj.kind), obj.node, objectFacing(obj.id), () => {
      const f = drawRoadObject(obj.kind).root;
      f.scale.set(0.5);
      return f;
    });
    p.root.label = `object:${obj.kind}`;
    this.objects.set(obj.id, { ...p, obj });
    return p.root;
  }

  /** 取出某个物件的视图（交给演出做动画，调用方负责销毁） */
  detachObject(id: number): Container | null {
    const e = this.objects.get(id);
    if (!e) return null;
    this.objects.delete(id);
    return e.root;
  }

  objectOf(id: number): RoadObject | undefined {
    return this.objects.get(id)?.obj;
  }

  addGod(kind: GodKind, node: TileId): Container | null {
    if (this.dead || !this.has(node)) return null;
    const key = godKey(kind, node);
    const cur = this.gods.get(key);
    if (cur) return cur.root;
    const p = this.makePlaced(godObjectKey(kind), node, godFacing(kind, node), () => godFallback(kind));
    p.root.label = `god:${kind}`;
    this.gods.set(key, { ...p, kind });
    return p.root;
  }

  /** 取出路上神明（按种类找，优先 node 处）；调用方负责销毁 */
  detachGod(kind: GodKind, near?: TileId): Container | null {
    let key: string | null = near === undefined ? null : godKey(kind, near);
    if (key === null || !this.gods.has(key)) {
      key = null;
      for (const [k, e] of this.gods) {
        if (e.kind === kind) {
          key = k;
          break;
        }
      }
    }
    if (key === null) return null;
    const e = this.gods.get(key)!;
    this.gods.delete(key);
    return e.root;
  }

  villain(kind: VillainKind): OrigActor | undefined {
    return this.villains.get(kind);
  }

  villainNode(kind: VillainKind): TileId | null {
    return this.villainNodes.get(kind) ?? null;
  }

  ensureVillain(kind: VillainKind, node: TileId): OrigActor | null {
    if (this.dead || !this.has(node)) return null;
    const a = this.villains.get(kind) ?? this.addVillain(kind, node);
    a.root.visible = true;
    return a;
  }

  beggarView(seat: number): Container | undefined {
    return this.beggars.get(seat)?.root;
  }

  /** 乞丐挪窝（演出用）：记下新节点并返回视图与新旧位置，补间后调用 settle */
  moveBeggar(seat: number, node: TileId): { root: Container; from: Pt; to: Pt; settle: () => void } | null {
    const e = this.beggars.get(seat);
    const w = this.o.tileWorld(node);
    if (!e || !w) return null;
    const from = { x: e.root.position.x, y: e.root.position.y };
    const to = this.o.proj.projectPx(w);
    e.node = node;
    return { root: e.root, from, to, settle: () => this.place(e) };
  }

  counts(): { objects: number; gods: number; beggars: number; villains: number } {
    let villains = 0;
    for (const a of this.villains.values()) if (a.root.visible) villains++;
    return { objects: this.objects.size, gods: this.gods.size, beggars: this.beggars.size, villains };
  }

  /** 换视角：位置与帧重算 */
  relayout(): void {
    for (const e of this.objects.values()) this.place(e);
    for (const e of this.gods.values()) this.place(e);
    for (const e of this.beggars.values()) this.place(e);
    for (const a of this.villains.values()) a.onViewChanged();
  }

  clear(): void {
    for (const id of [...this.objects.keys()]) this.dropPlaced(this.objects, id);
    for (const k of [...this.gods.keys()]) this.dropPlaced(this.gods, k);
    for (const s of [...this.beggars.keys()]) this.dropPlaced(this.beggars, s);
    for (const a of this.villains.values()) a.destroy();
    this.villains.clear();
    this.villainNodes.clear();
  }

  destroy(): void {
    this.clear();
    this.dead = true;
  }

  // ───────────────────────── 内部 ─────────────────────────

  private makePlaced(key: string, node: TileId, facing: number, fallback: () => Container): Placed {
    const root = new Container();
    const sprite = new Sprite();
    root.addChild(sprite);
    this.o.objects.addChild(root);
    const p: Placed = { root, sprite, fallback: null, key, node, facing };
    this.place(p);
    if (key && !this.o.assets.settled(key)) {
      void this.o.assets.sheet(key).then(() => {
        if (!root.destroyed) this.place(p, fallback);
      });
    } else this.place(p, fallback);
    return p;
  }

  private place(p: Placed, fallback?: () => Container): void {
    if (p.root.destroyed) return;
    const w = this.o.tileWorld(p.node);
    if (!w) return;
    const at = this.o.proj.projectPx(w);
    p.root.position.set(at.x, at.y);
    p.root.zIndex = origDepth(at.y, OrigLayer.Object);
    const sheet: SpriteSheet | null = p.key ? this.o.assets.sheetNow(p.key) : null;
    if (sheet) {
      const f = sheet.dirs === 8 ? roadObjectFrame(p.facing, this.o.proj.view) : sheetFrame(sheet, 0, 0, 0);
      const [ax, ay] = sheet.anchors[f] ?? [0, 0];
      p.sprite.texture = sheet.frames[f]!;
      p.sprite.position.set(-ax, -ay);
      p.sprite.visible = true;
      p.fallback?.destroy({ children: true });
      p.fallback = null;
    } else if (fallback && !p.fallback && (!p.key || this.o.assets.settled(p.key))) {
      p.sprite.visible = false;
      p.fallback = fallback();
      p.root.addChild(p.fallback);
    }
  }

  private dropPlaced<K>(map: Map<K, Placed>, key: K): void {
    const e = map.get(key);
    if (!e) return;
    map.delete(key);
    if (!e.root.destroyed) e.root.destroy({ children: true });
  }

  private addVillain(kind: VillainKind, node: TileId): OrigActor {
    const name = this.o.villainName?.(kind);
    const a = new OrigActor({
      seat: ORIG_VILLAIN_SEAT[kind],
      kind: { t: 'villain', villain: kind },
      assets: this.o.assets,
      proj: this.o.proj,
      clock: this.o.clock,
      tileWorld: this.o.tileWorld,
      boatTiles: this.o.boatTiles,
      color: 0x5a5a5a,
      layer: OrigLayer.Npc,
      ...(name ? { name } : {}),
    });
    this.o.objects.addChild(a.root);
    a.teleport(node);
    this.villains.set(kind, a);
    return a;
  }
}

function beggarFallback(color: number): Container {
  const g = new Graphics()
    .ellipse(0, -8, 8, 9)
    .fill(0x9a8f80)
    .stroke({ width: 1.5, color: INK })
    .circle(0, -19, 5)
    .fill(0xe8c8a0)
    .stroke({ width: 1.5, color: INK })
    .circle(-7, -23, 2.5)
    .fill(color);
  return g;
}

function godFallback(kind: GodKind): Container {
  const good = kind <= 4 || kind === 9 || kind === 12;
  return new Graphics()
    .circle(0, -12, 8)
    .fill(good ? 0xffd84d : 0x8e78c0)
    .stroke({ width: 2, color: INK });
}
