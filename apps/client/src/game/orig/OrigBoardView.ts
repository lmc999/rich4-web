// 原版静态棋盘（original-skin.md §5 A6；design-draft §3.3「OrigBoardView」、render.md §1.3、§2.2–§2.5）：
// - 地面：地图皮肤的切块纹理放在同一个容器里，容器套当前视角的仿射（整张地面 4 个 draw call）；
// - 装饰圆盘：节点 decor（帧 = decor − 1，锚点图心），画在地面之上、排序层之下，不参与深度排序；
// - 住宅（等级精灵 + 主人色掩膜乘角色代表色）、连锁店、设施（公园 / 旅馆 / 购物中心 / 加油站 / 研究所各级）、
//   企业（原版 spriteId+26，带主人色）、景观（不改色）：帧 = (8 − (facing + view)) & 7；
// - ownerMark：空地（等级 0）已有主时画角色标记（帧 = 角色号）；
// - lotHighlight（涨价 / 查封）：原版 #14 置信度 guess → 程序化闪烁高亮；
// - 目标高亮与选中格：投影后的格框（marks 层）；
// - 深度键 = 锚点棋盘 y × 16 + layer（depth.ts）；拾取用建筑精灵的 alpha（picking.ts）。
// 条目缺失时按条目回退：建筑缺精灵就画程序化占位块（仍带主人色），不整体放弃原版棋盘。
import { buildingFrame, type MapSkinV1 } from '@rich4/shared/assets';
import type { LotId, MapDef, TileId } from '@rich4/shared/data';
import { Container, Graphics, Matrix, Sprite, type Texture } from 'pixi.js';
import type { AnimClock } from '../anim/AnimClock';
import { backOut } from '../anim/easing';
import { tweenValue } from '../anim/tween';
import { POP_MS } from '../fx/timings';
import type { Pt } from '../iso/projection';
import { OrigLayer, origDepth } from './depth';
import type { OrigAssets, SpriteSheet } from './OrigAssets';
import type { OrigProjection } from './OrigProjection';
import type { SpriteHitBox } from './picking';

export type OrigFacility = 'vacant' | 'park' | 'hotel' | 'mall' | 'gas' | 'lab';

/** 地块外观（BoardPort.setLot 的 LotLook + 原版需要的连锁店 / 标记 / 代表色） */
export interface OrigLotLook {
  owner: number | null;
  level: number;
  facility?: OrigFacility;
  chain?: boolean;
  mark?: 'raise' | 'seal' | null;
}

/** 主人（座位）→ 角色号与代表色 */
export interface OwnerStyle {
  character(seat: number): number | null;
  color(seat: number): number;
}

/** 无主建筑的描边色（原版改写调色板 255 为 0） */
export const NO_OWNER_COLOR = 0x000000;

interface LotEntry {
  id: LotId;
  kind: 'land' | 'facility' | 'company';
  world: Pt;
  facing: number;
  look: OrigLotLook;
  root: Container;
  body: Sprite;
  mask: Sprite;
  placeholder: Graphics | null;
  mark: Sprite | null;
  /** 角色标记的抬高（插旗落下动画；源像素） */
  markLift: number;
  sheetKey: string | null;
  frame: number;
}

interface SceneryEntry {
  key: string;
  world: Pt;
  facing: number;
  root: Container;
  body: Sprite;
  landmark: string | null;
}

/** 涨价 / 查封高亮的颜色（原版颜色表 0x4861d0 未解码，程序化取色） */
const MARK_COLORS = { raise: 0xffd84d, seal: 0xe8453c } as const;
/** 地块框的半边长（世界像素；原版小地块约 1.25 格、设施 / 企业约 2.5 格） */
const LOT_HALF = { land: 18, facility: 36, company: 36 } as const;
/** 目标高亮格框的半边长（世界像素） */
const TILE_HALF = 14;

export interface OrigBoardViewOptions {
  proj: OrigProjection;
  assets: OrigAssets;
  skin: MapSkinV1;
  def: MapDef;
  clock: AnimClock;
  /** 地面层（底图容器与装饰层的父节点） */
  ground: Container;
  /** 标记层（涨价查封高亮、目标高亮） */
  marks: Container;
  /** 排序层 */
  objects: Container;
  owners: OwnerStyle;
}

export class OrigBoardView {
  readonly proj: OrigProjection;
  readonly def: MapDef;
  readonly skin: MapSkinV1;
  private readonly assets: OrigAssets;
  private readonly groundRoot = new Container({ label: 'orig-ground' });
  private readonly decorRoot = new Container({ label: 'orig-decor' });
  private readonly lotMarks = new Graphics({ label: 'orig-lot-marks' });
  private readonly targets = new Graphics({ label: 'orig-targets' });
  private readonly tiles = new Map<TileId, Pt>();
  private readonly lots = new Map<LotId, LotEntry>();
  private readonly scenery: SceneryEntry[] = [];
  private readonly decor: { tile: TileId; sprite: Sprite }[] = [];
  private groundSprites: Sprite[] = [];
  private highlighted: TileId[] = [];
  private selected: TileId | null = null;
  private t = 0;
  private readonly offFrame: () => void;
  private dead = false;

  constructor(private readonly o: OrigBoardViewOptions) {
    this.proj = o.proj;
    this.def = o.def;
    this.skin = o.skin;
    this.assets = o.assets;
    o.ground.addChild(this.groundRoot, this.decorRoot);
    o.marks.addChild(this.lotMarks, this.targets);
    for (const t of o.def.tiles) this.tiles.set(t.id, t.world);
    this.offFrame = o.clock.onFrame((_now, dt) => this.tick(dt));
  }

  // ───────────────────────── 载入 ─────────────────────────

  /** 地图用到的全部棋盘精灵键（载入时预取） */
  spriteKeys(): string[] {
    const b = this.skin.buildings;
    const keys = new Set<string>();
    if (this.skin.decor.sprite) keys.add(this.skin.decor.sprite);
    if (b.ownerMark) keys.add(b.ownerMark);
    for (const k of b.house.levels) keys.add(k);
    if (b.house.chain) keys.add(b.house.chain);
    keys.add(b.facilities.park);
    for (const t of ['hotel', 'mall', 'gas', 'lab'] as const) for (const k of b.facilities[t]) keys.add(k);
    for (const c of b.companies) keys.add(c.sprite);
    for (const s of this.skin.scenery) keys.add(s.sprite);
    return [...keys];
  }

  /** 载入地面与全部棋盘精灵（组加载失败 → reject，整体回退程序化；单个条目不可用 → 按条目回退） */
  async load(signal?: AbortSignal): Promise<void> {
    const textures = await this.assets.ground(
      this.skin.ground.chunks.map((c) => c.file),
      signal,
    );
    await Promise.all(this.spriteKeys().map((k) => this.assets.sheet(k, signal)));
    if (this.dead) return;
    this.buildGround(textures);
    this.buildDecor();
    this.buildLots();
    this.buildScenery();
    this.relayout();
  }

  private buildGround(textures: Texture[]): void {
    this.groundSprites = this.skin.ground.chunks.map((c, i) => {
      const s = new Sprite(textures[i]!);
      s.position.set(c.x, c.y);
      s.label = `ground:${c.x},${c.y}`;
      this.groundRoot.addChild(s);
      return s;
    });
  }

  private buildDecor(): void {
    const key = this.skin.decor.sprite;
    const sheet = key ? this.assets.sheetNow(key) : null;
    if (!sheet) return;
    for (const n of this.skin.decor.nodes) {
      const tex = sheet.frames[n.frame];
      if (!tex || !this.tiles.has(n.tile)) continue;
      const s = new Sprite(tex);
      s.label = `decor:${n.tile}`;
      this.decorRoot.addChild(s);
      this.decor.push({ tile: n.tile, sprite: s });
      const [ax, ay] = sheet.anchors[n.frame] ?? [0, 0];
      s.pivot.set(ax, ay);
    }
  }

  private buildLots(): void {
    const add = (id: LotId, kind: LotEntry['kind'], world: Pt, facing: number | undefined): void => {
      const root = new Container({ label: `lot:${id}` });
      const body = new Sprite();
      const mask = new Sprite();
      mask.tint = NO_OWNER_COLOR;
      root.addChild(body, mask);
      root.visible = false;
      this.o.objects.addChild(root);
      this.lots.set(id, {
        id,
        kind,
        world,
        facing: facing ?? 0,
        look: { owner: null, level: 0 },
        root,
        body,
        mask,
        placeholder: null,
        mark: null,
        markLift: 0,
        sheetKey: null,
        frame: -1,
      });
    };
    for (const l of this.def.lots) add(l.id, l.kind === 'land' ? 'land' : 'facility', l.world, l.facing);
    for (const c of this.def.companies) add(c.id, 'company', c.world, c.facing);
    // 企业一开始就有建筑（无主时描边为黑）
    for (const e of this.lots.values()) if (e.kind === 'company') this.applyLook(e);
  }

  private buildScenery(): void {
    for (const s of this.skin.scenery) {
      const root = new Container({ label: `scenery:${s.id}` });
      const body = new Sprite();
      root.addChild(body);
      this.o.objects.addChild(root);
      this.scenery.push({ key: s.sprite, world: s.world, facing: s.facing, root, body, landmark: s.landmark });
    }
  }

  // ───────────────────────── 布局（载入与换视角） ─────────────────────────

  relayout(): void {
    if (this.dead) return;
    const m = this.proj.affine();
    this.groundRoot.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty));
    for (const d of this.decor) {
      const p = this.tilePos(d.tile);
      if (p) d.sprite.position.set(p.x, p.y);
    }
    for (const e of this.lots.values()) this.placeLot(e);
    for (const s of this.scenery) this.placeScenery(s);
    this.drawLotMarks();
    this.drawTargets();
  }

  private frameOf(sheet: SpriteSheet, facing: number): number {
    if (sheet.dirs !== 8 || this.skin.buildings.frameRule === 'static') return 0;
    return buildingFrame(facing, this.proj.view);
  }

  private placeScenery(s: SceneryEntry): void {
    const sheet = this.assets.sheetNow(s.key);
    const p = this.proj.projectPx(s.world);
    s.root.position.set(p.x, p.y);
    s.root.zIndex = origDepth(p.y, OrigLayer.Building);
    if (!sheet) {
      s.root.visible = false;
      return;
    }
    const f = this.frameOf(sheet, s.facing);
    const [ax, ay] = sheet.anchors[f] ?? [0, 0];
    s.body.texture = sheet.frames[f]!;
    s.body.position.set(-ax, -ay);
    s.root.visible = true;
  }

  private placeLot(e: LotEntry): void {
    const p = this.proj.projectPx(e.world);
    e.root.position.set(p.x, p.y);
    e.root.zIndex = origDepth(p.y, OrigLayer.Building);
    this.placeMark(e);
    this.refreshFrame(e);
  }

  /** 角色标记的位置（落点 = 地块锚点，插旗动画时抬高；深度按落点） */
  private placeMark(e: LotEntry): void {
    if (!e.mark || e.mark.destroyed) return;
    const p = this.proj.projectPx(e.world);
    e.mark.position.set(p.x, p.y - Math.round(e.markLift));
    e.mark.zIndex = origDepth(p.y, OrigLayer.Building);
  }

  private refreshFrame(e: LotEntry): void {
    const sheet = e.sheetKey ? this.assets.sheetNow(e.sheetKey) : null;
    if (!sheet) {
      e.body.visible = false;
      e.mask.visible = false;
      return;
    }
    const f = this.frameOf(sheet, e.facing);
    e.frame = f;
    const [ax, ay] = sheet.anchors[f] ?? [0, 0];
    e.body.texture = sheet.frames[f]!;
    e.body.position.set(-ax, -ay);
    e.body.visible = true;
    const mt = sheet.masks?.[f];
    if (mt) {
      e.mask.texture = mt;
      e.mask.position.set(-ax, -ay);
      e.mask.visible = true;
    } else e.mask.visible = false;
  }

  // ───────────────────────── 地块状态 ─────────────────────────

  /** 地块的建筑精灵键（没有建筑为 null） */
  sheetKeyFor(kind: LotEntry['kind'], id: LotId, look: OrigLotLook): string | null {
    const b = this.skin.buildings;
    if (kind === 'company') return b.companies.find((c) => c.lot === id)?.sprite ?? null;
    if (look.level <= 0) return null;
    if (kind === 'land') {
      if (look.chain && b.house.chain) return b.house.chain;
      return b.house.levels[Math.min(b.house.levels.length, look.level) - 1] ?? null;
    }
    const f = look.facility ?? 'vacant';
    if (f === 'vacant') return null;
    if (f === 'park') return b.facilities.park;
    const list = b.facilities[f];
    return list[Math.min(list.length, look.level) - 1] ?? null;
  }

  setLot(id: LotId, look: OrigLotLook): void {
    const e = this.lots.get(id);
    if (!e) return;
    const prev = e.look;
    e.look = { ...prev, ...look };
    if (look.chain === undefined) e.look.chain = prev.chain;
    if (look.mark === undefined) e.look.mark = prev.mark;
    this.applyLook(e);
    this.drawLotMarks();
  }

  lotLook(id: LotId): OrigLotLook | null {
    return this.lots.get(id)?.look ?? null;
  }

  private applyLook(e: LotEntry): void {
    const look = e.look;
    const key = this.sheetKeyFor(e.kind, e.id, look);
    e.sheetKey = key;
    const owner = look.owner;
    const color = owner === null ? NO_OWNER_COLOR : this.o.owners.color(owner);
    e.mask.tint = color;
    e.placeholder?.destroy();
    e.placeholder = null;
    if (key) {
      e.root.visible = true;
      this.refreshFrame(e);
      if (!this.assets.sheetNow(key)) {
        // 条目不可用（缺失 / guess / 加载失败）：程序化占位块（仍带主人色）
        if (this.assets.settled(key)) e.placeholder = placeholderBlock(e.kind, look.level, color);
        else
          void this.assets.sheet(key).then(() => {
            if (!this.dead && e.sheetKey === key) this.applyLook(e);
          });
        if (e.placeholder) e.root.addChild(e.placeholder);
      }
    } else {
      e.root.visible = false;
      e.body.visible = false;
      e.mask.visible = false;
    }
    // 空地已有主：角色标记
    const showMark = e.kind !== 'company' && look.level <= 0 && owner !== null;
    const markKey = this.skin.buildings.ownerMark;
    const markSheet = showMark && markKey ? this.assets.sheetNow(markKey) : null;
    const ch = owner === null ? null : this.o.owners.character(owner);
    if (markSheet && ch !== null && markSheet.frames[ch]) {
      if (!e.mark) {
        e.mark = new Sprite();
        e.mark.label = `ownerMark:${e.id}`;
        this.o.objects.addChild(e.mark);
      }
      const [ax, ay] = markSheet.anchors[ch] ?? [0, 0];
      e.mark.texture = markSheet.frames[ch]!;
      e.mark.pivot.set(ax, ay);
      this.placeMark(e);
      e.mark.visible = true;
    } else if (showMark && ch !== null) {
      // 标记精灵不可用：程序化小旗（代表色）
      if (!e.mark) {
        e.mark = new Sprite();
        this.o.objects.addChild(e.mark);
      }
      e.mark.visible = false;
      e.placeholder = flagPlaceholder(color);
      e.root.addChild(e.placeholder);
      e.root.visible = true;
    } else if (e.mark) e.mark.visible = false;
  }

  // ───────────────────────── 查询 ─────────────────────────

  tileWorld(id: TileId): Pt | null {
    return this.tiles.get(id) ?? null;
  }

  hasTile(id: TileId): boolean {
    return this.tiles.has(id);
  }

  /** 格（节点）的棋盘坐标（取整） */
  tilePos(id: TileId): Pt | null {
    const w = this.tiles.get(id);
    return w ? this.proj.projectPx(w) : null;
  }

  lotWorld(id: LotId): Pt | null {
    return this.lots.get(id)?.world ?? null;
  }

  lotPos(id: LotId): Pt | null {
    const w = this.lotWorld(id);
    return w ? this.proj.projectPx(w) : null;
  }

  /** 地块上建筑的高度（源像素；飘字抬高用），没有建筑为 0 */
  lotHeight(id: LotId): number {
    const e = this.lots.get(id);
    if (!e?.root.visible || !e.sheetKey) return 0;
    const sheet = this.assets.sheetNow(e.sheetKey);
    return sheet ? (sheet.anchors[e.frame]?.[1] ?? 0) : 24;
  }

  /** 医院 / 监狱建筑（景观）的世界坐标 */
  landmarkWorld(kind: 'hospital' | 'jail'): Pt | null {
    const ids = new Set(this.def.landmarks.filter((l) => l.kind === kind).map((l) => l.id));
    const s = this.skin.scenery.find((x) => x.landmark !== null && ids.has(x.landmark));
    if (s) return s.world;
    const hold = this.def.landmarks.find((l) => l.kind === kind)?.holdTile;
    return hold !== undefined ? this.tileWorld(hold) : null;
  }

  /** 拾取用的建筑精灵包围盒（棋盘坐标） */
  hitBoxes(): SpriteHitBox[] {
    const out: SpriteHitBox[] = [];
    for (const e of this.lots.values()) {
      if (!e.root.visible || !e.body.visible || !e.sheetKey) continue;
      const sheet = this.assets.sheetNow(e.sheetKey);
      if (!sheet) continue;
      const tex = sheet.frames[e.frame];
      if (!tex) continue;
      const [ax, ay] = sheet.anchors[e.frame] ?? [0, 0];
      const frame = e.frame;
      out.push({
        lot: e.id,
        x: e.root.position.x - ax,
        y: e.root.position.y - ay,
        w: tex.frame.width,
        h: tex.frame.height,
        z: e.root.zIndex,
        hit: (lx, ly) => sheet.hit(frame, lx, ly),
      });
    }
    return out;
  }

  /** 建筑节点（弹跳动画用） */
  building(id: LotId): Container | null {
    const e = this.lots.get(id);
    return e?.root.visible ? e.root : null;
  }

  /** 统计（调试与测试） */
  stats(): { ground: number; decor: number; lots: number; buildings: number; scenery: number; marks: number } {
    let buildings = 0;
    let marks = 0;
    for (const e of this.lots.values()) {
      if (e.root.visible) buildings++;
      if (e.mark?.visible) marks++;
    }
    return {
      ground: this.groundSprites.length,
      decor: this.decor.length,
      lots: this.lots.size,
      buildings,
      scenery: this.scenery.filter((s) => s.root.visible).length,
      marks,
    };
  }

  // ───────────────────────── 高亮 ─────────────────────────

  setHighlight(tiles: readonly TileId[]): void {
    this.highlighted = tiles.filter((t) => this.tiles.has(t));
    this.drawTargets();
  }

  select(tile: TileId | null): void {
    this.selected = tile !== null && this.tiles.has(tile) ? tile : null;
    this.drawTargets();
  }

  get highlightedTiles(): readonly TileId[] {
    return this.highlighted;
  }

  private quadAround(w: Pt, half: number): number[] {
    const q = this.proj.quad({ x: w.x - half, y: w.y - half, w: half * 2, h: half * 2 });
    return q.flatMap((p) => [p.x, p.y]);
  }

  private drawTargets(): void {
    const g = this.targets;
    g.clear();
    for (const t of this.highlighted) {
      const w = this.tiles.get(t);
      if (!w) continue;
      g.poly(this.quadAround(w, TILE_HALF), true)
        .fill({ color: 0xfff27a, alpha: 0.28 })
        .stroke({ width: 2, color: 0xffe066, alpha: 0.95 });
    }
    if (this.selected !== null) {
      const w = this.tiles.get(this.selected);
      if (w) g.poly(this.quadAround(w, TILE_HALF + 3), true).stroke({ width: 3, color: 0xffffff, alpha: 1 });
    }
  }

  private drawLotMarks(): void {
    const g = this.lotMarks;
    g.clear();
    for (const e of this.lots.values()) {
      const m = e.look.mark;
      if (!m) continue;
      g.poly(this.quadAround(e.world, LOT_HALF[e.kind]), true)
        .fill({ color: MARK_COLORS[m], alpha: 0.35 })
        .stroke({ width: 2, color: MARK_COLORS[m], alpha: 0.9 });
    }
  }

  private tick(dt: number): void {
    this.t += dt;
    // 涨价 / 查封闪烁（原版相位表未解码：约 0.5 s 一闪）；选中格脉动
    this.lotMarks.alpha = Math.floor(this.t / 480) % 2 === 0 ? 1 : 0.45;
    this.targets.alpha = 0.75 + 0.25 * Math.sin(this.t / 160);
  }

  // ───────────────────────── 动画 ─────────────────────────

  /**
   * 插旗：让地块上已经画着的静态角色标记从上方 height 源像素处落下（原版皮肤不另建副本，免得静态标记与下落副本
   * 叠成两个）。没有可见的静态标记返回 false（调用方另画一个落下的标记）
   */
  async dropOwnerMark(id: LotId, ms: number, signal: AbortSignal, height = 48): Promise<boolean> {
    const e = this.lots.get(id);
    const mark = e?.mark;
    if (this.dead || !e || !mark?.visible) return false;
    try {
      await tweenValue(
        height,
        0,
        ms,
        (v) => {
          if (this.dead || e.mark !== mark) return;
          e.markLift = v;
          this.placeMark(e);
        },
        { clock: this.o.clock, signal, ease: backOut },
      );
    } finally {
      e.markLift = 0;
      if (!this.dead) this.placeMark(e);
    }
    return true;
  }

  /** 角色标记当前的抬高（测试） */
  markLiftOf(id: LotId): number | null {
    const e = this.lots.get(id);
    return e?.mark?.visible ? e.markLift : null;
  }

  /** 建筑长高 / 弹跳（等级变化后） */
  async popBuilding(id: LotId, signal: AbortSignal): Promise<void> {
    const node = this.building(id);
    if (!node) return;
    await tweenValue(
      0.25,
      1,
      POP_MS,
      (y) => {
        if (!node.destroyed) node.scale.set(1, y);
      },
      { clock: this.o.clock, signal, ease: backOut },
    );
    if (!node.destroyed) node.scale.set(1, 1);
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.offFrame();
    for (const e of this.lots.values()) {
      e.mark?.destroy();
      e.root.destroy({ children: true });
    }
    this.lots.clear();
    for (const s of this.scenery) s.root.destroy({ children: true });
    this.scenery.length = 0;
    this.decor.length = 0;
    this.groundRoot.destroy({ children: true });
    this.decorRoot.destroy({ children: true });
    this.lotMarks.destroy();
    this.targets.destroy();
  }
}

/** 建筑精灵不可用时的占位块（等级越高越高；主人色描边） */
function placeholderBlock(kind: LotEntry['kind'], level: number, color: number): Graphics {
  const h = kind === 'company' ? 34 : 10 + 6 * Math.max(1, Math.min(5, level));
  const w = kind === 'land' ? 16 : 28;
  return new Graphics()
    .rect(-w / 2, -h, w, h)
    .fill(0xd8d2c4)
    .stroke({ width: 2, color });
}

/** 角色标记不可用时的小旗 */
function flagPlaceholder(color: number): Graphics {
  return new Graphics().rect(-1, -22, 2, 22).fill(0x3a2a1a).poly([1, -22, 14, -17, 1, -12], true).fill(color);
}
