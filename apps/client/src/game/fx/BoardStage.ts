// M6 / M7 的棋盘舞台（presentation/handlers/stage.ts 的 StagePort 的 Pixi 实现）：
// 路面物件、路上神明、恶人、乞丐与角色状态外观的同步（RoadObjectView + PlayerActor.setStatus；关押 / 住旅馆期间人在
// 医院 / 监狱 / 旅馆里，棋子不画，PlayerActor.setInside），以及各事件的演出原语（爆炸、飞弹 / 核弹、光柱、光束、
// 神明降临与离身、救护车 / 警车、获释时从建筑里跳出来、女巫魔法阵……）。
// 每个阻塞方法的时长都是 timings.ts 里的常数，handler 据此编排、不超预算；中止（signal）时立即落到终态。
import type {
  GodKind,
  GodManifestEffect,
  LotId,
  RoadObject,
  SeatIndex,
  StrikeKind,
  TileId,
  Vehicle,
  VillainKind,
} from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { Container, Graphics, Sprite } from 'pixi.js';
import type {
  ConfineKind,
  ObjectRemoval,
  StagePort,
  WalkOutFrom,
  WalkOutOptions,
} from '../../presentation/handlers/stage';
import type { Anchor } from '../../presentation/types';
import { hotelAt, type Inside, insideOf, statusOf } from '../actors/ActorStatus';
import { figureSvg, GOD_PALETTES } from '../actors/figures';
import { GOD_SCALE, GodSprite } from '../actors/GodSprite';
import { STEP_MS } from '../actors/PlayerActor';
import { escortVehicle } from '../actors/Vehicle';
import { backOut, cubicOut, hopArc, linear, quadInOut } from '../anim/easing';
import type { GameRenderer } from '../GameRenderer';
import { QUALITY_PRESETS } from '../GameRenderer';
import { DepthBias, depthOfCell } from '../iso/depth';
import type { Pt } from '../iso/projection';
import { INK } from '../procedural/building/styles';
import type { FxSystem } from './FxSystem';
import { radial } from './Particles';
import {
  FX_BEAM_MS,
  FX_BEGGAR_MOVE_MS,
  FX_BITE_MS,
  FX_BOMB_ATTACH_MS,
  FX_BOMB_PASS_MS,
  FX_CAST_MS,
  FX_DROP_MS,
  FX_ESCORT_MS,
  FX_FIREWORKS_MS,
  FX_GOD_ARRIVE_MS,
  FX_GOD_LEAVE_MS,
  FX_GOD_POWER_MS,
  FX_GOD_SPAWN_MS,
  FX_MAGIC_MS,
  FX_MANIFEST_MS,
  FX_MISSILE_MS,
  FX_NUKE_MS,
  FX_PILLAR_MS,
  FX_RELEASE_MS,
  FX_REMOVE_MS,
  FX_REWIND_MS,
  FX_TELEPORT_MS,
  FX_VEHICLE_MS,
  FX_WRECK_MS,
  PARTICLE_LIMITS,
} from './timings';

/** 舞台需要的棋盘能力（BoardController 满足） */
export interface StageBoardHost {
  readonly renderer: GameRenderer;
  anchorPos(at: Anchor, lift?: boolean): Pt | null;
}

export function isStageHost(x: unknown): x is StageBoardHost {
  if (!x || typeof x !== 'object') return false;
  const h = x as Partial<StageBoardHost>;
  return typeof h.anchorPos === 'function' && typeof h.renderer === 'object' && h.renderer !== null;
}

/** 原版世界像素（范围半宽）→ 屏幕像素：台湾图约 48 像素一格，等角一格对角约 90 像素 */
export function strikeRadiusPx(half: number): number {
  return Math.max(120, (Math.max(0, half) / 48) * 90);
}

/** 渲染器画质档的粒子上限（GameRenderer.particleLimit；测试替身没有时按帧率推断） */
function particleLimitOf(r: GameRenderer): number {
  const q = (r as Partial<Pick<GameRenderer, 'particleLimit'>>).particleLimit;
  if (typeof q === 'number') return q;
  const fps = r.app?.ticker?.maxFPS ?? 60;
  if (fps > 0 && fps <= QUALITY_PRESETS.low.fps) return PARTICLE_LIMITS.low;
  return PARTICLE_LIMITS.high;
}

export class BoardStage implements StagePort {
  private dead = false;
  /** 本回合获释、还没走出来的人（holdInside）：同步时留在建筑里 */
  private readonly held = new Set<SeatIndex>();

  /** 从 BoardController（或同形对象）创建；不满足条件返回 null */
  static fromHost(host: unknown, fx: FxSystem): BoardStage | null {
    if (!isStageHost(host)) return null;
    return new BoardStage(host, fx);
  }

  constructor(
    private readonly host: StageBoardHost,
    private readonly fx: FxSystem,
  ) {
    const r = host.renderer;
    if (r.layers?.screenFx && r.app) {
      fx.attachScreen(r.layers.screenFx, () => ({ width: r.app.screen.width, height: r.app.screen.height }));
    }
    if (r.app) fx.setParticleLimit(particleLimitOf(r));
  }

  get destroyed(): boolean {
    return this.dead || this.host.renderer.board === undefined;
  }

  get ready(): boolean {
    return !this.dead && this.host.renderer.board?.loaded === true;
  }

  private get board() {
    return this.host.renderer.board;
  }

  private get clock() {
    return this.host.renderer.clock;
  }

  private pos(at: Anchor, lift = false): Pt | null {
    if (!this.ready) return null;
    return this.host.anchorPos(at, lift);
  }

  private tilePos(node: TileId): Pt | null {
    return this.ready ? this.board.roads.tilePos(node) : null;
  }

  private actor(seat: SeatIndex) {
    return this.ready ? this.board.actor(seat) : undefined;
  }

  private shake(amp: number, ms: number): void {
    this.host.renderer.camera?.shake(amp, ms);
  }

  // ───────────────────────── 同步 ─────────────────────────

  syncWorld(view: GameView): void {
    if (!this.ready) return;
    this.board.roads.sync(view);
    const def = this.board.def;
    for (const p of view.players) {
      const a = this.board.actor(p.seat);
      if (!a) continue;
      const s = statusOf(p, view);
      a.exhaust ??= (pt) => this.puff(pt);
      a.setStatus(s);
      if (this.held.has(p.seat)) continue;
      // 关押 / 住旅馆：人在医院 / 监狱 / 旅馆里，棋子不画（找不到建筑时停在原格、同样不画）
      const inside = p.placed && p.node > 0 ? insideOf(s, p.node, (n) => hotelAt(n, def, view)) : null;
      a.setInside(inside ? (this.insideCell(inside) ?? this.tileCenter(p.node)) : null);
    }
    this.board.spreadActors();
  }

  /** 建筑中心的逻辑坐标（医院 / 监狱景观、旅馆地块；停在原格的为 null） */
  private insideCell(b: Inside): Pt | null {
    if (b.t === 'landmark') return this.board.landmarkCell(b.kind);
    return b.t === 'lot' ? this.board.lotCell(b.lot) : null;
  }

  private tileCenter(node: TileId): Pt | null {
    if (!this.board.geometry.hasTile(node)) return null;
    const c = this.board.geometry.tileCell(node);
    return { x: c.x + 0.5, y: c.y + 0.5 };
  }

  /** 排气小烟团 */
  private puff(at: Pt): void {
    this.fx.particles.emit([
      { x: at.x, y: at.y, vx: 0, vy: -24, life: 520, size: 10, color: 0xd8dce6, shape: 'smoke', endScale: 2.2 },
    ]);
  }

  clear(): void {
    // 演出节点都登记在 Fx 里（BoardPort.clearFx → fx.clear 已清）；这里只清本回合获释的留置
    this.held.clear();
  }

  holdInside(seat: SeatIndex | null): void {
    if (seat === null) this.held.clear();
    else this.held.add(seat);
  }

  dispose(): void {
    this.dead = true;
  }

  // ───────────────────────── 路面物件 ─────────────────────────

  async dropObject(obj: RoadObject, signal: AbortSignal): Promise<void> {
    if (!this.ready) return;
    const root = this.board.roads.addObject(obj);
    if (!root) return;
    const p = this.tilePos(obj.node);
    await this.fx.tween(
      FX_DROP_MS,
      (v) => {
        if (root.destroyed) return;
        root.pivot.y = 140 * (1 - v);
        root.scale.set(1, v < 0.85 ? 1 : 1 - 0.12 * Math.sin(((v - 0.85) / 0.15) * Math.PI));
      },
      signal,
      backOut,
    );
    if (!root.destroyed) {
      root.pivot.y = 0;
      root.scale.set(1);
    }
    if (p) this.fx.sparkles(p, 0xd8c8a8, 8);
  }

  async removeObject(obj: RoadObject, how: ObjectRemoval, signal: AbortSignal): Promise<void> {
    if (!this.ready) return;
    const root = this.board.roads.detachObject(obj.id);
    const p = this.tilePos(obj.node);
    if (how === 'boom' && p) void this.fx.explosion(p, 'small', signal);
    if (!root) {
      await this.fx.wait(FX_REMOVE_MS, signal);
      return;
    }
    const k = this.fx.track(root, this.fx.fxLayer, signal);
    const x0 = root.position.x;
    const y0 = root.position.y;
    await this.fx.tween(
      FX_REMOVE_MS,
      (v) => {
        if (root.destroyed) return;
        switch (how) {
          case 'burst':
            root.position.set(x0 + 90 * v, y0 - 160 * hopArc(v * 0.5 + 0.1) - 60 * v);
            root.rotation = v * 6;
            root.alpha = 1 - v;
            break;
          case 'pickup':
            root.position.set(x0, y0 - 50 * cubicOut(v));
            root.scale.set(1 - 0.7 * v);
            root.alpha = 1 - v;
            break;
          default:
            root.scale.set(1 + 0.3 * v);
            root.alpha = 1 - v;
        }
      },
      k.signal,
    );
    k.done();
  }

  async dollWalk(path: readonly TileId[], cleared: readonly number[], signal: AbortSignal): Promise<void> {
    if (!this.ready || path.length === 0) return;
    const roads = this.board.roads;
    const pts = path.map((t) => roads.tilePos(t));
    if (pts.some((x) => x === null)) {
      await this.fx.wait(path.length * STEP_MS, signal);
      return;
    }
    const clearAt = new Map<TileId, RoadObject[]>();
    for (const id of cleared) {
      const o = roads.objectOf(id);
      if (!o) continue;
      const list = clearAt.get(o.node) ?? [];
      list.push(o);
      clearAt.set(o.node, list);
    }
    const doll = robotDoll();
    const k = this.fx.track(doll, this.objectsLayer(), signal);
    const steps = Math.max(1, path.length - 1);
    let reached = 0;
    const visit = (i: number): void => {
      const tile = path[i]!;
      for (const o of clearAt.get(tile) ?? []) void this.removeObject(o, 'burst', signal);
      clearAt.delete(tile);
    };
    visit(0);
    await this.fx.tween(
      steps * STEP_MS,
      (v) => {
        if (doll.destroyed) return;
        const x = v * steps;
        const i = Math.min(steps - 1, Math.floor(x));
        const t = x - i;
        const a = pts[i]!;
        const b = pts[Math.min(pts.length - 1, i + 1)]!;
        doll.position.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t - 10 * hopArc(t));
        doll.scale.x = b.x >= a.x ? 1 : -1;
        const cell = this.board.geometry.tileCell(t < 0.5 ? path[i]! : path[Math.min(path.length - 1, i + 1)]!);
        doll.zIndex = depthOfCell(this.board.geometry.viewCell(cell), DepthBias.Actor);
        while (reached < Math.min(path.length - 1, Math.floor(x + 0.5))) visit(++reached);
      },
      k.signal,
      linear,
    );
    while (reached < path.length - 1) visit(++reached);
    const end = pts[pts.length - 1]!;
    this.fx.sparkles(end, 0xbfe8ff, 10);
    k.done();
  }

  private objectsLayer(): Container {
    return this.host.renderer.layers.objects;
  }

  // ───────────────────────── 特效 ─────────────────────────

  async explode(at: Anchor, size: 'small' | 'big', signal: AbortSignal): Promise<void> {
    const p = this.pos(at);
    if (!p) return;
    this.shake(size === 'big' ? 12 : 7, 420);
    await this.fx.explosion(p, size, signal);
  }

  async strike(kind: StrikeKind, center: TileId, half: number, signal: AbortSignal): Promise<void> {
    const p = this.tilePos(center);
    if (!p) return;
    const r = strikeRadiusPx(half);
    if (kind === 'nuke') {
      const run = this.fx.nuke(p, r, signal);
      void this.fx.wait(FX_NUKE_MS - 1250, signal).then(() => {
        if (!signal.aborted) this.shake(22, 900);
      });
      await run;
      return;
    }
    if (kind === 'typhoon') {
      this.shake(8, FX_MISSILE_MS * 0.8);
      await Promise.all([
        this.fx.magicCircle(p, 0x9aa0ae, FX_MISSILE_MS, signal),
        this.fx.shockwave(p, r, 0xbfc5cf, FX_MISSILE_MS * 0.9, signal),
      ]);
      return;
    }
    if (kind === 'alien') {
      await this.fx.lightPillar(p, 0x5cc85a, FX_PILLAR_MS, signal);
      this.shake(10, 500);
      await Promise.all([
        this.fx.explosion(p, 'big', signal),
        this.fx.wait(Math.max(0, FX_MISSILE_MS - FX_PILLAR_MS), signal),
      ]);
      return;
    }
    const run = this.fx.missile(p, r, signal);
    void this.fx.wait(520, signal).then(() => {
      if (!signal.aborted) this.shake(14, 600);
    });
    await run;
  }

  pillar(at: Anchor, color: number, signal: AbortSignal): Promise<void> {
    const p = this.pos(at);
    return p ? this.fx.lightPillar(p, color, FX_PILLAR_MS, signal) : Promise.resolve();
  }

  beam(from: Anchor, to: Anchor, color: number, signal: AbortSignal): Promise<void> {
    const a = this.pos(from);
    const b = this.pos(to);
    return a && b ? this.fx.beam(a, b, color, FX_BEAM_MS, signal) : Promise.resolve();
  }

  flash(color: number, ms: number): void {
    if (this.ready) this.fx.screenFlash(color, ms);
  }

  rewind(signal: AbortSignal): Promise<void> {
    if (!this.ready) return Promise.resolve();
    return this.fx.rewind(FX_REWIND_MS, this.host.renderer.layers.world, signal);
  }

  burst(at: Anchor, color: number, count = 14): void {
    const p = this.pos(at, true);
    if (p) this.fx.sparkles(p, color, count);
  }

  bubble(at: Anchor, text: string, ms: number): void {
    const p = this.pos(at, true);
    if (p) this.fx.bubble({ x: p.x, y: p.y - 18 }, text, ms);
  }

  async teleport(from: Anchor, to: Anchor, signal: AbortSignal): Promise<void> {
    const a = this.pos(from);
    const b = this.pos(to);
    const half = FX_TELEPORT_MS / 2;
    if (a) await this.fx.lightPillar(a, 0x9b6bff, half, signal);
    else await this.fx.wait(half, signal);
    if (b) await this.fx.lightPillar(b, 0x9b6bff, half, signal);
    else await this.fx.wait(half, signal);
  }

  async cast(seat: SeatIndex, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a) return;
    a.setPose('cast');
    this.fx.sparkles(a.headPos(), 0xffe066, 10);
    await this.fx.wait(FX_CAST_MS, signal);
    if (!a.destroyed) a.setPose('idle0');
  }

  fireworks(): void {
    if (this.ready) this.fx.fireworks(FX_FIREWORKS_MS);
  }

  // ───────────────────────── 神明 ─────────────────────────

  async godSpawn(kind: GodKind, node: TileId, signal: AbortSignal): Promise<void> {
    if (!this.ready) return;
    const sprite = this.board.roads.addGod(kind, node);
    const p = this.tilePos(node);
    if (!sprite || !p) return;
    this.fx.sparkles({ x: p.x, y: p.y - 30 }, GOD_PALETTES[kind].aura, 12);
    await this.fx.tween(FX_GOD_SPAWN_MS, (v) => sprite.setScale(v), signal, backOut);
    sprite.setScale(1);
  }

  async godArrive(seat: SeatIndex, kind: GodKind, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a || a.tile === null) return;
    const pal = GOD_PALETTES[kind];
    const head = a.headPos();
    const pillar = this.fx.lightPillar(a.screenPos(), pal.aura, FX_PILLAR_MS, signal);
    const road = this.board.roads.detachGod(kind, a.tile);
    const sprite = road ?? new GodSprite(kind, this.clock, this.board.roads.figures, 'road');
    const k = this.fx.track(sprite.root, this.fx.overlay, signal);
    const from = road ? { x: sprite.root.position.x, y: sprite.root.position.y } : { x: head.x, y: head.y - 220 };
    const end = GOD_SCALE.attached / GOD_SCALE.road;
    const fly = FX_GOD_ARRIVE_MS * 0.7;
    await this.fx.tween(
      fly,
      (v) => {
        if (sprite.destroyed) return;
        sprite.root.position.set(from.x + (head.x - from.x) * v, from.y + (head.y - from.y) * v - 60 * hopArc(v));
        sprite.setScale(1 + (end - 1) * v);
      },
      k.signal,
      quadInOut,
    );
    k.done();
    sprite.destroy();
    if (!a.destroyed) a.setGod(kind);
    this.fx.sparkles(head, pal.aura, 12);
    await Promise.all([pillar, this.fx.wait(FX_GOD_ARRIVE_MS - fly, signal)]);
  }

  async godLeave(seat: SeatIndex | null, kind: GodKind, signal: AbortSignal): Promise<void> {
    if (!this.ready) return;
    let sprite: GodSprite | null = null;
    let from: Pt | null = null;
    if (seat !== null) {
      const a = this.actor(seat);
      if (a) {
        from = a.headPos();
        sprite = a.takeGod();
      }
    } else {
      sprite = this.board.roads.detachGod(kind);
      if (sprite) from = { x: sprite.root.position.x, y: sprite.root.position.y };
    }
    if (!sprite || !from) {
      await this.fx.wait(FX_GOD_LEAVE_MS, signal);
      return;
    }
    const s = sprite;
    const p0 = from;
    const k = this.fx.track(s.root, this.fx.overlay, signal);
    s.root.position.set(p0.x, p0.y);
    await this.fx.tween(
      FX_GOD_LEAVE_MS,
      (v) => {
        if (s.destroyed) return;
        s.root.position.set(p0.x + 20 * Math.sin(v * 12), p0.y - 180 * cubicOut(v));
        s.root.rotation = v * Math.PI * 4;
        s.root.alpha = 1 - v * v;
      },
      k.signal,
    );
    k.done();
    s.destroy();
  }

  async godPower(seat: SeatIndex, kind: GodKind, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a) return;
    const pal = GOD_PALETTES[kind];
    a.setPose(pal.good ? 'cheer' : 'hurt');
    const p = a.screenPos();
    this.fx.sparkles(a.headPos(), pal.aura, 18);
    await this.fx.shockwave(p, 110, pal.aura, FX_GOD_POWER_MS, signal);
    if (!a.destroyed) a.setPose('idle0');
  }

  async manifest(kind: GodKind, lotAt: Anchor, effect: GodManifestEffect, signal: AbortSignal): Promise<void> {
    const p = this.pos(lotAt);
    if (!p) return;
    const pal = GOD_PALETTES[kind];
    const color = effect === 'levelUp' ? 0xffd84d : effect === 'levelDown' ? 0x8e78c0 : pal.aura;
    await this.fx.lightPillar(p, color, FX_PILLAR_MS, signal);
    if (effect === 'levelDown') {
      this.shake(6, 300);
      this.fx.particles.emit(
        radial(p.x, p.y - 10, 12, {
          speed: [80, 180],
          life: [300, 600],
          size: [5, 9],
          colors: [0x8a5a2b, 0x6e6a7e],
          shape: 'square',
          gravity: 500,
        }),
      );
    } else {
      this.fx.sparkles({ x: p.x, y: p.y - 40 }, color, 16);
    }
    await this.fx.wait(FX_MANIFEST_MS - FX_PILLAR_MS, signal);
  }

  async dogBite(seat: SeatIndex, node: TileId, knocked: boolean, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    const p = this.tilePos(node);
    if (!a || !p) return;
    const dog = this.board.roads.detachGod(11, node) ?? new GodSprite(11, this.clock, this.board.roads.figures, 'road');
    const k = this.fx.track(dog.root, this.objectsLayer(), signal);
    const home = { x: p.x + 34, y: p.y + 10 };
    dog.root.zIndex = (a.root.zIndex ?? 0) + 0.5;
    const target = a.screenPos();
    if (!knocked) a.setPose('hurt');
    await this.fx.tween(
      FX_BITE_MS,
      (v) => {
        if (dog.destroyed) return;
        if (knocked) {
          // 被撞飞：先扑过来，再被弹开
          const t = v < 0.4 ? v / 0.4 : 1;
          const fly = v < 0.4 ? 0 : (v - 0.4) / 0.6;
          dog.root.position.set(
            home.x + (target.x - home.x) * 0.6 * t + 160 * fly,
            home.y + (target.y - home.y) * 0.6 * t - 140 * hopArc(fly * 0.5),
          );
          dog.root.rotation = fly * 8;
          dog.root.alpha = 1 - fly;
        } else {
          const lunge = hopArc(Math.min(1, v * 1.6));
          dog.root.position.set(home.x + (target.x - home.x) * 0.7 * lunge, home.y + (target.y - home.y) * 0.7 * lunge);
          if (v > 0.3 && v < 0.35) this.fx.sparkles(a.headPos(), 0xf2545b, 8);
        }
      },
      k.signal,
    );
    k.done();
    dog.destroy();
    // 咬完恶犬仍守在原地（被撞开时由之后的同步按新位置放回）
    if (!knocked) this.board.roads.addGod(11, node);
    if (!a.destroyed) a.setPose('idle0');
  }

  // ───────────────────────── 角色 ─────────────────────────

  async escort(seat: SeatIndex, where: ConfineKind, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a?.root.visible) return;
    const p = a.screenPos();
    const dest = this.board.landmarkScreenPos(where) ?? { x: p.x + 200, y: p.y - 100 };
    const car = escortVehicle(where === 'jail' ? 'police' : 'ambulance');
    const k = this.fx.track(car.root, this.fx.fxLayer, signal);
    const start = { x: p.x - 300, y: p.y + 150 };
    let picked = false;
    try {
      await this.fx.tween(
        FX_ESCORT_MS,
        (v) => {
          if (car.root.destroyed) return;
          const blink = Math.floor(v * 16) % 2 === 0;
          car.lights[0]!.alpha = blink ? 1 : 0.3;
          car.lights[1]!.alpha = blink ? 0.3 : 1;
          if (v < 0.4) {
            const t = cubicOut(v / 0.4);
            car.root.position.set(start.x + (p.x - start.x) * t, start.y + (p.y - start.y) * t + 6);
            car.root.scale.x = p.x >= start.x ? 1 : -1;
          } else if (v < 0.55) {
            car.root.position.set(p.x, p.y + 6);
            if (!picked) {
              picked = true;
              this.fx.sparkles(a.headPos(), 0xffffff, 8);
            }
            a.root.alpha = 1 - (v - 0.4) / 0.15;
          } else {
            a.root.alpha = 0;
            const t = (v - 0.55) / 0.45;
            car.root.position.set(p.x + (dest.x - p.x) * t * t, p.y + 6 + (dest.y - p.y) * t * t);
            car.root.scale.x = dest.x >= p.x ? 1 : -1;
            car.root.alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
          }
        },
        k.signal,
      );
    } finally {
      k.done();
      // 关押外观（窗口气泡）由之后的同步给出；这里恢复本体透明度
      if (!a.destroyed) a.root.alpha = 1;
    }
  }

  async release(seat: SeatIndex, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a) return;
    this.fx.sparkles(a.headPos(), 0xfff3b0, 14);
    await this.fx.shockwave(a.screenPos(), 70, 0xffffff, FX_RELEASE_MS, signal);
  }

  /** 获释：从医院 / 监狱 / 旅馆里跳着走到所在的格（前半程看不见，出现时冒一小把星光），停在格上 */
  async walkOut(seat: SeatIndex, _from: WalkOutFrom, o: WalkOutOptions, signal: AbortSignal): Promise<void> {
    this.held.delete(seat);
    const a = this.actor(seat);
    if (!a || a.tile === null) {
      o.onShow?.();
      return;
    }
    await a.walkOut(a.tile, {
      stepMs: STEP_MS,
      signal,
      onShow: () => {
        if (!signal.aborted && !a.destroyed) this.fx.sparkles(a.headPos(), 0xfff3b0, 10);
        o.onShow?.();
      },
    });
    this.board.spreadActors();
  }

  /** 住旅馆：从门前的格跳着走进旅馆，过半后看不见 */
  async walkIn(seat: SeatIndex, lot: LotId, _o: WalkOutOptions, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    const c = this.ready ? this.board.lotCell(lot) : null;
    if (!a || !c) return;
    await a.walkIn(c, { stepMs: STEP_MS, signal });
    this.board.spreadActors();
  }

  async vehicle(seat: SeatIndex, v: Vehicle, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a) return;
    a.setStatus({ ...a.currentStatus, vehicle: v });
    this.fx.sparkles(a.screenPos(), 0xffd84d, 12);
    await Promise.all([a.hop(signal), this.fx.wait(FX_VEHICLE_MS, signal)]);
  }

  async wreck(seat: SeatIndex, _v: Vehicle, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a) return;
    const p = a.screenPos();
    a.setPose('hurt');
    this.fx.particles.emit(
      radial(p.x, p.y - 8, 12, {
        speed: [100, 240],
        life: [400, 700],
        size: [5, 10],
        colors: [0x8a8f99, 0x2a2a2a, 0xf2545b],
        shape: 'square',
        gravity: 600,
        spin: 8,
      }),
    );
    this.fx.particles.emit(
      radial(p.x, p.y - 20, 6, {
        speed: [10, 40],
        life: [500, 800],
        size: [16, 26],
        colors: [0x6e6a7e],
        shape: 'smoke',
        gravity: -60,
        endScale: 2,
      }),
    );
    this.shake(5, 250);
    await this.fx.wait(FX_WRECK_MS, signal);
    if (!a.destroyed) {
      a.setStatus({ ...a.currentStatus, vehicle: 'walk' });
      a.setPose('idle0');
    }
  }

  async bombAttach(seat: SeatIndex, fuse: number, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a) return;
    const head = a.headPos();
    const b = bombShape();
    const k = this.fx.track(b, this.fx.overlay, signal);
    await this.fx.tween(
      FX_BOMB_ATTACH_MS,
      (v) => {
        if (!b.destroyed) b.position.set(head.x - 24, head.y - 160 * (1 - v));
      },
      k.signal,
      backOut,
    );
    k.done();
    if (!a.destroyed) a.setStatus({ ...a.currentStatus, bomb: fuse });
  }

  async bombPass(from: SeatIndex, to: SeatIndex, fuse: number, signal: AbortSignal): Promise<void> {
    const a = this.actor(from);
    const b = this.actor(to);
    if (!a || !b) return;
    const p0 = a.headPos();
    const p1 = b.headPos();
    a.setStatus({ ...a.currentStatus, bomb: null });
    const g = bombShape();
    const k = this.fx.track(g, this.fx.overlay, signal);
    await this.fx.tween(
      FX_BOMB_PASS_MS,
      (v) => {
        if (g.destroyed) return;
        g.position.set(p0.x + (p1.x - p0.x) * v - 24, p0.y + (p1.y - p0.y) * v - 120 * hopArc(v));
        g.rotation = v * 8;
      },
      k.signal,
    );
    k.done();
    if (!b.destroyed) b.setStatus({ ...b.currentStatus, bomb: fuse });
  }

  async magic(caster: SeatIndex, targets: readonly SeatIndex[], signal: AbortSignal): Promise<void> {
    const a = this.actor(caster);
    if (!a) return;
    const p = a.screenPos();
    const witch = new Container({ label: 'witch' });
    const sprite = new Sprite();
    sprite.anchor.set(0.5, 150 / 160);
    sprite.scale.set(0.62);
    const ph = new Graphics()
      .poly([-18, 0, 0, -64, 18, 0], true)
      .fill(0x6a3fa0)
      .stroke({ width: 3, color: INK })
      .circle(0, -70, 14)
      .fill(0xe8f0d0)
      .stroke({ width: 3, color: INK });
    witch.addChild(ph, sprite);
    const figures = this.board.roads.figures;
    if (figures) {
      void figures
        .texture('npc:witch:cast', () => figureSvg('npc:witch', 'cast'))
        .then((t) => {
          if (!t || sprite.destroyed) return;
          sprite.texture = t;
          ph.visible = false;
        });
    }
    witch.position.set(p.x + 56, p.y + 6);
    const k = this.fx.track(witch, this.fx.overlay, signal);
    let sparks = 0;
    const circles = targets.map((s) => {
      const t = this.actor(s);
      return t ? this.fx.magicCircle(t.screenPos(), 0x9b6bff, FX_MAGIC_MS * 0.8, signal) : Promise.resolve();
    });
    await this.fx.tween(
      FX_MAGIC_MS,
      (v) => {
        if (witch.destroyed) return;
        witch.alpha = v < 0.15 ? v / 0.15 : v > 0.85 ? (1 - v) / 0.15 : 1;
        witch.rotation = Math.sin(v * Math.PI * 6) * 0.06;
        if (v * 8 >= sparks + 1) {
          sparks++;
          this.fx.sparkles({ x: p.x + 70, y: p.y - 60 }, 0xffe066, 4);
        }
      },
      k.signal,
    );
    k.done();
    await Promise.all(circles);
  }

  async beggarMove(seat: SeatIndex, node: TileId, signal: AbortSignal): Promise<void> {
    if (!this.ready) return;
    const m = this.board.roads.moveBeggar(seat, node);
    if (!m) return;
    await this.fx.tween(
      FX_BEGGAR_MOVE_MS,
      (v) => {
        if (m.root.destroyed) return;
        m.root.position.set(m.from.x + (m.to.x - m.from.x) * v, m.from.y + (m.to.y - m.from.y) * v - 30 * hopArc(v));
      },
      signal,
    );
    m.settle();
  }

  // ───────────────────────── 恶人 ─────────────────────────

  async walkVillain(kind: VillainKind, path: readonly TileId[], signal: AbortSignal): Promise<void> {
    if (!this.ready || path.length === 0) return;
    const a = this.board.roads.ensureVillain(kind, path[0]!);
    if (!a) return;
    await a.walk(path, { stepMs: STEP_MS, signal });
  }

  villainAnchor(kind: VillainKind): Anchor | null {
    if (!this.ready) return null;
    const node = this.board.roads.villainNode(kind);
    return node === null ? null : { tile: node };
  }
}

/** 机器娃娃：小机器人（方头 + 天线 + 履带） */
function robotDoll(): Container {
  const c = new Container({ label: 'robotDoll' });
  const g = new Graphics();
  g.ellipse(0, 2, 16, 6).fill({ color: 0x000000, alpha: 0.2 });
  g.roundRect(-12, -10, 24, 10, 4).fill(0x5a5a5a).stroke({ width: 2.5, color: INK });
  g.roundRect(-11, -30, 22, 20, 5).fill(0xbfc5cf).stroke({ width: 3, color: INK });
  g.roundRect(-9, -48, 18, 16, 4).fill(0xd8dce6).stroke({ width: 3, color: INK });
  g.circle(-4, -40, 2.5).fill(0x3d8bfd);
  g.circle(4, -40, 2.5).fill(0x3d8bfd);
  g.moveTo(0, -48).lineTo(0, -56).stroke({ width: 2, color: INK });
  g.circle(0, -58, 3).fill(0xf2545b).stroke({ width: 1.5, color: INK });
  c.addChild(g);
  return c;
}

/** 飞行中的炸弹（与头顶炸弹同款） */
function bombShape(): Graphics {
  const g = new Graphics();
  g.circle(0, 0, 11).fill(0x2a2a2a).stroke({ width: 3, color: INK });
  g.circle(-4, -4, 3).fill(0x8a8f99);
  g.moveTo(0, -11).quadraticCurveTo(6, -20, 10, -16).stroke({ width: 2, color: 0x8a5a2b });
  g.circle(10, -17, 3).fill(0xffd84d);
  return g;
}
