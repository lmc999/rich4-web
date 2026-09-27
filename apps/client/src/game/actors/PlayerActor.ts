// 玩家棋子（design/client.md §3.7）：walk(path) 逐格跳步（抛物线小跳 + squash & stretch）、深度排序、
// 支持 AbortSignal（中止即 teleport 到终点）与 AnimClock（倍速、假时钟）。
// 路径是游戏格序列；相邻两格之间若有 via 连接格，按格链插值（每个子段一跳，总时长仍为一步）。
import type { Cell, TileId } from '@rich4/shared/data';
import type { GodKind, Vehicle } from '@rich4/shared/engine';
import { type BitmapText, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { AnimClock } from '../anim/AnimClock';
import { hopArc, linear } from '../anim/easing';
import { tweenValue } from '../anim/tween';
import type { BoardGeometry } from '../board/BoardGeometry';
import { numberTag } from '../fx/FloatingText';
import { HOP_MS } from '../fx/timings';
import { DepthBias, depthOfCell, depthOfMove } from '../iso/depth';
import { dirOfViewStep, facingOf, type IsoDir, type Pt } from '../iso/projection';
import { INK, PLAYER_COLORS, PLAYER_MARKS } from '../procedural/building/styles';
import type { CharacterFrames } from '../procedural/character/atlas';
import type { Facing, Pose } from '../procedural/character/rig';
import {
  type ActorStatus,
  bombIcon,
  confineWindow,
  ICE_TINT,
  NO_STATUS,
  sameStatus,
  tortoiseShell,
} from './ActorStatus';
import type { FigureTextures } from './figureTextures';
import { GodSprite } from './GodSprite';
import { RIDE_LIFT, vehicleGraphics } from './Vehicle';

/** 头顶聊天气泡最多显示的字数 */
export const SAY_MAX_CHARS = 18;

/** 1x 下每步毫秒（与 shared/view/pacing 的 STEP_MS 一致） */
export const STEP_MS = 180;
export const HOP_PX = 16;
/** 多名玩家同格时的偏移（按座位） */
export const SEAT_OFFSETS: readonly Pt[] = [
  { x: -12, y: -4 },
  { x: 12, y: -4 },
  { x: -12, y: 6 },
  { x: 12, y: 6 },
];
/** 角色精灵缩放（128×160 的 SVG 帧放到 128×64 的格上） */
export const ACTOR_SCALE = 0.62;
/** 头顶挂件（附身神明、炸弹、状态符号）相对脚底的高度 */
export const OVERHEAD_Y = -112 * ACTOR_SCALE - 20;
/** 名牌的默认高度（相对脚底） */
const TAG_Y = -112 * ACTOR_SCALE - 14;
/** 关押时的深度加成（大于任何格子的深度） */
const CONFINED_Z = 1_000_000;
/** 附身神明相对头顶挂件层的高度 */
const GOD_Y = -22;

export interface WalkOptions {
  stepMs?: number;
  signal?: AbortSignal;
  /** 每到达一个游戏格回调（i 为该格在 path 中的下标） */
  onStep?: (tile: TileId, i: number) => void;
}

export interface WalkStep {
  from: Cell;
  to: Cell;
  /** 该子段所属的游戏步（path 下标） */
  pathIndex: number;
  /** 该子段是否为这一游戏步的最后一段（到达游戏格） */
  arrive: boolean;
  /** 子段时长占一步的比例 */
  share: number;
}

/** 把游戏格路径展开为逐格子段（含 via 连接格） */
export function planWalk(geo: BoardGeometry, path: readonly TileId[]): WalkStep[] {
  const out: WalkStep[] = [];
  for (let i = 1; i < path.length; i++) {
    const cells = geo.linkCells(path[i - 1]!, path[i]!);
    const segs = Math.max(1, cells.length - 1);
    for (let k = 1; k < cells.length; k++) {
      out.push({ from: cells[k - 1]!, to: cells[k]!, pathIndex: i, arrive: k === cells.length - 1, share: 1 / segs });
    }
  }
  return out;
}

export interface PlayerActorOptions {
  seat: number;
  geo: BoardGeometry;
  clock: AnimClock;
  frames?: CharacterFrames | null;
  name?: string;
  /** 附身神明的纹理来源（棋盘共用）；缺省只画占位 */
  figures?: FigureTextures | null;
}

export class PlayerActor {
  readonly root = new Container({ label: 'actor' });
  readonly seat: number;
  private readonly body = new Container();
  private readonly shadow = new Graphics();
  /** 人物本体（精灵 / 占位）；骑车时整体抬高 */
  private readonly figure = new Container({ label: 'figure' });
  private readonly sprite = new Sprite();
  private readonly pawn = new Graphics();
  private readonly tag = new Container();
  private readonly ride = new Container({ label: 'ride' });
  private readonly shellBehind = new Container();
  private readonly shellFront = new Container();
  private readonly overhead = new Container({ label: 'overhead' });
  private readonly marks = new Graphics();
  private god: GodSprite | null = null;
  private bomb: { root: Container; fuse: BitmapText } | null = null;
  private confine: { root: Container; where: 'jail' | 'hospital'; days: BitmapText; face: Sprite } | null = null;
  private status: ActorStatus = NO_STATUS;
  /** 头顶聊天 / 表情气泡（跟随角色；新气泡替换旧的） */
  private speech: { root: Container; timer: ReturnType<typeof setTimeout> } | null = null;
  /** 关押气泡相对脚底的位置（舞台按医院 / 监狱建筑的位置给出；缺省在头顶） */
  private confineAt: Pt = { x: 0, y: -22 };
  private puff = 0;
  /** 骑车行走时的排气（舞台接到粒子系统；缺省不排气） */
  exhaust: ((at: Pt) => void) | null = null;
  private readonly figures: FigureTextures | null;
  private frames: CharacterFrames | null;
  private geo: BoardGeometry;
  private readonly clock: AnimClock;
  /** 逻辑连续坐标（格中心为 x+0.5） */
  private pos: Pt = { x: 0.5, y: 0.5 };
  private hopY = 0;
  private _tile: TileId | null = null;
  private dir: IsoDir = 'SE';
  private pose: Pose = 'idle0';
  private offset: Pt = { x: 0, y: 0 };
  private walking = false;
  /** 行走中收到的权威落点（reset 同步显示态时角色正在走）：行走收尾时落到这里而不是路径终点 */
  private landing: TileId | null = null;
  /** destroy 之后：仍挂在共享动画时钟上的补间（walk / hop）不再写已销毁的 Pixi 对象 */
  private dead = false;
  private idleT = 0;
  private offFrame: () => void;

  constructor(o: PlayerActorOptions) {
    this.seat = o.seat;
    this.geo = o.geo;
    this.clock = o.clock;
    this.frames = o.frames ?? null;
    this.figures = o.figures ?? null;
    this.root.label = `actor:${o.seat}`;
    this.shadow.ellipse(0, 0, 22, 9).fill({ color: 0x000000, alpha: 0.22 });
    this.sprite.anchor.set(0.5, 150 / 160);
    this.sprite.scale.set(ACTOR_SCALE);
    this.drawPawn();
    this.figure.addChild(this.shellBehind, this.pawn, this.sprite, this.shellFront);
    this.overhead.position.set(0, OVERHEAD_Y);
    this.overhead.addChild(this.marks);
    this.body.addChild(this.ride, this.figure, this.overhead);
    this.root.addChild(this.shadow, this.body, this.tag);
    if (o.name) this.setName(o.name);
    this.applyFrames();
    this.offFrame = this.clock.onFrame((_now, dt) => this.tickIdle(dt));
  }

  get tile(): TileId | null {
    return this._tile;
  }

  get facing(): IsoDir {
    return this.dir;
  }

  get currentPose(): Pose {
    return this.pose;
  }

  /**
   * 按显示态放到 tile：不在走就立即瞬移；正在走（reset 时被中止的行走还没收尾）则记下落点，行走收尾时落到这里，
   * 避免旧时间线的路径终点覆盖刚同步的快照。
   */
  settleAt(tile: TileId): void {
    if (this.walking) this.landing = tile;
    else if (this._tile !== tile) this.teleport(tile);
  }

  get isWalking(): boolean {
    return this.walking;
  }

  /** 逻辑连续坐标（测试与镜头跟随用） */
  get logicalPos(): Pt {
    return { ...this.pos };
  }

  /** 屏幕坐标（镜头跟随目标） */
  screenPos(): Pt {
    return { x: this.root.position.x, y: this.root.position.y };
  }

  setFrames(frames: CharacterFrames | null): void {
    this.frames = frames;
    this.applyFrames();
  }

  /** 头顶名牌；mark=false 时不带玩家形状标记（恶人） */
  setName(name: string, mark = this.seat < 4): void {
    for (const c of this.tag.removeChildren()) c.destroy();
    const color = this.seat < 4 ? (PLAYER_COLORS[this.seat % 4] ?? 0xffffff) : 0x5a5a5a;
    const t = new Text({
      text: mark ? `${PLAYER_MARKS[this.seat % 4] ?? ''} ${name}` : name,
      style: {
        fontFamily: '"ZCOOL KuaiLe", sans-serif',
        fontSize: 15,
        fill: 0xffffff,
        stroke: { color: INK, width: 4 },
      },
      resolution: 2,
    });
    t.anchor.set(0.5, 1);
    const bg = new Graphics()
      .roundRect(-t.width / 2 - 6, -t.height - 3, t.width + 12, t.height + 4, 8)
      .fill(color)
      .stroke({ width: 2.5, color: INK });
    this.tag.addChild(bg, t);
    this.placeTag();
  }

  /** 名牌位置：平时在头顶；关押时跟着医院 / 监狱窗口气泡走 */
  private placeTag(): void {
    if (this.confine) this.tag.position.set(this.confineAt.x, this.confineAt.y - 66);
    else this.tag.position.set(0, TAG_Y);
  }

  /** 关押时整个角色（此时只剩窗口气泡与名牌）画在建筑之上，气泡不被医院 / 监狱的屋顶挡住 */
  private depth(c: Cell): number {
    return depthOfCell(this.geo.viewCell(c), DepthBias.Actor) + this.seat * 0.01 + (this.confine ? CONFINED_Z : 0);
  }

  setGeometry(geo: BoardGeometry): void {
    this.geo = geo;
    this.relayout();
  }

  /** 直接放到某格（sync / skip 用） */
  teleport(tile: TileId): void {
    if (this.dead) return;
    const c = this.geo.tileCell(tile);
    this._tile = tile;
    this.pos = { x: c.x + 0.5, y: c.y + 0.5 };
    this.hopY = 0;
    this.body.scale.set(1, 1);
    this.root.zIndex = this.depth(c);
    this.relayout();
  }

  setOffset(p: Pt): void {
    this.offset = { ...p };
    this.relayout();
  }

  setFacing(dir: IsoDir): void {
    this.dir = dir;
    this.applyFrames();
  }

  setPose(p: Pose): void {
    this.pose = p;
    this.applyFrames();
  }

  // ───────── 状态外观（M6） ─────────

  get currentStatus(): ActorStatus {
    return this.status;
  }

  /** 按状态更新外观（幂等；相同状态直接返回） */
  setStatus(s: ActorStatus): void {
    if (this.dead || sameStatus(this.status, s)) return;
    const prev = this.status;
    this.status = s;
    if (prev.vehicle !== s.vehicle) this.applyVehicle(s.vehicle);
    if (prev.god !== s.god) this.setGod(s.god);
    if (prev.tortoise !== s.tortoise) {
      for (const c of [...this.shellBehind.removeChildren(), ...this.shellFront.removeChildren()]) c.destroy();
      if (s.tortoise) {
        this.shellBehind.addChild(tortoiseShell());
        this.shellFront.addChild(tortoiseShell());
      }
    }
    this.figure.tint = s.hibernate ? ICE_TINT : 0xffffff;
    this.drawMarks();
    this.applyBomb(s.bomb);
    this.applyConfine(s.confined);
    const gone = s.away || s.beggar;
    this.figure.visible = !gone && s.confined === null;
    this.ride.visible = this.figure.visible;
    this.overhead.visible = !gone && s.confined === null;
    this.shadow.visible = !gone && s.confined === null;
    this.tag.visible = !gone;
    if (!s.sleepwalk) this.figure.rotation = 0;
    this.applyFrames();
  }

  /** 附身神明（null 取消）；不经过 setStatus 时供演出直接调用 */
  setGod(kind: GodKind | null): void {
    if (this.dead) return;
    if (this.god && this.god.kind === kind) return;
    this.god?.destroy();
    this.god = null;
    if (kind !== null) {
      this.god = new GodSprite(kind, this.clock, this.figures, 'attached');
      // 挂在名牌上方（名牌约占头顶 −105..−83 像素），不被名牌挡住
      this.god.root.position.set(0, GOD_Y);
      this.overhead.addChildAt(this.god.root, 0);
    }
    this.status = { ...this.status, god: kind };
  }

  /** 取走头顶的附身神明精灵（离身动画用；调用方负责销毁） */
  takeGod(): GodSprite | null {
    const g = this.god;
    if (!g) return null;
    this.god = null;
    this.status = { ...this.status, god: null };
    g.root.removeFromParent();
    return g;
  }

  /**
   * 关押气泡的位置（相对角色脚底，world 像素）：舞台把它放到医院 / 监狱建筑的窗口处，
   * 表示角色已离开路面；同一栋楼里多人时按座位错开。
   */
  setConfineAnchor(p: Pt): void {
    this.confineAt = { ...p };
    this.confine?.root.position.set(p.x, p.y);
    this.placeTag();
  }

  /** 头顶挂件的屏幕坐标（world 本地像素） */
  headPos(): Pt {
    return { x: this.root.position.x, y: this.root.position.y + OVERHEAD_Y - this.hopY };
  }

  /** 当前的正面待机帧（气泡头像用）；未加载时为 null */
  portraitTexture() {
    return this.frames ? this.frames.get('idle0', 'front') : null;
  }

  /** 旋转或偏移变化后重新计算屏幕位置与朝向 */
  relayout(): void {
    if (this.dead) return;
    const s = this.geo.toScreen(this.pos);
    this.root.position.set(s.x + this.offset.x, s.y + this.offset.y);
    this.body.position.set(0, -this.hopY);
    this.shadow.scale.set(1 - (this.hopY / HOP_PX) * 0.25);
    if (this._tile !== null && !this.walking) this.root.zIndex = this.depth(this.geo.tileCell(this._tile));
  }

  /** 原地跳一下（被选中或轮到时） */
  hop(signal?: AbortSignal): Promise<void> {
    return tweenValue(
      0,
      1,
      HOP_MS,
      (t) => {
        this.hopY = hopArc(t) * HOP_PX * 1.2;
        this.relayout();
      },
      { clock: this.clock, signal, ease: linear },
    ).then(() => {
      this.hopY = 0;
      this.relayout();
    });
  }

  /**
   * 沿路径逐格行走；path[0] 为当前格。中止时立即落到终点并 resolve。
   * 整条路径用一条时间线（总时长 = 游戏步数 × stepMs）驱动，子段按 share 切分：
   * 不会因为每个子段各自等帧而累积误差，实际时长与 shared/view/pacing 的预算一致。
   */
  async walk(path: readonly TileId[], o: WalkOptions = {}): Promise<void> {
    if (path.length === 0) return;
    this.landing = null;
    const last = path[path.length - 1]!;
    if (this._tile !== path[0]) this.teleport(path[0]!);
    if (path.length === 1) return;
    const stepMs = o.stepMs ?? STEP_MS;
    const steps = planWalk(this.geo, path);
    if (steps.length === 0) {
      this.teleport(last);
      return;
    }
    // 每个子段在总时间线上的起止（以「游戏步」为单位）
    const starts: number[] = [];
    let acc = 0;
    for (const st of steps) {
      starts.push(acc);
      acc += st.share;
    }
    const total = acc;
    this.walking = true;
    let cur = -1;
    let frame = 0;
    const enter = (i: number): void => {
      const st = steps[i]!;
      const va = this.geo.viewCell(st.from);
      const vb = this.geo.viewCell(st.to);
      this.dir = dirOfViewStep(vb.x - va.x, vb.y - va.y);
      this.pose = (['walk0', 'walk1', 'walk2', 'walk3'] as const)[frame++ % 4]!;
      this.applyFrames();
      this.root.zIndex = depthOfMove(va, vb, DepthBias.Actor) + this.seat * 0.01;
    };
    const arrive = (i: number): void => {
      const st = steps[i]!;
      if (!st.arrive) return;
      this._tile = path[st.pathIndex]!;
      o.onStep?.(this._tile, st.pathIndex);
    };
    try {
      await tweenValue(
        0,
        total,
        total * stepMs,
        (x) => {
          if (this.dead) return;
          // 找到 x 所在的子段；跨过的子段依次「到达」
          let i = cur < 0 ? 0 : cur;
          while (i < steps.length - 1 && x >= starts[i]! + steps[i]!.share) i++;
          if (i !== cur) {
            for (let k = Math.max(0, cur); k < i; k++) arrive(k);
            cur = i;
            enter(i);
          }
          const st = steps[i]!;
          const t = Math.min(1, Math.max(0, (x - starts[i]!) / st.share));
          const a = { x: st.from.x + 0.5, y: st.from.y + 0.5 };
          const b = { x: st.to.x + 0.5, y: st.to.y + 0.5 };
          this.pos = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          const arc = hopArc(t);
          this.hopY = arc * HOP_PX * Math.min(1, st.share * 1.6);
          if (this.exhaust && this.status.vehicle !== 'walk' && ++this.puff % 5 === 0) {
            const back = this.sprite.scale.x < 0 ? 1 : -1;
            this.exhaust({ x: this.root.position.x + back * 22, y: this.root.position.y - 4 });
          }
          this.body.scale.set(1 - 0.05 * arc, 1 + 0.07 * arc);
          this.relayout();
        },
        { clock: this.clock, signal: o.signal, ease: linear },
      );
      if (!o.signal?.aborted && cur >= 0) arrive(cur);
    } finally {
      this.walking = false;
      this.pose = 'idle0';
      this.hopY = 0;
      if (!this.dead) {
        this.body.scale.set(1, 1);
        // 正常走完或被中止，都以终点格收尾（中止 = 跳过动画直达终态）；行走期间收到了权威落点就以它为准
        this.teleport(this.landing ?? last);
        this.landing = null;
        this.applyFrames();
      }
    }
  }

  get destroyed(): boolean {
    return this.dead;
  }

  /**
   * 头顶气泡（聊天、表情；design/client.md §5.6）：挂在角色上随行走移动，ms 为真实时间（不受动画倍速影响）。
   * emote=true 时只放大显示一个表情字形；聊天原文超过 18 个字截断加省略号。
   */
  say(text: string, ms: number, emote = false): void {
    if (this.dead) return;
    this.clearSpeech();
    const chars = [...text];
    const shown = emote || chars.length <= SAY_MAX_CHARS ? text : `${chars.slice(0, SAY_MAX_CHARS).join('')}…`;
    const root = new Container({ label: 'speech' });
    const t = new Text({
      text: shown,
      style: {
        fontFamily: '"ZCOOL KuaiLe", "PingFang SC", sans-serif',
        fontSize: emote ? 30 : 16,
        fill: INK,
        wordWrap: !emote,
        wordWrapWidth: 180,
        breakWords: true,
      },
      resolution: 2,
    });
    t.anchor.set(0.5, 1);
    const w = Math.max(40, t.width + 20);
    const hh = t.height + 12;
    const bg = new Graphics()
      .roundRect(-w / 2, -hh - 9, w, hh, 14)
      .fill(0xffffff)
      .stroke({ width: 3, color: INK })
      .poly([-7, -10, 7, -10, 0, 0], true)
      .fill(0xffffff)
      .stroke({ width: 3, color: INK, join: 'round' });
    t.position.set(0, -15);
    root.addChild(bg, t);
    root.position.set(0, OVERHEAD_Y - 22);
    this.root.addChild(root);
    const timer = setTimeout(() => {
      if (this.speech?.root === root) this.clearSpeech();
    }, ms);
    this.speech = { root, timer };
  }

  private clearSpeech(): void {
    const sp = this.speech;
    if (!sp) return;
    this.speech = null;
    clearTimeout(sp.timer);
    if (!sp.root.destroyed) sp.root.destroy({ children: true });
  }

  destroy(): void {
    if (this.dead) return;
    this.clearSpeech();
    this.dead = true;
    this.offFrame();
    this.god?.destroy();
    this.god = null;
    this.root.destroy({ children: true });
  }

  // ───────── 内部 ─────────

  private tickIdle(dt: number): void {
    if (this.status.sleepwalk && !this.dead) {
      this.figure.rotation = Math.sin((this.idleT + dt) / 260) * 0.12;
    }
    if (this.walking) {
      this.idleT += dt;
      return;
    }
    this.idleT += dt;
    // 待机两帧交替（约 0.6s 一换）
    if (this.pose === 'idle0' || this.pose === 'idle1') {
      const next: Pose = Math.floor(this.idleT / 600) % 2 === 0 ? 'idle0' : 'idle1';
      if (next !== this.pose) {
        this.pose = next;
        this.applyFrames();
      }
    }
  }

  private applyFrames(): void {
    if (this.dead) return;
    const f = facingOf(this.dir);
    const facing: Facing = f.facing;
    const flip = f.mirror ? -1 : 1;
    if (this.frames) {
      this.sprite.texture = this.frames.get(this.pose, facing);
      this.sprite.visible = true;
      this.pawn.visible = false;
    } else {
      this.sprite.visible = false;
      this.pawn.visible = true;
    }
    this.sprite.scale.x = Math.abs(this.sprite.scale.x) * flip;
    // 龟壳背在身后：正面朝向时画在人物之后，背面朝向时画在人物之前
    this.shellBehind.visible = facing === 'front';
    this.shellFront.visible = facing !== 'front';
    this.ride.scale.x = flip;
    if (this.confine?.face && this.frames) this.confine.face.texture = this.frames.get('idle0', 'front');
  }

  private applyVehicle(v: Vehicle): void {
    for (const c of this.ride.removeChildren()) c.destroy({ children: true });
    if (v !== 'walk') this.ride.addChild(vehicleGraphics(v, PLAYER_COLORS[this.seat % 4] ?? 0xffffff));
    this.figure.position.set(0, -RIDE_LIFT[v]);
    this.overhead.position.set(0, OVERHEAD_Y - RIDE_LIFT[v]);
  }

  /** 冬眠 zzz、梦游问号（Graphics 自绘，不需要字体） */
  private drawMarks(): void {
    const g = this.marks;
    g.clear();
    const s = this.status;
    let x = this.god ? 26 : 0;
    if (s.hibernate) {
      for (const [dx, dy, k] of [
        [0, 0, 1],
        [10, -12, 1.3],
        [22, -26, 1.6],
      ] as const) {
        const w = 6 * k;
        g.poly([x + dx - w, dy - w, x + dx + w, dy - w, x + dx - w, dy + w, x + dx + w, dy + w], false).stroke({
          width: 3,
          color: 0xffffff,
          join: 'round',
        });
      }
      x += 30;
    }
    if (s.sleepwalk) {
      g.arc(x, -8, 7, Math.PI, Math.PI * 2.4).stroke({ width: 4, color: 0x9b6bff, cap: 'round' });
      g.moveTo(x + 2, -1)
        .lineTo(x, 6)
        .stroke({ width: 4, color: 0x9b6bff, cap: 'round' });
      g.circle(x, 13, 2.5).fill(0x9b6bff);
    }
  }

  private applyBomb(fuse: number | null): void {
    if (fuse === null) {
      this.bomb?.root.destroy({ children: true });
      this.bomb = null;
      return;
    }
    if (!this.bomb) {
      const root = new Container({ label: 'bomb' });
      const icon = bombIcon();
      const tag = numberTag(String(fuse), 16, 0xffd84d);
      tag.position.set(0, -18);
      root.addChild(icon, tag);
      root.position.set(-24, -2);
      this.overhead.addChild(root);
      this.bomb = { root, fuse: tag };
    }
    this.bomb.fuse.text = String(fuse);
  }

  private applyConfine(c: ActorStatus['confined']): void {
    if (c === null || (this.confine && this.confine.where !== c.where)) {
      const had = this.confine !== null;
      this.confine?.root.destroy({ children: true });
      this.confine = null;
      if (had) {
        this.placeTag();
        this.relayout();
      }
    }
    if (c === null) return;
    if (!this.confine) {
      const w = confineWindow(c.where);
      const face = new Sprite();
      face.anchor.set(0.5, 0.35);
      face.scale.set(0.42);
      face.position.set(0, -44);
      const tex = this.portraitTexture();
      if (tex) face.texture = tex;
      else {
        const dot = new Graphics()
          .circle(0, -40, 14)
          .fill(PLAYER_COLORS[this.seat % 4] ?? 0xffffff)
          .stroke({
            width: 3,
            color: INK,
          });
        w.content.addChild(dot);
      }
      const mask = new Graphics().roundRect(-27, -61, 54, 50, 8).fill(0xffffff);
      w.content.addChild(face, mask);
      face.mask = mask;
      const days = numberTag(String(c.days), 18, 0xffffff);
      days.position.set(18, -2);
      w.root.addChild(days);
      w.root.position.set(this.confineAt.x, this.confineAt.y);
      this.root.addChild(w.root);
      this.confine = { root: w.root, where: c.where, days, face };
      this.placeTag();
      this.relayout();
    }
    this.confine.days.text = String(c.days);
  }

  /** 图集未加载时的占位棋子：玩家色胶囊 + 形状标记 */
  private drawPawn(): void {
    const color = PLAYER_COLORS[this.seat % 4] ?? 0xffffff;
    this.pawn
      .roundRect(-14, -52, 28, 50, 14)
      .fill(color)
      .stroke({ width: 3, color: INK })
      .circle(0, -62, 15)
      .fill(0xffe0c2)
      .stroke({ width: 3, color: INK });
  }
}
