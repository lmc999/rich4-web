// 原版棋盘舞台（original-skin.md §3 修正 1/2、§5 A8；design-draft §3.4–§3.5）：presentation/handlers 的 StagePort 的原版实现，
// 与程序化 BoardStage 同一接口（不委托 BoardStage）。
// - syncWorld：路面物件、路上神明、乞丐、四大恶人（OrigRoads）与角色状态外观（关押姿态、附身神明、身上炸弹、载具、梦游……），
//   按视角同步，朝向缺失时用确定性默认（OrigRoads / poses）；
// - 有原版 FLIC 的演出用 skin/flic 播放器（OrigFlics）：神明降临、离身烟雾、警车 / 救护车、爆炸、飞弹 / 核弹 / 外星人 / 台风、
//   卡片格得卡、点券格得点券、节日烟火 / 圣诞、破产、终局烟火、开局棋盘伞（OrigActor.drop）。位置与摆放按 flic-map；
//   可用时长 = 当前节奏的事件预算 − handler 内其他等待（flicPlan.ts、fx/timings 的 ORIG_FLIC_WAITS），original 节奏下原速播完，
//   compact 节奏下 playFit 加速或截取；FLIC 同步音效经 ctx.audio 播放（stageAudio.ts，导演层 flicSfx 置 true 避免重复）；
// - 有原版精灵的演出用原版精灵：物件落下、神明现身、恶犬扑咬、换车 / 车毁、炸弹贴上 / 转移、机器娃娃清道（npc.doll）、
//   乞丐挪窝、恶人行走；
// - 没有原版对应物的（光柱、光束、闪屏、倒带、传送、施放、神明发威 / 显灵、出狱、女巫魔法阵）用 FxSystem 原语；
// - FLIC 条目缺失或载入失败时按方法回退到 FxSystem 原语（时长为 fx/timings 的常数，与 OrigStage-lite 相同）。
// 每个方法的实现方式登记在 ORIG_STAGE_IMPL（coverage 测试断言每个 StagePort 方法都有原版实现或显式 FxSystem 回退）。
import type { MapDef } from '@rich4/shared/data';
import type {
  GameEvent,
  GodKind,
  GodManifestEffect,
  RoadObject,
  SeatIndex,
  StrikeKind,
  TileId,
  Vehicle,
  VillainKind,
} from '@rich4/shared/engine';
import { type GameView, ORIGINAL_FLICS, STEP_MS } from '@rich4/shared/view';
import type { Container } from 'pixi.js';
import type { SfxCue } from '../../../audio/cues';
import { budgetMs } from '../../../presentation/handlers/budget';
import type { ConfineKind, ObjectRemoval, StageEventContext, StagePort } from '../../../presentation/handlers/stage';
import type { Anchor, AudioPort } from '../../../presentation/types';
import { type ActorStatus, statusOf } from '../../actors/ActorStatus';
import { GOD_PALETTES } from '../../actors/godPalettes';
import { backOut, cubicOut, hopArc, linear, quadInOut } from '../../anim/easing';
import type { RoadWorld } from '../../board/RoadObjectView';
import type { FxSystem } from '../../fx/FxSystem';
import {
  FX_BEAM_MS,
  FX_BEGGAR_MOVE_MS,
  FX_BITE_MS,
  FX_BOMB_ATTACH_MS,
  FX_BOMB_PASS_MS,
  FX_CAST_MS,
  FX_DROP_MS,
  FX_ESCORT_MS,
  FX_EXPLODE_MS,
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
  ORIG_FLIC_SLACK_MS,
  ORIG_FLIC_WAITS,
} from '../../fx/timings';
import type { Pt } from '../../iso/projection';
import {
  type EventFlic,
  eventFlicOf,
  flicAvailMs,
  godArrivalUse,
  isOrigFlicEvent,
  type OrigFlicEvent,
  strikeFlic,
} from './flicPlan';
import type { FlicOutcome, FlicRef, OrigFlicPort } from './OrigFlics';
import { type FlicSfxSwitch, flicCoveredCue } from './stageAudio';

// ───────────────────────── 宿主（OrigBoardController 满足；测试可换替身） ─────────────────────────

/** 舞台用到的棋子能力（OrigActor 满足） */
export interface OrigStageActor {
  readonly root: Container;
  readonly tile: TileId | null;
  readonly destroyed: boolean;
  readonly currentStatus: ActorStatus;
  /** 脚底的棋盘坐标 */
  boardPos(): Pt;
  /** 头顶的棋盘坐标 */
  headPos(): Pt;
  setStatus(s: ActorStatus): void;
  setGod(kind: GodKind | null): void;
  hop(signal?: AbortSignal): Promise<void>;
}

/** 会走路的原版棋子（恶人、机器娃娃；OrigActor 满足） */
export interface OrigStageWalker {
  readonly root: Container;
  walk(
    path: readonly TileId[],
    o?: { stepMs?: number; signal?: AbortSignal; onStep?: (tile: TileId, i: number) => void },
  ): Promise<void>;
  destroy(): void;
}

/** 舞台用到的路面层能力（OrigRoads 满足） */
export interface OrigStageRoads {
  sync(w: RoadWorld): void;
  addObject(obj: RoadObject): Container | null;
  detachObject(id: number): Container | null;
  objectOf(id: number): RoadObject | undefined;
  addGod(kind: GodKind, node: TileId): Container | null;
  detachGod(kind: GodKind, near?: TileId): Container | null;
  moveBeggar(seat: number, node: TileId): { root: Container; from: Pt; to: Pt; settle: () => void } | null;
  ensureVillain(kind: VillainKind, node: TileId): OrigStageWalker | null;
  villainNode(kind: VillainKind): TileId | null;
}

/** 舞台需要的棋盘能力（OrigBoardController 满足） */
export interface OrigStageHost {
  readonly ready: boolean;
  readonly roads: OrigStageRoads;
  actor(seat: SeatIndex): OrigStageActor | undefined;
  anchorPos(at: Anchor, lift?: boolean): Pt | null;
  tilePos(node: TileId): Pt | null;
  shake(amp: number, ms: number): void;
  /** world 容器（倒带滤镜） */
  readonly world: Container | null;
  /** 镜头中心（棋盘坐标；节日烟火、终局烟火的落点） */
  viewCenter(): Pt | null;
  /** 当前地图（节日表） */
  readonly mapDef: Pick<MapDef, 'holidays'> | null;
  /** 座位 → 角色号 */
  characterOf(seat: SeatIndex): number | null;
  /** 机器娃娃（原版 npc.doll，放在 node）；棋盘未就绪为 null */
  spawnDoll(node: TileId): OrigStageWalker | null;
  /** 原版物件精灵（锚点在原点，挂到 overlay 之前不在场景里）；素材不可用为 null */
  objectSprite(key: string): Container | null;
}

export interface OrigStageOptions {
  /** 原版 FLIC（没有素材包或不支持 FLIC 时为 null：全部走 FxSystem 回退） */
  flics?: OrigFlicPort | null;
  /** 音频导演层的 flicSfx 开关（缺省不接：单测、没有音频时） */
  flicSfx?: FlicSfxSwitch | null;
}

/** 原版世界像素（范围半宽）→ 棋盘像素：一格 32 世界像素约 39 源像素 */
export function origStrikeRadius(half: number): number {
  return Math.max(48, Math.max(0, half) * 1.2);
}

/** 附身神明的大致中心（相对脚底；原版附身偏移 (−10, −22) 为神明脚底） */
const GOD_CENTER: Pt = { x: -10, y: -34 };
/** 路上神明精灵的中心（相对脚底） */
const ROAD_GOD_CENTER_Y = -13;
/** 飞弹 / 核弹 / 外星人 / 台风 FLIC 的冲击时刻（播放进度）与震屏幅度 */
const STRIKE_IMPACT: Readonly<Record<StrikeKind, { at: number; amp: number; ms: number }>> = {
  missile: { at: 0.45, amp: 10, ms: 600 },
  nuke: { at: 0.35, amp: 14, ms: 900 },
  alien: { at: 0.55, amp: 10, ms: 600 },
  typhoon: { at: 0, amp: 5, ms: 900 },
  bomb3x3: { at: 0, amp: 8, ms: 500 },
};
/** 警车 / 救护车把人接走的时刻（播放进度） */
const ESCORT_PICKUP = 0.5;

/** 当前事件（beginEvent 记下） */
interface EventState {
  e: GameEvent;
  budget: number;
  t0: number;
  audio: AudioPort | null;
  flic: EventFlic | null;
  ref: FlicRef | null;
  /** soundMap 里 flicCovered 的提示（导演层在原版皮肤里不放，由舞台放 FLIC 同步音效或补放回退音） */
  cue: SfxCue | null;
  sfxDone: boolean;
}

/** eventFlic 处理的事件（其余 FLIC 事件由对应的端口方法播放） */
const EVENT_FLIC_TYPES: ReadonlySet<OrigFlicEvent> = new Set<OrigFlicEvent>([
  'CARD_GAINED',
  'POINTS_GAINED',
  'HOLIDAY',
  'BANKRUPT',
]);

export class OrigStage implements StagePort {
  private dead = false;
  private cur: EventState | null = null;
  private readonly flics: OrigFlicPort | null;
  private readonly sfxSwitch: FlicSfxSwitch | null;
  private releaseSfx: (() => void) | null = null;
  private readonly prefetched = new Set<string>();

  constructor(
    private readonly host: OrigStageHost,
    private readonly fx: FxSystem,
    o: OrigStageOptions = {},
  ) {
    this.flics = o.flics ?? null;
    this.sfxSwitch = o.flicSfx ?? null;
    // 原版棋盘在场：FLIC 同步音效由舞台放，导演层不再放 flicCovered 的提示
    this.releaseSfx = this.sfxSwitch?.claim() ?? null;
  }

  get ready(): boolean {
    return !this.dead && this.host.ready;
  }

  /** 棋盘销毁：撤销 flicSfx，之后所有方法空转 */
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.cur = null;
    this.releaseSfx?.();
    this.releaseSfx = null;
  }

  private get clock() {
    return this.fx.clock;
  }

  private pos(at: Anchor, lift = false): Pt | null {
    return this.ready ? this.host.anchorPos(at, lift) : null;
  }

  private actor(seat: SeatIndex): OrigStageActor | undefined {
    return this.ready ? this.host.actor(seat) : undefined;
  }

  // ───────────────────────── 事件上下文、FLIC 与声音 ─────────────────────────

  beginEvent(e: GameEvent, ctx: StageEventContext): void {
    this.sfxSwitch?.refresh();
    if (!this.ready) {
      this.cur = null;
      return;
    }
    const flic = eventFlicOf(e, { map: this.host.mapDef, characterOf: (s) => this.host.characterOf(s) });
    const ref = flic && this.flics ? this.flics.resolve(flic.use) : null;
    if (flic && ref) this.flics?.prefetch(flic.use);
    this.cur = {
      e,
      budget: ctx.budgetMs,
      t0: this.clock.now(),
      audio: ctx.audio ?? null,
      flic,
      ref,
      cue: this.sfxSwitch ? flicCoveredCue(e) : null,
      sfxDone: false,
    };
    // 这次没有 FLIC：flicCovered 的提示由舞台在事件开始时补放（导演层在原版皮肤里不再放它）
    if (!ref) this.fallbackSfx();
  }

  /** 当前事件（测试与调试） */
  get currentEvent(): Readonly<{ type: string; budget: number; flic: string | null; flicKey: string | null }> | null {
    const c = this.cur;
    return c ? { type: c.e.type, budget: c.budget, flic: c.flic?.use ?? null, flicKey: c.ref?.key ?? null } : null;
  }

  /**
   * FLIC 的可用时长：当前事件是 type 时 = min(预算 − 其他等待 − 余量, 预算 − 已用 − 之后的等待 − 余量)
   * （镜头、载入比预估慢时不超预算）；没有事件上下文（单测直接调端口、其他 handler 借用）时用 fallbackMs。
   */
  availFor(type: OrigFlicEvent, fallbackMs: number): number {
    const c = this.cur;
    if (!c || c.e.type !== type) return fallbackMs;
    const dyn = c.budget - (this.clock.now() - c.t0) - ORIG_FLIC_WAITS[type].after - ORIG_FLIC_SLACK_MS;
    return Math.max(0, Math.min(flicAvailMs(type, c.budget), dyn));
  }

  /** 开局棋盘伞的可用时长（OrigActor.drop 调用；没有事件上下文时 fallbackMs） */
  parachuteFitMs(fallbackMs: number): number {
    return this.availFor('PARACHUTE', fallbackMs);
  }

  /** 播 FLIC；不可用时（条目缺失、载入失败）补放回退音，由调用方走 FxSystem 回退 */
  private async flic(
    use: string | null,
    at: Pt | null,
    availMs: number,
    signal: AbortSignal,
    onProgress?: (v: number) => void,
  ): Promise<FlicOutcome> {
    if (!use || !at || !this.flics || !this.ready) {
      this.fallbackSfx();
      return 'unavailable';
    }
    const r = await this.flics.play(use, {
      at,
      availMs,
      signal,
      onStart: (ref) => this.flicSfx(ref),
      ...(onProgress ? { onProgress } : {}),
    });
    if (r === 'unavailable') this.fallbackSfx();
    return r;
  }

  /** FLIC 的同步音效键（素材包里没有这个音频条目时为 null） */
  private flicSound(ref: FlicRef | null): string | null {
    const key = ref?.entry.sfx ?? null;
    return key && this.flics?.soundAvailable(key) ? key : null;
  }

  /** FLIC 首帧：放 flic-map 的同步音效（没有时补放提示的回退音） */
  private flicSfx(ref: FlicRef): void {
    const c = this.cur;
    // 本事件已经出过声（例如映射表晚到、事件开始时先补放了回退音）：不再重复
    if (c?.sfxDone) return;
    const key = this.flicSound(ref);
    if (!key) {
      this.fallbackSfx();
      return;
    }
    c?.audio?.play(key);
    if (c) c.sfxDone = true;
  }

  /** flicCovered 的事件这次没有 FLIC 出声：补放一次（有 FLIC 条目时用它的同步音效，否则提示的 ZzFX 预设） */
  private fallbackSfx(): void {
    const c = this.cur;
    if (!c?.cue || c.sfxDone) return;
    c.sfxDone = true;
    const key = this.flicSound(c.ref) ?? c.cue.zzfx ?? null;
    if (key) c.audio?.play(key);
  }

  private prefetchOnce(use: string | null): void {
    if (!use || !this.flics || this.prefetched.has(use)) return;
    this.prefetched.add(use);
    this.flics.prefetch(use);
  }

  // ───────────────────────── 同步 ─────────────────────────

  syncWorld(view: GameView): void {
    if (!this.ready) return;
    this.host.roads.sync(view);
    for (const p of view.players) this.host.actor(p.seat)?.setStatus(statusOf(p, view));
    if (this.flics) {
      // 可能马上要播的 FLIC 先取（路上神明的降临、身上炸弹的爆炸、警车救护车）
      for (const g of view.gods) if (g.where.t === 'road') this.prefetchOnce(godArrivalUse(g.kind));
      if (view.players.some((p) => p.bomb)) this.prefetchOnce(ORIGINAL_FLICS.explosionBig.use);
      this.prefetchOnce(ORIGINAL_FLICS.policeCar.use);
      this.prefetchOnce(ORIGINAL_FLICS.ambulance.use);
    }
  }

  clear(): void {
    // 演出节点（FLIC 精灵、飞行的炸弹、恶犬……）都登记在 FxSystem（BoardPort.clearFx 已清）
    this.cur = null;
  }

  // ───────────────────────── 路面物件（原版精灵 / 小爆炸 FLIC） ─────────────────────────

  async dropObject(obj: RoadObject, signal: AbortSignal): Promise<void> {
    if (!this.ready) return;
    const root = this.host.roads.addObject(obj);
    if (!root) return;
    await this.fx.tween(
      FX_DROP_MS,
      (v) => {
        if (!root.destroyed) root.pivot.y = 80 * (1 - v);
      },
      signal,
      backOut,
    );
    if (!root.destroyed) root.pivot.y = 0;
    const p = this.host.tilePos(obj.node);
    if (p) this.fx.sparkles(p, 0xd8c8a8, 6);
  }

  async removeObject(obj: RoadObject, how: ObjectRemoval, signal: AbortSignal): Promise<void> {
    if (!this.ready) return;
    const root = this.host.roads.detachObject(obj.id);
    const p = this.host.tilePos(obj.node);
    if (how === 'boom') {
      // 踩中地雷 / 路面炸弹：原版小爆炸 FLIC（Data#484）
      root?.destroy({ children: true });
      if (!p) {
        this.fallbackSfx();
        return;
      }
      this.host.shake(5, 300);
      const r = await this.flic(
        ORIGINAL_FLICS.explosionSmall.use,
        p,
        this.availFor('OBJECT_REMOVED', FX_REMOVE_MS),
        signal,
      );
      if (r !== 'unavailable') return;
      // 回退：不阻塞的程序化爆炸（与 OrigStage-lite 相同：OBJECT_REMOVED 的紧凑预算放不下整段爆炸）
      void this.fx.explosion(p, 'small', signal);
      await this.fx.wait(FX_REMOVE_MS, signal);
      return;
    }
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
        if (how === 'burst') {
          root.position.set(x0 + 30 * v, y0 - 48 * hopArc(Math.min(1, v * 0.8 + 0.1)) - 20 * v);
        } else if (how === 'pickup') {
          root.position.y = y0 - 30 * cubicOut(v);
        }
        root.alpha = 1 - v;
      },
      k.signal,
    );
    k.done();
  }

  /** 机器娃娃（原版 npc.doll 走姿）沿路走，经过的物件弹飞 */
  async dollWalk(path: readonly TileId[], cleared: readonly number[], signal: AbortSignal): Promise<void> {
    if (!this.ready || path.length === 0) return;
    const roads = this.host.roads;
    const clearAt = new Map<TileId, RoadObject[]>();
    for (const id of cleared) {
      const o = roads.objectOf(id);
      if (!o) continue;
      const list = clearAt.get(o.node) ?? [];
      list.push(o);
      clearAt.set(o.node, list);
    }
    const visit = (tile: TileId): void => {
      for (const o of clearAt.get(tile) ?? []) void this.removeObject(o, 'burst', signal);
      clearAt.delete(tile);
    };
    const doll = this.host.spawnDoll(path[0]!);
    visit(path[0]!);
    if (!doll) {
      for (const t of path) visit(t);
      await this.fx.wait(Math.max(0, path.length - 1) * STEP_MS, signal);
      return;
    }
    try {
      await doll.walk(path, { stepMs: STEP_MS, signal, onStep: (tile) => visit(tile) });
    } finally {
      for (const t of path) visit(t);
      const end = this.host.tilePos(path[path.length - 1]!);
      if (end && !signal.aborted) this.fx.sparkles(end, 0xbfe8ff, 8);
      doll.destroy();
    }
  }

  // ───────────────────────── 特效（FLIC / FxSystem 原语） ─────────────────────────

  async explode(at: Anchor, size: 'small' | 'big', signal: AbortSignal): Promise<void> {
    const p = this.pos(at);
    if (!p) {
      this.fallbackSfx();
      return;
    }
    this.host.shake(size === 'big' ? 8 : 5, 420);
    const r =
      size === 'big'
        ? await this.flic(ORIGINAL_FLICS.explosionBig.use, p, this.availFor('BOMB_EXPLODED', FX_EXPLODE_MS), signal)
        : await this.flic(ORIGINAL_FLICS.explosionSmall.use, p, this.availFor('OBJECT_REMOVED', FX_EXPLODE_MS), signal);
    if (r === 'unavailable') await this.fx.explosion(p, size, signal);
  }

  async strike(kind: StrikeKind, center: TileId, half: number, signal: AbortSignal): Promise<void> {
    const p = this.pos({ tile: center });
    if (!p) {
      this.fallbackSfx();
      return;
    }
    const t = strikeFlic(kind);
    const hit = STRIKE_IMPACT[kind];
    if (t) {
      let shook = false;
      const r = await this.flic(
        t.use,
        p,
        this.availFor('STRIKE', kind === 'nuke' ? FX_NUKE_MS : FX_MISSILE_MS),
        signal,
        (v) => {
          if (shook || v < hit.at) return;
          shook = true;
          this.host.shake(hit.amp, hit.ms);
        },
      );
      if (r !== 'unavailable') return;
    } else {
      this.fallbackSfx();
    }
    // 回退（3×3 炸弹没有原版动画）：FxSystem 的飞弹 / 核弹 / 冲击波
    const radius = origStrikeRadius(half);
    if (kind === 'nuke') {
      await this.fx.nuke(p, radius, signal);
      return;
    }
    if (kind === 'missile') {
      await this.fx.missile(p, radius, signal);
      return;
    }
    this.host.shake(hit.amp, hit.ms);
    await Promise.all([
      this.fx.shockwave(p, radius, 0xbfc5cf, FX_MISSILE_MS * 0.9, signal),
      this.fx.wait(FX_MISSILE_MS, signal),
    ]);
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
    return this.fx.rewind(FX_REWIND_MS, this.host.world, signal);
  }

  burst(at: Anchor, color: number, count = 10): void {
    const p = this.pos(at, true);
    if (p) this.fx.sparkles(p, color, count);
  }

  bubble(at: Anchor, text: string, ms: number): void {
    const p = this.pos(at, true);
    if (p) this.fx.bubble({ x: p.x, y: p.y - 10 }, text, ms);
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
    this.fx.sparkles(a.headPos(), 0xffe066, 8);
    await this.fx.wait(FX_CAST_MS, signal);
  }

  /** 终局烟火（不阻塞）：原版烟火 FLIC 落在镜头中心；没有时 FxSystem 烟花 */
  fireworks(): void {
    if (!this.ready) return;
    const use = ORIGINAL_FLICS.fireworks.use;
    const c = this.host.viewCenter();
    if (!c || !this.flics?.resolve(use)) {
      this.fx.fireworks(FX_FIREWORKS_MS);
      return;
    }
    const full = ORIGINAL_FLICS.fireworks.frames * ORIGINAL_FLICS.fireworks.frameMs;
    void this.flics
      .play(use, { at: c, availMs: full, signal: new AbortController().signal, onStart: (ref) => this.flicSfx(ref) })
      .then((r) => {
        if (r === 'unavailable' && this.ready) this.fx.fireworks(FX_FIREWORKS_MS);
      })
      .catch(() => {});
  }

  /** 事件自己的原版 FLIC（卡片格得卡、点券格得点券、节日、破产）；没有时立即返回 */
  async eventFlic(e: GameEvent, signal: AbortSignal): Promise<void> {
    if (!this.ready || !isOrigFlicEvent(e.type) || !EVENT_FLIC_TYPES.has(e.type)) return;
    const c = this.cur;
    const f =
      c && c.e === e ? c.flic : eventFlicOf(e, { map: this.host.mapDef, characterOf: (s) => this.host.characterOf(s) });
    if (!f) return;
    let at: Pt | null;
    if (e.type === 'CARD_GAINED' || e.type === 'POINTS_GAINED') {
      const a = this.actor(e.seat);
      at = a?.root.visible ? a.boardPos() : null;
    } else if (e.type === 'BANKRUPT') {
      const a = this.actor(e.seat);
      at = a?.root.visible ? a.boardPos() : this.host.viewCenter();
    } else {
      at = this.host.viewCenter();
    }
    await this.flic(f.use, at, this.availFor(f.type, flicAvailMs(f.type, budgetMs(e))), signal);
  }

  // ───────────────────────── 神明 ─────────────────────────

  /** 路上出现神明：原版神明精灵放大出现 */
  async godSpawn(kind: GodKind, node: TileId, signal: AbortSignal): Promise<void> {
    if (!this.ready) return;
    const root = this.host.roads.addGod(kind, node);
    if (!root) return;
    await this.fx.tween(FX_GOD_SPAWN_MS, (v) => root.scale.set(Math.max(0.01, v)), signal, backOut);
    if (!root.destroyed) root.scale.set(1);
  }

  /** 神明降临：原版降临 FLIC（Data#499–510）落在角色处，播完挂上附身神明 */
  async godArrive(seat: SeatIndex, kind: GodKind, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a || a.tile === null) {
      this.fallbackSfx();
      return;
    }
    const road = this.host.roads.detachGod(kind, a.tile);
    road?.destroy({ children: true });
    const r = await this.flic(
      godArrivalUse(kind),
      a.boardPos(),
      this.availFor('GOD_ATTACHED', FX_GOD_ARRIVE_MS),
      signal,
    );
    if (r === 'unavailable') {
      // 回退：光柱 + 附身 + 闪光（与 OrigStage-lite 相同）
      const pal = GOD_PALETTES[kind];
      await this.fx.lightPillar(a.boardPos(), pal.aura, FX_PILLAR_MS, signal);
      if (!a.destroyed) a.setGod(kind);
      this.fx.sparkles(a.headPos(), pal.aura, 10);
      await this.fx.wait(FX_GOD_ARRIVE_MS - FX_PILLAR_MS, signal);
      return;
    }
    if (!a.destroyed) a.setGod(kind);
  }

  /** 神明离身：原版烟雾 FLIC（Data#485，110×110）罩住神明，同时取下附身 / 路上的神明 */
  async godLeave(seat: SeatIndex | null, kind: GodKind, signal: AbortSignal): Promise<void> {
    if (!this.ready) return;
    let from: Pt | null = null;
    if (seat !== null) {
      const a = this.actor(seat);
      if (a) {
        const b = a.boardPos();
        from = { x: b.x + GOD_CENTER.x, y: b.y + GOD_CENTER.y };
        a.setGod(null);
      }
    } else {
      const road = this.host.roads.detachGod(kind);
      if (road) {
        from = { x: road.position.x, y: road.position.y + ROAD_GOD_CENTER_Y };
        road.destroy({ children: true });
      }
    }
    const r = await this.flic(
      from ? ORIGINAL_FLICS.godLeave.use : null,
      from,
      this.availFor('GOD_LEFT', FX_GOD_LEAVE_MS),
      signal,
    );
    if (r !== 'unavailable') return;
    if (from) this.fx.sparkles(from, GOD_PALETTES[kind].aura, 10);
    await this.fx.wait(FX_GOD_LEAVE_MS, signal);
  }

  async godPower(seat: SeatIndex, kind: GodKind, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a) return;
    const pal = GOD_PALETTES[kind];
    this.fx.sparkles(a.headPos(), pal.aura, 12);
    await this.fx.shockwave(a.boardPos(), 60, pal.aura, FX_GOD_POWER_MS, signal);
  }

  async manifest(kind: GodKind, lotAt: Anchor, effect: GodManifestEffect, signal: AbortSignal): Promise<void> {
    const p = this.pos(lotAt);
    if (!p) return;
    const pal = GOD_PALETTES[kind];
    const color = effect === 'levelUp' ? 0xffd84d : effect === 'levelDown' ? 0x8e78c0 : pal.aura;
    await this.fx.lightPillar(p, color, FX_PILLAR_MS, signal);
    if (effect === 'levelDown') this.host.shake(4, 300);
    else this.fx.sparkles({ x: p.x, y: p.y - 20 }, color, 12);
    await this.fx.wait(FX_MANIFEST_MS - FX_PILLAR_MS, signal);
  }

  /** 恶犬：原版恶犬精灵扑向角色（被撞开时飞走），咬完回到原地 */
  async dogBite(seat: SeatIndex, node: TileId, knocked: boolean, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    const home = this.host.tilePos(node);
    if (!a || !home) return;
    const dog = this.host.roads.detachGod(11, node);
    if (!dog) {
      this.fx.sparkles(a.headPos(), 0xf2545b, 8);
      this.host.shake(3, 200);
      await this.fx.wait(FX_BITE_MS, signal);
      return;
    }
    const k = this.fx.track(dog, this.fx.overlay, signal);
    const from = { x: dog.position.x, y: dog.position.y };
    const target = a.boardPos();
    let bitten = false;
    await this.fx.tween(
      FX_BITE_MS,
      (v) => {
        if (dog.destroyed) return;
        if (knocked) {
          const t = v < 0.4 ? v / 0.4 : 1;
          const fly = v < 0.4 ? 0 : (v - 0.4) / 0.6;
          dog.position.set(
            from.x + (target.x - from.x) * 0.6 * t + 60 * fly,
            from.y + (target.y - from.y) * 0.6 * t - 50 * hopArc(fly * 0.5),
          );
          dog.alpha = 1 - fly;
        } else {
          const lunge = hopArc(Math.min(1, v * 1.6));
          dog.position.set(from.x + (target.x - from.x) * 0.7 * lunge, from.y + (target.y - from.y) * 0.7 * lunge);
          if (!bitten && v > 0.3) {
            bitten = true;
            this.fx.sparkles(a.headPos(), 0xf2545b, 8);
            this.host.shake(3, 200);
          }
        }
      },
      k.signal,
      linear,
    );
    k.done();
    // 咬完恶犬仍守在原地（被撞开时由之后的同步按新位置放回）
    if (!knocked && this.ready) this.host.roads.addGod(11, node);
  }

  // ───────────────────────── 角色 ─────────────────────────

  /** 警车（Data#497）/ 救护车（Data#483）FLIC：开来把人接走；之后的同步给出关押外观 */
  async escort(seat: SeatIndex, where: ConfineKind, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a?.root.visible) {
      this.fallbackSfx();
      return;
    }
    const root = a.root;
    const use = where === 'jail' ? ORIGINAL_FLICS.policeCar.use : ORIGINAL_FLICS.ambulance.use;
    try {
      const r = await this.flic(use, a.boardPos(), this.availFor('CONFINED', FX_ESCORT_MS), signal, (v) => {
        if (v >= ESCORT_PICKUP && !root.destroyed) root.alpha = 0;
      });
      if (r !== 'unavailable') return;
      // 回退：角色淡出（与 OrigStage-lite 相同）
      await this.fx.tween(
        FX_ESCORT_MS,
        (v) => {
          if (!root.destroyed) root.alpha = v < 0.5 ? 1 : 1 - (v - 0.5) * 2;
        },
        signal,
      );
    } finally {
      // 关押外观（原版住院 / 坐牢姿态）由之后的同步给出；这里恢复本体透明度
      if (!root.destroyed) root.alpha = 1;
    }
  }

  async release(seat: SeatIndex, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a) return;
    this.fx.sparkles(a.headPos(), 0xfff3b0, 10);
    await this.fx.shockwave(a.boardPos(), 40, 0xffffff, FX_RELEASE_MS, signal);
  }

  /** 换车：原版机车 / 汽车姿态库（OrigActor 按状态选库）+ 跳一下 */
  async vehicle(seat: SeatIndex, v: Vehicle, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a) return;
    a.setStatus({ ...a.currentStatus, vehicle: v });
    this.fx.sparkles(a.boardPos(), 0xffd84d, 8);
    await Promise.all([a.hop(signal), this.fx.wait(FX_VEHICLE_MS, signal)]);
  }

  async wreck(seat: SeatIndex, _v: Vehicle, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a) return;
    this.fx.sparkles(a.boardPos(), 0x8a8f99, 10);
    this.host.shake(3, 250);
    await this.fx.wait(FX_WRECK_MS, signal);
    if (!a.destroyed) a.setStatus({ ...a.currentStatus, vehicle: 'walk' });
  }

  /** 原版定时炸弹精灵（Data#372）从天而降落到头上，之后按状态挂上（带引信数字） */
  async bombAttach(seat: SeatIndex, fuse: number, signal: AbortSignal): Promise<void> {
    const a = this.actor(seat);
    if (!a) return;
    const head = a.headPos();
    const spr = this.host.objectSprite('object.bomb');
    if (spr) {
      const k = this.fx.track(spr, this.fx.overlay, signal);
      await this.fx.tween(
        FX_BOMB_ATTACH_MS,
        (v) => {
          if (!spr.destroyed) spr.position.set(head.x - 8, head.y - 90 * (1 - v));
        },
        k.signal,
        backOut,
      );
      k.done();
    } else {
      await this.fx.wait(FX_BOMB_ATTACH_MS, signal);
    }
    if (!a.destroyed) a.setStatus({ ...a.currentStatus, bomb: fuse });
  }

  /** 定时炸弹转移：原版炸弹精灵划弧飞到另一人头上 */
  async bombPass(from: SeatIndex, to: SeatIndex, fuse: number, signal: AbortSignal): Promise<void> {
    const a = this.actor(from);
    const b = this.actor(to);
    if (!a || !b) return;
    a.setStatus({ ...a.currentStatus, bomb: null });
    const p0 = a.headPos();
    const p1 = b.headPos();
    const spr = this.host.objectSprite('object.bomb');
    const k = spr ? this.fx.track(spr, this.fx.overlay, signal) : null;
    await this.fx.tween(
      FX_BOMB_PASS_MS,
      (v) => {
        const x = p0.x + (p1.x - p0.x) * v;
        const y = p0.y + (p1.y - p0.y) * v - 60 * hopArc(v);
        if (spr && !spr.destroyed) spr.position.set(x - 8, y);
        else if (!spr && Math.floor(v * 6) !== Math.floor((v - 0.01) * 6)) this.fx.sparkles({ x, y }, 0xffd84d, 2);
      },
      k?.signal ?? signal,
      quadInOut,
    );
    k?.done();
    if (!b.destroyed) b.setStatus({ ...b.currentStatus, bomb: fuse });
  }

  async magic(caster: SeatIndex, targets: readonly SeatIndex[], signal: AbortSignal): Promise<void> {
    const a = this.actor(caster);
    if (!a) return;
    const circles = targets.map((s) => {
      const t = this.actor(s);
      return t ? this.fx.magicCircle(t.boardPos(), 0x9b6bff, FX_MAGIC_MS * 0.8, signal) : Promise.resolve();
    });
    await Promise.all([this.fx.wait(FX_MAGIC_MS, signal), ...circles]);
  }

  /** 乞丐（原版 char.<c>.beggar）跳到新节点 */
  async beggarMove(seat: SeatIndex, node: TileId, signal: AbortSignal): Promise<void> {
    if (!this.ready) return;
    const m = this.host.roads.moveBeggar(seat, node);
    if (!m) return;
    await this.fx.tween(
      FX_BEGGAR_MOVE_MS,
      (v) => {
        if (m.root.destroyed) return;
        m.root.position.set(m.from.x + (m.to.x - m.from.x) * v, m.from.y + (m.to.y - m.from.y) * v - 16 * hopArc(v));
      },
      signal,
    );
    m.settle();
  }

  // ───────────────────────── 恶人（原版 npc.villain 走姿） ─────────────────────────

  async walkVillain(kind: VillainKind, path: readonly TileId[], signal: AbortSignal): Promise<void> {
    if (!this.ready || path.length === 0) return;
    const a = this.host.roads.ensureVillain(kind, path[0]!);
    if (!a) return;
    await a.walk(path, { stepMs: STEP_MS, signal });
  }

  villainAnchor(kind: VillainKind): Anchor | null {
    if (!this.ready) return null;
    const node = this.host.roads.villainNode(kind);
    return node === null ? null : { tile: node };
  }
}

// ───────────────────────── 实现方式登记（coverage） ─────────────────────────

/** StagePort 的全部方法（ready 属性除外） */
export type StageMethod = Exclude<keyof StagePort, 'ready'>;

/**
 * 每个方法的原版实现方式：sync = 同步 / 查询；flic = 原版 FLIC（uses 为 flic-map 用途；条目缺失或载入失败时 fallback）；
 * sprite = 原版精灵演出；fx = 没有原版对应物，FxSystem 原语。flic 的 fallback 一律为显式的 FxSystem 回退。
 */
export type StageImpl =
  | { kind: 'sync' }
  | { kind: 'flic'; uses: readonly string[]; fallback: 'fx' }
  | { kind: 'sprite'; keys: readonly string[]; fallback: 'fx' }
  | { kind: 'fx' };

const GOD_ARRIVAL_USES: readonly string[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15]
  .map((k) => godArrivalUse(k as GodKind))
  .filter((u): u is string => u !== null);

export const ORIG_STAGE_IMPL = {
  syncWorld: { kind: 'sync' },
  clear: { kind: 'sync' },
  beginEvent: { kind: 'sync' },
  villainAnchor: { kind: 'sync' },
  dropObject: { kind: 'sprite', keys: ['object.roadblock', 'object.mine', 'object.bomb'], fallback: 'fx' },
  removeObject: { kind: 'flic', uses: [ORIGINAL_FLICS.explosionSmall.use], fallback: 'fx' },
  dollWalk: { kind: 'sprite', keys: ['npc.doll.walk', 'npc.doll.stand'], fallback: 'fx' },
  explode: {
    kind: 'flic',
    uses: [ORIGINAL_FLICS.explosionSmall.use, ORIGINAL_FLICS.explosionBig.use],
    fallback: 'fx',
  },
  strike: {
    kind: 'flic',
    uses: [
      ORIGINAL_FLICS.missile.use,
      ORIGINAL_FLICS.nuke.use,
      ORIGINAL_FLICS.alienAttack.use,
      ORIGINAL_FLICS.typhoon.use,
    ],
    fallback: 'fx',
  },
  pillar: { kind: 'fx' },
  beam: { kind: 'fx' },
  flash: { kind: 'fx' },
  rewind: { kind: 'fx' },
  burst: { kind: 'fx' },
  bubble: { kind: 'fx' },
  teleport: { kind: 'fx' },
  cast: { kind: 'fx' },
  fireworks: { kind: 'flic', uses: [ORIGINAL_FLICS.fireworks.use], fallback: 'fx' },
  eventFlic: {
    kind: 'flic',
    uses: [
      ORIGINAL_FLICS.cardGain.use,
      ORIGINAL_FLICS.pointsGain.use,
      ORIGINAL_FLICS.fireworks.use,
      ORIGINAL_FLICS.christmas.use,
      ORIGINAL_FLICS.bankrupt.use,
    ],
    fallback: 'fx',
  },
  godSpawn: { kind: 'sprite', keys: ['object.<神明>'], fallback: 'fx' },
  godArrive: { kind: 'flic', uses: GOD_ARRIVAL_USES, fallback: 'fx' },
  godLeave: { kind: 'flic', uses: [ORIGINAL_FLICS.godLeave.use], fallback: 'fx' },
  godPower: { kind: 'fx' },
  manifest: { kind: 'fx' },
  dogBite: { kind: 'sprite', keys: ['object.dog'], fallback: 'fx' },
  escort: { kind: 'flic', uses: [ORIGINAL_FLICS.policeCar.use, ORIGINAL_FLICS.ambulance.use], fallback: 'fx' },
  release: { kind: 'fx' },
  vehicle: { kind: 'sprite', keys: ['char.<c>.moto.*', 'char.<c>.car.*'], fallback: 'fx' },
  wreck: { kind: 'sprite', keys: ['char.<c>.stand'], fallback: 'fx' },
  bombAttach: { kind: 'sprite', keys: ['object.bomb'], fallback: 'fx' },
  bombPass: { kind: 'sprite', keys: ['object.bomb'], fallback: 'fx' },
  magic: { kind: 'fx' },
  beggarMove: { kind: 'sprite', keys: ['char.<c>.beggar'], fallback: 'fx' },
  walkVillain: { kind: 'sprite', keys: ['npc.villain.<kind>.walk'], fallback: 'fx' },
} as const satisfies Readonly<Record<StageMethod, StageImpl>>;

/** 按 flic-map 用途登记的全部 FLIC（开局棋盘伞由 OrigActor 播放，另计） */
export function stageFlicUses(): string[] {
  const out = new Set<string>();
  for (const impl of Object.values(ORIG_STAGE_IMPL) as StageImpl[]) {
    if (impl.kind === 'flic') for (const u of impl.uses) out.add(u);
  }
  return [...out].sort();
}
