// 路面层（design/client.md §3.6）：路障、地雷（闪灯）、定时炸弹（引信火花）、礼物、宝箱、路上神明（漂浮 + 柔光）、
// 恶犬、乞丐与四大恶人棋子。sync(world) 按显示态做键控增删（物件按 id、路上神明按 种类@节点、乞丐按座位、恶人按种类），
// 演出（BoardStage）可以先 detach / add 某个对象做动画，随后的 sync 发现已一致就不再动它。
import type {
  Beggar,
  GodKind,
  GodSlot,
  RoadObject,
  RoadObjectKind,
  TileId,
  VillainKind,
  VillainState,
} from '@rich4/shared/engine';
import { Container, Graphics } from 'pixi.js';
import { canRasterize, FigureTextures } from '../actors/figureTextures';
import { GodSprite } from '../actors/GodSprite';
import { PlayerActor } from '../actors/PlayerActor';
import type { AnimClock } from '../anim/AnimClock';
import { DepthBias, depthOfCell } from '../iso/depth';
import type { Pt } from '../iso/projection';
import { INK, PLAYER_COLORS } from '../procedural/building/styles';
import type { BoardGeometry } from './BoardGeometry';

export interface RoadWorld {
  objects: readonly RoadObject[];
  gods: readonly GodSlot[];
  beggars: readonly Beggar[];
  villains: readonly VillainState[];
}

/** 恶人棋子的座位号（PlayerActor 用它选占位颜色与同格偏移；0..3 是玩家） */
export const VILLAIN_SEAT: Readonly<Record<VillainKind, number>> = { thief: 4, robber: 5, thug: 6, spy: 7 };

interface ObjectEntry {
  obj: RoadObject;
  root: Container;
  /** 地雷红灯、炸弹火花（闪烁） */
  blink: Graphics | null;
}

interface GodEntry {
  kind: GodKind;
  node: TileId;
  sprite: GodSprite;
}

interface BeggarEntry {
  seat: number;
  node: TileId;
  root: Container;
}

export function godKey(kind: GodKind, node: TileId): string {
  return `${kind}@${node}`;
}

/** 物件外观（原点在格中心地面） */
export function drawRoadObject(kind: RoadObjectKind): { root: Container; blink: Graphics | null } {
  const root = new Container({ label: `object:${kind}` });
  const g = new Graphics();
  let blink: Graphics | null = null;
  g.ellipse(0, 2, 24, 9).fill({ color: 0x000000, alpha: 0.18 });
  switch (kind) {
    case 'roadblock': {
      // 红白栅栏 + 两个锥桶
      for (const x of [-22, 22]) {
        g.poly([x - 7, 0, x + 7, 0, x, -24], true)
          .fill(0xff9f43)
          .stroke({ width: 2.5, color: INK, join: 'round' });
        g.rect(x - 4, -12, 8, 4).fill(0xffffff);
      }
      g.rect(-18, -30, 4, 26).fill(0x8a8f99).stroke({ width: 2, color: INK });
      g.rect(14, -30, 4, 26).fill(0x8a8f99).stroke({ width: 2, color: INK });
      g.roundRect(-26, -34, 52, 12, 3).fill(0xffffff).stroke({ width: 3, color: INK });
      for (const x of [-20, -6, 8]) g.poly([x, -34, x + 8, -34, x + 2, -22, x - 6, -22], true).fill(0xe8453c);
      break;
    }
    case 'mine': {
      g.ellipse(0, -2, 18, 8).fill(0x5a5a52).stroke({ width: 3, color: INK });
      g.ellipse(0, -5, 12, 5).fill(0x7a7a70);
      blink = new Graphics().circle(0, -9, 4).fill(0xf2545b).stroke({ width: 1.5, color: INK });
      break;
    }
    case 'bomb': {
      g.circle(0, -14, 13).fill(0x2a2a2a).stroke({ width: 3, color: INK });
      g.circle(-5, -19, 3.5).fill(0x8a8f99);
      g.roundRect(-4, -31, 8, 6, 1).fill(0x5a5a5a).stroke({ width: 1.5, color: INK });
      g.moveTo(0, -31).quadraticCurveTo(8, -40, 12, -36).stroke({ width: 2.5, color: 0x8a5a2b });
      blink = new Graphics()
        .poly([12, -44, 14, -38, 20, -36, 14, -34, 12, -28, 10, -34, 4, -36, 10, -38], true)
        .fill(0xffd84d)
        .stroke({ width: 1.5, color: 0xff9f43 });
      break;
    }
    case 'gift': {
      g.roundRect(-14, -26, 28, 24, 3).fill(0x3d8bfd).stroke({ width: 3, color: INK });
      g.rect(-3, -26, 6, 24).fill(0xffd84d);
      g.roundRect(-16, -32, 32, 8, 2).fill(0x5aa0ff).stroke({ width: 3, color: INK });
      g.ellipse(-6, -36, 6, 4).stroke({ width: 3, color: 0xffd84d });
      g.ellipse(6, -36, 6, 4).stroke({ width: 3, color: 0xffd84d });
      break;
    }
    case 'chest': {
      g.roundRect(-18, -22, 36, 20, 3).fill(0x8a5a2b).stroke({ width: 3, color: INK });
      g.roundRect(-18, -32, 36, 12, 6).fill(0xa0643c).stroke({ width: 3, color: INK });
      g.rect(-18, -21, 36, 3).fill(0xffd84d);
      g.roundRect(-4, -24, 8, 8, 2).fill(0xffd84d).stroke({ width: 2, color: INK });
      break;
    }
  }
  root.addChild(g);
  if (blink) root.addChild(blink);
  return { root, blink };
}

/** 乞丐：缩成一团的破衣小人 + 破碗 + 原玩家色标记 */
export function drawBeggar(seat: number): Container {
  const c = new Container({ label: `beggar:${seat}` });
  const g = new Graphics();
  g.ellipse(0, 2, 20, 8).fill({ color: 0x000000, alpha: 0.2 });
  g.ellipse(0, -16, 16, 18).fill(0x9a8f80).stroke({ width: 3, color: INK });
  g.rect(-8, -22, 7, 6).fill(0xb59a74).stroke({ width: 1.5, color: INK });
  g.circle(0, -38, 11).fill(0xe8c8a0).stroke({ width: 3, color: INK });
  g.moveTo(-5, -38).lineTo(-2, -38).stroke({ width: 2, color: INK });
  g.moveTo(2, -38).lineTo(5, -38).stroke({ width: 2, color: INK });
  g.ellipse(16, -2, 9, 4).fill(0x8a8f99).stroke({ width: 2, color: INK });
  g.circle(-14, -46, 5)
    .fill(PLAYER_COLORS[seat % 4] ?? 0xffffff)
    .stroke({ width: 2, color: INK });
  c.addChild(g);
  c.alpha = 0.9;
  return c;
}

export interface RoadObjectViewOptions {
  /** i18n 查询（恶人名牌）；返回 undefined 时不挂名牌 */
  label?: (key: string) => string | undefined;
  /** 栅格化造型纹理（缺省：有 DOM 时开启） */
  rasterize?: boolean;
}

export class RoadObjectView {
  readonly figures: FigureTextures | null;
  private geo: BoardGeometry | null = null;
  private readonly objects = new Map<number, ObjectEntry>();
  private readonly gods = new Map<string, GodEntry>();
  private readonly beggars = new Map<number, BeggarEntry>();
  private readonly villains = new Map<VillainKind, PlayerActor>();
  private readonly villainNodes = new Map<VillainKind, TileId>();
  private readonly offFrame: () => void;
  private t = 0;

  constructor(
    private readonly objectsLayer: Container,
    private readonly clock: AnimClock,
    private readonly o: RoadObjectViewOptions = {},
  ) {
    this.figures = (o.rasterize ?? canRasterize()) ? new FigureTextures(2) : null;
    this.offFrame = clock.onFrame((_now, dt) => this.tick(dt));
  }

  get attached(): boolean {
    return this.geo !== null;
  }

  /** 载入地图（BoardView.load） */
  attach(geo: BoardGeometry): void {
    this.clear();
    this.geo = geo;
  }

  /** 旋转后重新布局 */
  layout(): void {
    if (!this.geo) return;
    for (const e of this.objects.values()) this.place(e.root, e.obj.node, DepthBias.RoadObject);
    for (const e of this.gods.values()) this.place(e.sprite.root, e.node, DepthBias.Actor);
    for (const e of this.beggars.values()) this.place(e.root, e.node, DepthBias.Actor);
    for (const a of this.villains.values()) a.setGeometry(this.geo);
  }

  // ───────── 同步 ─────────

  sync(w: RoadWorld): void {
    if (!this.geo) return;
    this.syncObjects(w.objects);
    this.syncGods(w.gods);
    this.syncBeggars(w.beggars);
    this.syncVillains(w.villains);
  }

  syncObjects(list: readonly RoadObject[]): void {
    const keep = new Set<number>();
    for (const obj of list) {
      if (!this.hasTile(obj.node)) continue;
      keep.add(obj.id);
      const cur = this.objects.get(obj.id);
      if (cur && cur.obj.kind === obj.kind && cur.obj.node === obj.node) continue;
      if (cur) this.dropObjectView(obj.id);
      this.addObject(obj);
    }
    for (const id of [...this.objects.keys()]) if (!keep.has(id)) this.dropObjectView(id);
  }

  syncGods(slots: readonly GodSlot[]): void {
    const keep = new Set<string>();
    for (const s of slots) {
      if (s.where.t !== 'road' || !this.hasTile(s.where.node)) continue;
      const key = godKey(s.kind, s.where.node);
      keep.add(key);
      if (!this.gods.has(key)) this.addGod(s.kind, s.where.node);
    }
    for (const key of [...this.gods.keys()]) if (!keep.has(key)) this.removeGod(key);
  }

  syncBeggars(list: readonly Beggar[]): void {
    const keep = new Set<number>();
    for (const b of list) {
      if (!this.hasTile(b.node)) continue;
      keep.add(b.seat);
      const cur = this.beggars.get(b.seat);
      if (cur && cur.node === b.node) continue;
      if (cur) {
        cur.node = b.node;
        this.place(cur.root, b.node, DepthBias.Actor);
        continue;
      }
      const root = drawBeggar(b.seat);
      this.objectsLayer.addChild(root);
      this.place(root, b.node, DepthBias.Actor);
      this.beggars.set(b.seat, { seat: b.seat, node: b.node, root });
    }
    for (const [seat, e] of [...this.beggars]) {
      if (keep.has(seat)) continue;
      e.root.destroy({ children: true });
      this.beggars.delete(seat);
    }
  }

  syncVillains(list: readonly VillainState[]): void {
    const geo = this.geo;
    if (!geo) return;
    for (const v of list) {
      const onBoard = v.onBoard && v.node > 0 && geo.hasTile(v.node);
      let a = this.villains.get(v.kind);
      if (!onBoard) {
        if (a) a.root.visible = false;
        this.villainNodes.delete(v.kind);
        continue;
      }
      if (!a) a = this.addVillain(v.kind, v.node);
      a.root.visible = true;
      this.villainNodes.set(v.kind, v.node);
      a.settleAt(v.node);
    }
  }

  // ───────── 演出用的直接操作 ─────────

  addObject(obj: RoadObject): Container | null {
    if (!this.geo || !this.hasTile(obj.node)) return null;
    const cur = this.objects.get(obj.id);
    if (cur) return cur.root;
    const { root, blink } = drawRoadObject(obj.kind);
    this.objectsLayer.addChild(root);
    this.place(root, obj.node, DepthBias.RoadObject);
    this.objects.set(obj.id, { obj, root, blink });
    return root;
  }

  /** 取出某个物件的视图（交给演出做动画，调用方负责销毁）；不存在返回 null */
  detachObject(id: number): Container | null {
    const e = this.objects.get(id);
    if (!e) return null;
    this.objects.delete(id);
    return e.root;
  }

  objectView(id: number): Container | undefined {
    return this.objects.get(id)?.root;
  }

  objectOf(id: number): RoadObject | undefined {
    return this.objects.get(id)?.obj;
  }

  addGod(kind: GodKind, node: TileId): GodSprite | null {
    if (!this.geo || !this.hasTile(node)) return null;
    const key = godKey(kind, node);
    const cur = this.gods.get(key);
    if (cur) return cur.sprite;
    const sprite = new GodSprite(kind, this.clock, this.figures, 'road');
    this.objectsLayer.addChild(sprite.root);
    this.place(sprite.root, node, DepthBias.Actor);
    this.gods.set(key, { kind, node, sprite });
    return sprite;
  }

  /** 取出路上神明（按种类找，优先 node 处）；调用方负责销毁 */
  detachGod(kind: GodKind, near?: TileId): GodSprite | null {
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
    return e.sprite;
  }

  villain(kind: VillainKind): PlayerActor | undefined {
    return this.villains.get(kind);
  }

  villainNode(kind: VillainKind): TileId | null {
    return this.villainNodes.get(kind) ?? null;
  }

  /** 恶人棋子（没有时按需创建，行走演出用） */
  ensureVillain(kind: VillainKind, node: TileId): PlayerActor | null {
    if (!this.geo || !this.hasTile(node)) return null;
    const a = this.villains.get(kind) ?? this.addVillain(kind, node);
    a.root.visible = true;
    return a;
  }

  beggarView(seat: number): Container | undefined {
    return this.beggars.get(seat)?.root;
  }

  /**
   * 乞丐挪窝（演出用）：记下新节点并返回视图与旧位置，由调用方补间到新位置后调用 settle；
   * 没有这个乞丐时返回 null。
   */
  moveBeggar(seat: number, node: TileId): { root: Container; from: Pt; to: Pt; settle: () => void } | null {
    const e = this.beggars.get(seat);
    const to = this.tilePos(node);
    if (!e || !to) return null;
    const from = { x: e.root.position.x, y: e.root.position.y };
    e.node = node;
    return { root: e.root, from, to, settle: () => this.place(e.root, node, DepthBias.Actor) };
  }

  /** 格中心（world 本地像素） */
  tilePos(node: TileId): Pt | null {
    if (!this.geo || !this.hasTile(node)) return null;
    return this.geo.tileScreenPos(node);
  }

  counts(): { objects: number; gods: number; beggars: number; villains: number } {
    let villains = 0;
    for (const a of this.villains.values()) if (a.root.visible) villains++;
    return { objects: this.objects.size, gods: this.gods.size, beggars: this.beggars.size, villains };
  }

  /** 卸载地图：清掉全部路面对象（纹理缓存保留） */
  clear(): void {
    for (const id of [...this.objects.keys()]) this.dropObjectView(id);
    for (const key of [...this.gods.keys()]) this.removeGod(key);
    for (const e of this.beggars.values()) e.root.destroy({ children: true });
    this.beggars.clear();
    for (const a of this.villains.values()) a.destroy();
    this.villains.clear();
    this.villainNodes.clear();
    this.geo = null;
  }

  destroy(): void {
    this.clear();
    this.offFrame();
    this.figures?.destroy();
  }

  // ───────── 内部 ─────────

  private hasTile(node: TileId): boolean {
    return node > 0 && this.geo !== null && this.geo.hasTile(node);
  }

  private place(node: Container, tile: TileId, bias: DepthBias): void {
    const geo = this.geo;
    if (!geo || node.destroyed) return;
    const c = geo.tileCell(tile);
    const p = geo.tileScreenPos(tile);
    node.position.set(p.x, p.y);
    node.zIndex = depthOfCell(geo.viewCell(c), bias);
  }

  private dropObjectView(id: number): void {
    const e = this.objects.get(id);
    if (!e) return;
    this.objects.delete(id);
    if (!e.root.destroyed) e.root.destroy({ children: true });
  }

  private removeGod(key: string): void {
    const e = this.gods.get(key);
    if (!e) return;
    this.gods.delete(key);
    e.sprite.destroy();
  }

  private addVillain(kind: VillainKind, node: TileId): PlayerActor {
    const geo = this.geo!;
    const a = new PlayerActor({ seat: VILLAIN_SEAT[kind], geo, clock: this.clock, frames: null });
    a.root.label = `villain:${kind}`;
    this.objectsLayer.addChild(a.root);
    a.teleport(node);
    this.villains.set(kind, a);
    const name = this.o.label?.(`events:villain.${kind}`);
    if (name && canRasterize()) a.setName(name);
    if (this.figures) {
      void this.figures.frames(`villain:${kind}`).then((f) => {
        if (f && this.villains.get(kind) === a && !a.destroyed) a.setFrames(f);
      });
    }
    return a;
  }

  private tick(dt: number): void {
    this.t += dt;
    const on = Math.floor(this.t / 350) % 2 === 0;
    for (const e of this.objects.values()) {
      if (!e.blink || e.blink.destroyed) continue;
      if (e.obj.kind === 'mine') e.blink.alpha = on ? 1 : 0.25;
      else e.blink.scale.set(0.8 + 0.3 * Math.abs(Math.sin(this.t / 90)));
    }
  }
}
