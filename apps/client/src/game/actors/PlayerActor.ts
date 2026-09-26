// 玩家棋子（design/client.md §3.7）：walk(path) 逐格跳步（抛物线小跳 + squash & stretch）、深度排序、
// 支持 AbortSignal（中止即 teleport 到终点）与 AnimClock（倍速、假时钟）。
// 路径是游戏格序列；相邻两格之间若有 via 连接格，按格链插值（每个子段一跳，总时长仍为一步）。
import type { Cell, TileId } from '@rich4/shared/data';
import { Container, Graphics, Sprite, Text } from 'pixi.js';
import type { AnimClock } from '../anim/AnimClock';
import { hopArc, linear } from '../anim/easing';
import { tweenValue } from '../anim/tween';
import type { BoardGeometry } from '../board/BoardGeometry';
import { HOP_MS } from '../fx/timings';
import { DepthBias, depthOfCell, depthOfMove } from '../iso/depth';
import { dirOfViewStep, facingOf, type IsoDir, type Pt } from '../iso/projection';
import { INK, PLAYER_COLORS, PLAYER_MARKS } from '../procedural/building/styles';
import type { CharacterFrames } from '../procedural/character/atlas';
import type { Facing, Pose } from '../procedural/character/rig';

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
}

export class PlayerActor {
  readonly root = new Container({ label: 'actor' });
  readonly seat: number;
  private readonly body = new Container();
  private readonly shadow = new Graphics();
  private readonly sprite = new Sprite();
  private readonly pawn = new Graphics();
  private readonly tag = new Container();
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
  /** destroy 之后：仍挂在共享动画时钟上的补间（walk / hop）不再写已销毁的 Pixi 对象 */
  private dead = false;
  private idleT = 0;
  private offFrame: () => void;

  constructor(o: PlayerActorOptions) {
    this.seat = o.seat;
    this.geo = o.geo;
    this.clock = o.clock;
    this.frames = o.frames ?? null;
    this.root.label = `actor:${o.seat}`;
    this.shadow.ellipse(0, 0, 22, 9).fill({ color: 0x000000, alpha: 0.22 });
    this.sprite.anchor.set(0.5, 150 / 160);
    this.sprite.scale.set(ACTOR_SCALE);
    this.drawPawn();
    this.body.addChild(this.pawn, this.sprite);
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

  setName(name: string): void {
    for (const c of this.tag.removeChildren()) c.destroy();
    const color = PLAYER_COLORS[this.seat % 4] ?? 0xffffff;
    const t = new Text({
      text: `${PLAYER_MARKS[this.seat % 4] ?? ''} ${name}`,
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
    this.tag.position.set(0, -112 * ACTOR_SCALE - 14);
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
    this.root.zIndex = depthOfCell(this.geo.viewCell(c), DepthBias.Actor) + this.seat * 0.01;
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

  /** 旋转或偏移变化后重新计算屏幕位置与朝向 */
  relayout(): void {
    if (this.dead) return;
    const s = this.geo.toScreen(this.pos);
    this.root.position.set(s.x + this.offset.x, s.y + this.offset.y);
    this.body.position.set(0, -this.hopY);
    this.shadow.scale.set(1 - (this.hopY / HOP_PX) * 0.25);
    if (this._tile !== null && !this.walking) {
      const c = this.geo.tileCell(this._tile);
      this.root.zIndex = depthOfCell(this.geo.viewCell(c), DepthBias.Actor) + this.seat * 0.01;
    }
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
        // 正常走完或被中止，都以终点格收尾（中止 = 跳过动画直达终态）
        this.teleport(last);
        this.applyFrames();
      }
    }
  }

  get destroyed(): boolean {
    return this.dead;
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.offFrame();
    this.root.destroy({ children: true });
  }

  // ───────── 内部 ─────────

  private tickIdle(dt: number): void {
    if (this.walking) return;
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
