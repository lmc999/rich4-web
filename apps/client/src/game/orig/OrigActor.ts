// 原版棋子（original-skin.md §5 A7；design-draft §3.3「棋子」、render.md §2.6–§2.7）：
// - 21 套姿态库按角色懒加载（char.<c> 组的逻辑键，poses.ts 选择）；8 方向行走帧按世界位移定方向（frames.ts），
//   帧号 = ((8 − view + dir) & 7) · perDir + anim，行走动画约 40 ms 一帧（动画时钟）；
// - 每格行走在节点世界坐标之间直线插值（原版忽略 via 连接格；原版速度表 [8,12,16,8] px/tick 只作参考，
//   时长遵循 pacing 预算：每步 stepMs）；
// - 机车 / 汽车 / 快艇（快艇节点段）/ 梦游 / 乞丐外观；工程车（k=9–11，guess）走程序化载具回退；
// - 关押 / 住旅馆期间人在建筑里（setInside）：画点放到景观 / 旅馆上、不画本体与名牌（附身神明、炸弹一起不画）；获释时
//   walkOut 从建筑走一步到格上，前半程看不见、过半出现；住旅馆时 walkIn 反过来（原版 fcn.0040bb40 的 bit4 / bit5 分支）；
// - 掷骰动作（throwDice）：等待掷骰时静止站立；收到掷骰结果后把持骰库每方向的帧逐 tick 播一遍（抱骰 → 抛出 → 空手），
//   停在最后一帧直到开始行走（exe fcn.0040d28a case 2 0x40d43b–0x40d470；渲染 0x4083a9 帧 = 方向槽 × perDir + 计数）；
// - 附身神明、身上的定时炸弹（原版附身物件）、冬眠 / 梦游 ZZZ、乌龟；头顶名牌与聊天 / 表情气泡；同格多人偏移；
// - 开局跳伞：hop 时若刚被放上棋盘，播角色的棋盘伞 FLIC（Data#518–529，按预算 playFit），素材不可用时程序化降落。
// 测试钩子与程序化 PlayerActor 同形：seat、tile、isWalking、root（visible、children 的 label 'speech'）、currentStatus。
import { attachedObjectFrame } from '@rich4/shared/assets';
import { GOD_KEYS, type TileId } from '@rich4/shared/data';
import type { GodKind, Vehicle, VillainKind } from '@rich4/shared/engine';
import { WALK_OUT, walkOutSwitchTick, walkOutTicks } from '@rich4/shared/view';
import { CanvasSource, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { FlicPlayer } from '../../skin/flic/FlicPlayer';
import { ORIGINAL_FONT_STACK } from '../../skin/theme';
import { type ActorStatus, ICE_TINT, NO_STATUS, sameStatus, tortoiseShell } from '../actors/ActorStatus';
import { STEP_MS } from '../actors/PlayerActor';
import { vehicleGraphics } from '../actors/Vehicle';
import type { AnimClock } from '../anim/AnimClock';
import { cubicOut, hopArc, linear } from '../anim/easing';
import { tweenValue } from '../anim/tween';
import { HOP_MS } from '../fx/timings';
import type { Pt } from '../iso/projection';
import { INK } from '../procedural/building/styles';
import { OrigLayer, origDepth } from './depth';
import type { OrigAssets, SpriteSheet } from './OrigAssets';
import type { OrigProjection } from './OrigProjection';
import {
  characterPose,
  dirOfWorldStep,
  dollPose,
  needsOverlay,
  type PoseChoice,
  type PoseMode,
  sheetFrame,
  villainPose,
  WALK_FRAME_MS,
  ZZZ_FRAME_MS,
} from './poses';

/** 头顶聊天气泡最多显示的字数（与程序化一致） */
export const ORIG_SAY_MAX_CHARS = 18;
/** 同格多人时按座位的偏移（棋盘坐标，源像素） */
export const ORIG_SEAT_OFFSETS: readonly Pt[] = [
  { x: -10, y: -4 },
  { x: 10, y: -4 },
  { x: -10, y: 5 },
  { x: 10, y: 5 },
];
/** 同格多人时名牌之间的间隙（源像素）：名牌按各自高度 + 间隙逐个抬高，免得名字叠在一起 */
export const ORIG_TAG_GAP = 1;
/** 没有精灵时的身高（占位棋子与名牌高度） */
const PLACEHOLDER_H = 40;
/** 附身神明相对脚底的偏移（原版表 0x4727fd 的 dirIdx 0 项；其余方向未解码，统一使用） */
const GOD_OFFSET: Pt = { x: -10, y: -22 };
/** 身上定时炸弹的偏移（原版表 0x47283d 的 dirIdx 0 项） */
const BOMB_OFFSET: Pt = { x: -18, y: -44 };
/**
 * 引信数字的底边在炸弹精灵下沿之上这么多（源像素）。原版在 (sx, sy−60) 画 "%d"，那里是我们放名牌的位置：
 * 这里改画在炸弹精灵的下部，并挂在名牌之后（最上层），名牌怎么抬高都挡不住
 */
const FUSE_INSET = 3;
/** 开局跳伞的可用时长（没有事件上下文时）：PARACHUTE 紧凑预算 1500 − focus 400 − 收尾 200 − 余量 */
export const PARACHUTE_FIT_MS = 850;
/** 程序化降落（没有棋盘伞 FLIC 时） */
const DROP_MS = 620;
const DROP_PX = 140;
/** 原版 440×440 的棋盘 FLIC：落点在视窗中心 */
const BOARD_FLIC_CENTER = 220;

export type OrigActorKind =
  | { t: 'player'; character: number }
  | { t: 'villain'; villain: VillainKind }
  /** 机器娃娃（原版舞台的清道演出） */
  | { t: 'doll' };

export interface OrigActorOptions {
  seat: number;
  kind: OrigActorKind;
  assets: OrigAssets;
  proj: OrigProjection;
  clock: AnimClock;
  /** 节点 → 世界坐标 */
  tileWorld(id: TileId): Pt | null;
  /** 快艇节点（原版 flags bit31） */
  boatTiles: ReadonlySet<TileId>;
  /** 代表色（名牌、占位、程序化载具） */
  color: number;
  /** 基础深度层（玩家 0xC、NPC 8） */
  layer?: number;
  name?: string;
}

export interface OrigWalkOptions {
  stepMs?: number;
  signal?: AbortSignal;
  onStep?: (tile: TileId, i: number) => void;
}

/** 走出 / 走进建筑（原版 tick 匀速，见 shared/view/pacing 的 WALK_OUT） */
export interface OrigWalkOutOptions {
  /** 原版 tick（ms） */
  tickMs: number;
  signal?: AbortSignal;
  /** 走出：画出来的那一刻（调用方据此换掉关押状态）；中止时也会调用 */
  onShow?: () => void;
}

const samePt = (a: Pt | null, b: Pt | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y);

export class OrigActor {
  readonly root = new Container({ label: 'actor' });
  readonly seat: number;
  readonly kind: OrigActorKind;
  private readonly body = new Container({ label: 'body' });
  private readonly behind = new Container({ label: 'behind' });
  private readonly sprite = new Sprite();
  private readonly pawn = new Graphics();
  private readonly ride = new Container({ label: 'ride' });
  private readonly tag = new Container({ label: 'tag' });
  /** 名牌高度（源像素；同格多人时按它错开） */
  private tagH = 0;
  private godSprite: Sprite | null = null;
  /** 身上的定时炸弹：精灵在角色身后（behind），引信数字挂在 root 最上层（名牌之后） */
  private bomb: { sprite: Sprite; fuse: Text } | null = null;
  private zzz: Sprite | null = null;
  private shell: Graphics | null = null;
  private speech: { root: Container; timer: ReturnType<typeof setTimeout> } | null = null;
  private status: ActorStatus = NO_STATUS;
  private readonly o: OrigActorOptions;
  private _tile: TileId | null = null;
  private pos: Pt = { x: 0, y: 0 };
  private dir = 0;
  private boat = false;
  private walking = false;
  private walkMs = 0;
  private idleMs = 0;
  private hopY = 0;
  private offset: Pt = { x: 0, y: 0 };
  private tagLift = 0;
  private tagBase: number | null = null;
  private current = false;
  /** 掷骰动作的帧（持骰库每方向内的下标）；null = 不在持骰姿态 */
  private throwFrame: number | null = null;
  /**
   * 掷骰动作的代号：每次 throwDice、clearThrow、开始行走都加 1。throwDice 等待持骰库下载或逐帧等待之后，代号变了就不再
   * 摆姿态——EventPlayer.reset 先同步中止当前 handler、再 syncBoard（clearThrow），被中止的 throwDice 在之后的微任务里才继续，
   * 不能在同步之后又把持骰姿态摆回去
   */
  private throwToken = 0;
  private landing: TileId | null = null;
  /** 刚被放上棋盘、等下一次 hop 播降落：本体与名牌先藏起来（镜头推移、FLIC 载入期间不先站在落点上） */
  private dropPending = false;
  /** 正在播棋盘伞 FLIC（本体先藏起来，落地后出现） */
  private dropping = false;
  /** 棋盘伞 FLIC 的精灵（画在飞行物层时随换视角重新定位） */
  private chute: Sprite | null = null;
  private overlayKind: Exclude<Vehicle, 'walk'> | null = null;
  private headH = PLACEHOLDER_H;
  private usedKey: string | null = null;
  private frame = -1;
  private dead = false;
  private readonly offFrame: () => void;
  /** 取棋盘伞 FLIC 播放器（有素材时由控制器设置） */
  parachute: ((signal: AbortSignal) => Promise<FlicPlayer | null>) | null = null;
  /** 棋盘伞 FLIC 的可用时长（原版舞台按当前节奏的 PARACHUTE 预算给出；缺省 PARACHUTE_FIT_MS） */
  dropFitMs: (() => number) | null = null;
  /** 飞行物层（棋盘伞 FLIC 画在这里）；缺省画在自己身上 */
  flyLayer: Container | null = null;
  /** 名牌要让开的高度变了（冬眠 / 梦游的 ZZZ 出现或消失）：渲染器据此重排同格多人的名牌 */
  onClearanceChange: (() => void) | null = null;
  private lastClearance = -1;
  /** 人在建筑里（关押、住旅馆）：建筑的世界坐标；画点放在这里，不画本体与名牌。null = 在棋盘上 */
  private inside: Pt | null = null;
  /** 走出 / 走进建筑时看不见的那半程 */
  private veiled = false;
  /** 行走中收到的「在建筑里」同步（undefined = 没有）：行走收尾后再套用 */
  private insideLanding: Pt | null | undefined = undefined;

  constructor(o: OrigActorOptions) {
    this.o = o;
    this.seat = o.seat;
    this.kind = o.kind;
    this.root.label =
      o.kind.t === 'player' ? `actor:${o.seat}` : o.kind.t === 'villain' ? `villain:${o.kind.villain}` : 'doll';
    this.pawn
      .roundRect(-7, -26, 14, 24, 7)
      .fill(o.color)
      .stroke({ width: 2, color: INK })
      .circle(0, -32, 7)
      .fill(0xffe0c2)
      .stroke({ width: 2, color: INK });
    this.pawn.visible = false;
    this.body.addChild(this.behind, this.ride, this.pawn, this.sprite);
    this.root.addChild(this.body, this.tag);
    if (o.name) this.setName(o.name);
    this.offFrame = o.clock.onFrame((_now, dt) => this.tick(dt));
    this.refresh();
  }

  // ───────────────────────── 状态读取（测试钩子同形） ─────────────────────────

  get tile(): TileId | null {
    return this._tile;
  }

  get isWalking(): boolean {
    return this.walking;
  }

  get currentStatus(): ActorStatus {
    return this.status;
  }

  get destroyed(): boolean {
    return this.dead;
  }

  /** 方向槽（0 南 +y、2 东 +x、4 北、6 西） */
  get facing(): number {
    return this.dir;
  }

  /** 当前使用的姿态库逻辑键（没有精灵为 null） */
  get poseKey(): string | null {
    return this.usedKey;
  }

  get frameIndex(): number {
    return this.frame;
  }

  /** 屏幕方向槽 (8 − 视角 + 朝向) & 7（帧号、原版骰子 FLC 画点表 0x4730ac 的下标） */
  get screenDir(): number {
    return (8 - this.o.proj.view + this.dir) & 7;
  }

  /** 正在摆持骰姿态（掷骰动作中，或动作播完停在最后一帧） */
  get throwing(): boolean {
    return this.throwFrame !== null;
  }

  get inBoat(): boolean {
    return this.boat;
  }

  /** 世界坐标（连续） */
  get worldPos(): Pt {
    return { ...this.pos };
  }

  /** 脚底的棋盘坐标（含同格偏移；镜头跟随、飘字锚点） */
  boardPos(): Pt {
    return { x: this.root.position.x, y: this.root.position.y };
  }

  /** 头顶（名牌下沿）的棋盘坐标 */
  headPos(): Pt {
    return { x: this.root.position.x, y: this.root.position.y - this.headH - this.hopY };
  }

  get height(): number {
    return this.headH;
  }

  /** 名牌高度（源像素；没有名牌为 0） */
  get tagHeight(): number {
    return this.tagH;
  }

  /** 名牌基线要让开的高度（源像素）：身高，冬眠 / 梦游时还要让开头顶的 ZZZ（同格多人的名牌按其中最高者排开） */
  get tagClearance(): number {
    const z = this.zzzTop();
    return Math.max(this.headH, z === null ? 0 : z - 2);
  }

  /** 等待开局降落（本体与名牌暂时藏起） */
  get awaitingDrop(): boolean {
    return this.dropPending;
  }

  /** 人在建筑里（关押、住旅馆） */
  get insideBuilding(): boolean {
    return this.inside !== null;
  }

  /** 所在建筑的世界坐标（不在建筑里为 null） */
  get insideWorld(): Pt | null {
    return this.inside ? { ...this.inside } : null;
  }

  /** 棋盘上看不见本体（出国、乞丐、在建筑里、走出 / 走进建筑看不见的半程）：同格多人不为它错开 */
  get offBoard(): boolean {
    return this.status.away || this.status.beggar || this.inside !== null || this.veiled;
  }

  // ───────────────────────── 设置 ─────────────────────────

  setName(name: string): void {
    for (const c of this.tag.removeChildren()) c.destroy({ children: true });
    const t = new Text({
      text: name,
      style: { fontFamily: ORIGINAL_FONT_STACK, fontSize: 12, fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
      resolution: 2,
    });
    t.anchor.set(0.5, 1);
    const w = Math.ceil(t.width) + 10;
    const h = Math.ceil(t.height) + 2;
    const bg = new Graphics()
      .rect(-w / 2, -h, w, h)
      .fill({ color: 0x000000, alpha: 0.55 })
      .rect(-w / 2, -3, w, 3)
      .fill(this.o.color);
    t.position.set(0, -3);
    this.tag.addChild(bg, t);
    this.tagH = h;
    this.placeTag();
  }

  /** 行走中收到权威落点时先记下，收尾时落到这里（同 PlayerActor.settleAt） */
  settleAt(tile: TileId): void {
    if (this.walking) this.landing = tile;
    else if (this._tile !== tile) this.teleport(tile);
  }

  teleport(tile: TileId): void {
    if (this.dead) return;
    const w = this.o.tileWorld(tile);
    if (!w) return;
    this._tile = tile;
    this.pos = { ...w };
    this.hopY = 0;
    this.boat = this.o.boatTiles.has(tile);
    this.relayout();
    this.refresh();
  }

  /** 朝向（方向槽 0..7） */
  setFacing(dir: number): void {
    this.dir = dir & 7;
    this.refresh();
  }

  setOffset(p: Pt): void {
    this.offset = { ...p };
    this.relayout();
  }

  /**
   * 名牌额外抬高（同格多人错开名牌）；base 为同格各人里最高的身高（名牌按同一基线排开）。
   * 同格时（base 不为 null）名牌不跟随座位的左右偏移，统一居中后纵向排开
   */
  setTagLift(px: number, base: number | null = null): void {
    if (this.tagLift === px && this.tagBase === base) return;
    this.tagLift = px;
    this.tagBase = base;
    this.placeTag();
  }

  /** 当前行动者：深度层 0xD */
  setCurrent(on: boolean): void {
    if (this.current === on) return;
    this.current = on;
    this.relayout();
    this.refresh();
  }

  /**
   * 掷骰动作：持骰库（按当前外观：步行 / 机车 / 汽车 / 快艇）每方向的帧逐 tick 播一遍，播完停在最后一帧（空手）直到
   * 开始行走或 clearThrow。没有持骰库（梦游、住院、坐牢、素材缺失）时不动；instant 或中止时直接落到最后一帧
   */
  async throwDice(tickMs: number, signal?: AbortSignal): Promise<void> {
    if (this.dead || this.walking) return;
    const token = ++this.throwToken;
    const live = (): boolean => !this.dead && !this.walking && this.throwToken === token;
    const got = await this.diceSheet(signal);
    if (!live() || !got) return;
    // 为下载持骰库等过、其间演出被中止（封顶、reset、skipAll）：不再摆姿态，接下来就是行走或批尾同步
    if (got.waited && signal?.aborted) return;
    const sheet = got.sheet;
    const perDir = sheet.dirs === 8 ? Math.max(1, Math.trunc(sheet.count / 8)) : Math.max(1, sheet.count);
    const clock = this.o.clock;
    const quick = (): boolean => clock.instant || signal?.aborted === true;
    this.throwFrame = quick() ? perDir - 1 : 0;
    this.refresh();
    // 原版：计数每 tick +1，到 perDir 才掷骰，所以每帧都停留一个 tick。按起点算绝对时刻（逐帧等待不累积误差）
    const t0 = clock.now();
    for (let f = 1; f <= perDir && !quick(); f++) {
      const due = t0 + f * tickMs - clock.now();
      if (due > 0) await clock.wait(due, signal);
      if (!live() || this.throwFrame === null) return;
      if (f < perDir) {
        this.throwFrame = f;
        this.refresh();
      }
    }
    if (live() && this.throwFrame !== null && this.throwFrame !== perDir - 1) {
      this.throwFrame = perDir - 1;
      this.refresh();
    }
  }

  /** 收起持骰姿态（开始行走、表情姿态、批尾同步）；还在等持骰库下载的 throwDice 随之作废 */
  clearThrow(): void {
    this.throwToken++;
    if (this.throwFrame === null) return;
    this.throwFrame = null;
    this.refresh();
  }

  /**
   * 首个可用的持骰库（按姿态候选的次序）；候选里第一个可用的不是持骰库（回退到站姿）时为 null。
   * waited：为下载等过（没有预取到的库，例如第一次在快艇上掷骰）
   */
  private async diceSheet(signal?: AbortSignal): Promise<{ sheet: SpriteSheet; waited: boolean } | null> {
    let waited = false;
    for (const k of this.choice('dice').keys) {
      let s: SpriteSheet | null;
      if (this.o.assets.settled(k)) s = this.o.assets.sheetNow(k);
      else {
        waited = true;
        s = await this.o.assets.sheet(k);
      }
      if (this.dead || signal?.aborted) return s && k.endsWith('.dice') ? { sheet: s, waited } : null;
      if (s) return k.endsWith('.dice') ? { sheet: s, waited } : null;
    }
    return null;
  }

  /** 状态外观（幂等） */
  setStatus(s: ActorStatus): void {
    if (this.dead || sameStatus(this.status, s)) return;
    const prev = this.status;
    this.status = s;
    if (prev.vehicle !== s.vehicle || prev.sleepwalk !== s.sleepwalk) this.preload();
    this.applyStatusDecor();
    this.refresh();
  }

  /** 预取当前状态下站、走、持骰三种姿态的精灵库（行走、掷骰开始前就绪，帧选择不用等加载） */
  preload(): void {
    for (const mode of ['stand', 'walk', 'dice'] as const) {
      for (const k of this.choice(mode).keys) void this.o.assets.sheet(k);
    }
  }

  /** 附身神明（null 取消）；不经过 setStatus 时供演出直接调用 */
  setGod(kind: GodKind | null): void {
    this.status = { ...this.status, god: kind };
    this.applyStatusDecor();
  }

  /** 棋盘刚放上（开局跳伞）：下一次 hop 播降落；在那之前本体与名牌不显示 */
  markDrop(): void {
    if (this.dead || this.dropPending) return;
    this.dropPending = true;
    this.refresh();
  }

  /** 取消还没开始的降落（批次结束时仍未 hop：直接出现在落点上） */
  cancelDrop(): void {
    if (this.dead || !this.dropPending) return;
    this.dropPending = false;
    this.refresh();
  }

  /**
   * 人在建筑里（world = 景观 / 旅馆的世界坐标）或回到棋盘（null）：在建筑里时画点放到建筑上（镜头、气泡跟着它），
   * 本体、名牌、附身神明与炸弹都不画；节点不变（tile 仍是关押格 / 旅馆门前的格）。行走中（含走出 / 走进建筑）先记下，收尾时套用
   */
  setInside(world: Pt | null): void {
    if (this.dead) return;
    if (this.walking) {
      this.insideLanding = world ? { ...world } : null;
      return;
    }
    if (samePt(this.inside, world)) return;
    this.inside = world ? { ...world } : null;
    this.relayout();
    this.refresh();
  }

  // ───────────────────────── 布局 ─────────────────────────

  /** 换视角或位移后重新计算棋盘位置、深度与帧 */
  relayout(): void {
    if (this.dead) return;
    const p = this.o.proj.projectPx(this.inside ?? this.pos);
    const x = p.x + this.offset.x;
    const y = p.y + this.offset.y;
    this.root.position.set(x, y);
    this.body.position.set(0, -Math.round(this.hopY));
    const layer = this.o.layer ?? OrigLayer.Player;
    // 深度键按实际画点（含同格座位偏移）：站在前排（偏移 y 更大）的人画在后排之上；当前行动者 0xD 只决定同一 y 的次序
    this.root.zIndex = origDepth(y, this.current ? layer + 1 : layer);
    // 棋盘伞 FLIC（飞行物层，棋盘坐标）：换视角时跟着脚底重新定位
    if (this.chute && !this.chute.destroyed && this.flyLayer) {
      this.chute.position.set(x - BOARD_FLIC_CENTER, y - BOARD_FLIC_CENTER);
    }
  }

  /** 换视角：帧与位置都重算 */
  onViewChanged(): void {
    this.relayout();
    this.refresh();
    this.applyStatusDecor();
  }

  private mode(): PoseMode {
    if (this.walking) return 'walk';
    return this.throwFrame !== null ? 'dice' : 'stand';
  }

  private choice(mode: PoseMode): PoseChoice {
    if (this.kind.t === 'villain') return villainPose(this.kind.villain, mode, this.boat);
    if (this.kind.t === 'doll') return dollPose(mode);
    // 关押期间棋子不画（原版 0x4082a5–0x4082c3），不再选关押姿态库；走出建筑过半出现时已换成获释后的状态
    return characterPose(this.kind.character, mode, {
      vehicle: this.status.vehicle,
      boat: this.boat,
      sleepwalk: this.status.sleepwalk,
      confined: null,
      beggar: false,
    });
  }

  /** 选姿态库与帧（首选库还在加载时先用已就绪的后备库，加载完成后重选） */
  private refresh(): void {
    if (this.dead) return;
    const mode = this.mode();
    const choice = this.choice(mode);
    let sheet: SpriteSheet | null = null;
    let used: string | null = null;
    for (const k of choice.keys) {
      if (this.o.assets.settled(k)) {
        const s = this.o.assets.sheetNow(k);
        if (s) {
          sheet = s;
          used = k;
          break;
        }
        continue;
      }
      void this.o.assets.sheet(k).then(() => {
        if (!this.dead) this.refresh();
      });
    }
    this.usedKey = used;
    const anim = this.walking ? Math.floor(this.walkMs / WALK_FRAME_MS) : mode === 'dice' ? (this.throwFrame ?? 0) : 0;
    if (sheet) {
      const f = sheetFrame(sheet, this.dir, this.o.proj.view, anim);
      this.frame = f;
      const tex = sheet.frames[f];
      const [ax, ay] = sheet.anchors[f] ?? [0, 0];
      if (tex) this.sprite.texture = tex;
      this.sprite.position.set(-ax, -ay);
      this.sprite.visible = true;
      this.pawn.visible = false;
      this.headH = Math.max(12, ay);
    } else {
      this.frame = -1;
      this.sprite.visible = false;
      this.pawn.visible = this.o.assets.settled(choice.keys[choice.keys.length - 1]!) || choice.keys.length === 0;
      this.headH = PLACEHOLDER_H;
    }
    this.applyOverlay(needsOverlay(choice, used));
    const hidden = this.offBoard || this.dropping || this.dropPending;
    this.body.visible = !hidden;
    this.tag.visible = !hidden;
    this.sprite.tint = this.status.hibernate ? ICE_TINT : 0xffffff;
    this.placeTag();
  }

  /** ZZZ 最高点（相对脚底，源像素；各帧锚点 y 的最大值）；没有 ZZZ 为 null */
  private zzzTop(): number | null {
    if (!this.zzz?.visible) return null;
    const sheet = this.o.assets.sheetNow('object.zzz');
    if (!sheet) return null;
    let top = 0;
    for (const a of sheet.anchors) top = Math.max(top, a[1]);
    return top;
  }

  private placeTag(): void {
    const hop = Math.round(this.hopY);
    const head = Math.max(this.headH, this.tagBase ?? 0);
    // ZZZ 画在头顶（锚点把它抬到脚底上方 ~57–77）：名牌让到它上面
    const z = this.zzzTop();
    const zzzLift = z === null ? 0 : Math.max(0, z + 2 - (head + 4));
    const extra = zzzLift + this.tagLift;
    // 同格多人：名牌不跟座位偏移（抵消 root 上的偏移），在格子的同一基线上居中、纵向排开
    const shared = this.tagBase !== null;
    const tx = shared ? -this.offset.x : 0;
    const ty = shared ? -this.offset.y : 0;
    this.tag.position.set(tx, ty - head - 4 - extra - hop);
    this.speech?.root.position.set(tx, ty - head - 4 - this.tagH - 2 - extra - hop);
    this.placeFuse();
  }

  /** 引信数字：炸弹精灵下部的正中（精灵不可用时在原版偏移处），跟着跳动；本体藏起时一起藏 */
  private placeFuse(): void {
    const b = this.bomb;
    if (!b) return;
    const spr = b.sprite;
    let x = BOMB_OFFSET.x;
    let y = BOMB_OFFSET.y;
    if (spr.visible && spr.texture !== Texture.EMPTY) {
      x = spr.position.x + spr.texture.frame.width / 2;
      y = spr.position.y + spr.texture.frame.height - FUSE_INSET;
    }
    b.fuse.position.set(Math.round(x), Math.round(y) - Math.round(this.hopY));
    b.fuse.visible = this.body.visible;
  }

  private applyOverlay(v: Exclude<Vehicle, 'walk'> | null): void {
    if (v === this.overlayKind) return;
    this.overlayKind = v;
    for (const c of this.ride.removeChildren()) c.destroy({ children: true });
    if (v) {
      const g = vehicleGraphics(v, this.o.color);
      g.scale.set(0.45);
      this.ride.addChild(g);
    }
  }

  /** 附身神明、炸弹、ZZZ、乌龟（原版附身物件：帧 = (dirIdx + 4) & 7） */
  private applyStatusDecor(): void {
    if (this.dead) return;
    const s = this.status;
    const screenDir = (8 - this.o.proj.view + this.dir) & 7;
    // 附身神明
    if (s.god !== null && s.god !== 11) {
      const sheet = this.o.assets.sheetNow(`object.${GOD_KEYS[s.god]}`);
      if (!this.godSprite) {
        this.godSprite = new Sprite();
        this.godSprite.label = 'god';
        this.behind.addChild(this.godSprite);
      }
      this.putObject(this.godSprite, sheet, attachedObjectFrame(screenDir), GOD_OFFSET);
      if (!sheet) void this.o.assets.sheet(`object.${GOD_KEYS[s.god]}`).then(() => this.applyStatusDecor());
    } else if (this.godSprite) {
      this.godSprite.destroy();
      this.godSprite = null;
    }
    // 身上的定时炸弹
    if (s.bomb !== null) {
      if (!this.bomb) {
        const sprite = new Sprite();
        sprite.label = 'bomb';
        const fuse = new Text({
          text: '',
          style: {
            fontFamily: ORIGINAL_FONT_STACK,
            fontSize: 13,
            fontWeight: 'bold',
            fill: 0xffe066,
            stroke: { color: 0, width: 3 },
          },
          resolution: 2,
        });
        fuse.label = 'fuse';
        fuse.anchor.set(0.5, 1);
        this.behind.addChild(sprite);
        // 名牌之后（最上层）：名牌怎么抬高都不会把数字挡住
        this.root.addChild(fuse);
        this.bomb = { sprite, fuse };
      }
      const sheet = this.o.assets.sheetNow('object.bomb');
      this.putObject(this.bomb.sprite, sheet, attachedObjectFrame(screenDir), BOMB_OFFSET);
      if (!sheet) void this.o.assets.sheet('object.bomb').then(() => this.applyStatusDecor());
      this.bomb.fuse.text = String(s.bomb);
    } else if (this.bomb) {
      this.bomb.sprite.destroy();
      this.bomb.fuse.destroy();
      this.bomb = null;
    }
    // ZZZ（冬眠、梦游）
    if (s.hibernate || s.sleepwalk) {
      if (!this.zzz) {
        this.zzz = new Sprite();
        this.zzz.label = 'zzz';
        // 原版的 ZZZ 是按角色脚底画的独立物件（锚点 y 约 74–77，已经把它抬到头顶）：挂在本体上、以脚底为画点
        this.body.addChild(this.zzz);
      }
      const sheet = this.o.assets.sheetNow('object.zzz');
      this.zzz.visible = sheet !== null;
      if (!sheet) void this.o.assets.sheet('object.zzz').then(() => this.applyStatusDecor());
      this.animateZzz();
    } else if (this.zzz) {
      this.zzz.destroy();
      this.zzz = null;
    }
    // 乌龟（原版没有对应精灵：程序化小龟壳）
    if (s.tortoise && !this.shell) {
      this.shell = tortoiseShell();
      this.shell.scale.set(0.4);
      this.behind.addChild(this.shell);
    } else if (!s.tortoise && this.shell) {
      this.shell.destroy();
      this.shell = null;
    }
    this.placeTag();
    const c = this.tagClearance;
    if (c !== this.lastClearance) {
      this.lastClearance = c;
      this.onClearanceChange?.();
    }
  }

  private putObject(spr: Sprite, sheet: SpriteSheet | null, frame: number, at: Pt): void {
    if (!sheet) {
      spr.visible = false;
      return;
    }
    const f = sheet.dirs === 8 ? frame : 0;
    const [ax, ay] = sheet.anchors[f] ?? [0, 0];
    spr.texture = sheet.frames[f] ?? Texture.EMPTY;
    spr.position.set(at.x - ax, at.y - ay);
    spr.visible = true;
  }

  private animateZzz(): void {
    const z = this.zzz;
    const sheet = this.o.assets.sheetNow('object.zzz');
    if (!z || !sheet) return;
    const f = Math.floor(this.idleMs / ZZZ_FRAME_MS) % Math.max(1, sheet.count);
    const [ax, ay] = sheet.anchors[f] ?? [0, 0];
    z.texture = sheet.frames[f] ?? Texture.EMPTY;
    z.position.set(-ax, -ay);
  }

  private tick(dt: number): void {
    if (this.dead) return;
    const prevWalk = Math.floor(this.walkMs / WALK_FRAME_MS);
    const prevZ = Math.floor(this.idleMs / ZZZ_FRAME_MS);
    if (this.walking) this.walkMs += dt;
    this.idleMs += dt;
    // 站姿与持骰姿态不随时间循环（原版等待掷骰时静止；掷骰动作由 throwDice 逐 tick 推进）
    if (this.walking && Math.floor(this.walkMs / WALK_FRAME_MS) !== prevWalk) this.refresh();
    if (this.zzz && Math.floor(this.idleMs / ZZZ_FRAME_MS) !== prevZ) this.animateZzz();
  }

  // ───────────────────────── 演出 ─────────────────────────

  /**
   * 沿路径逐格行走（path[0] 为当前格）：一条时间线驱动整条路径（总时长 = 步数 × stepMs），
   * 每段在两个节点的世界坐标之间直线插值；中止时立即落到终点（行走中收到的权威落点优先）。
   */
  async walk(path: readonly TileId[], o: OrigWalkOptions = {}): Promise<void> {
    if (this.dead || path.length === 0) return;
    this.landing = null;
    this.insideLanding = undefined;
    // 在建筑里的人不会走路（关押期间不掷骰）；万一收到行走，先回到棋盘上
    if (this.inside) this.setInside(null);
    const last = path[path.length - 1]!;
    if (this._tile !== path[0]) this.teleport(path[0]!);
    if (path.length === 1) return;
    const pts = path.map((t) => this.o.tileWorld(t));
    if (pts.some((p) => p === null)) {
      this.teleport(last);
      return;
    }
    const w = pts as Pt[];
    const n = path.length - 1;
    const stepMs = o.stepMs ?? STEP_MS;
    let arrived = 0;
    let seg = -1;
    const enter = (i: number): void => {
      const d = dirOfWorldStep(w[i]!, w[i + 1]!);
      if (d !== null) this.dir = d;
      this.boat = this.o.boatTiles.has(path[i]!) || this.o.boatTiles.has(path[i + 1]!);
      this.applyStatusDecor();
    };
    this.walking = true;
    this.walkMs = 0;
    this.throwFrame = null;
    this.throwToken++;
    try {
      await tweenValue(
        0,
        n,
        n * stepMs,
        (x) => {
          if (this.dead) return;
          const done = Math.min(n, Math.floor(x + 1e-9));
          while (arrived < done) {
            arrived++;
            this._tile = path[arrived]!;
            if (!o.signal?.aborted) o.onStep?.(this._tile, arrived);
          }
          const i = Math.min(n - 1, Math.floor(x));
          const t = Math.min(1, Math.max(0, x - i));
          const a = w[i]!;
          const b = w[i + 1]!;
          this.pos = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          this.relayout();
          if (i !== seg) {
            seg = i;
            enter(i);
            this.refresh();
          }
        },
        { clock: this.o.clock, signal: o.signal, ease: linear },
      );
    } finally {
      this.settleWalk(last);
    }
  }

  /** 行走收尾：落到 tile（行走中收到的权威落点优先），再套用行走中收到的「在建筑里」同步 */
  private settleWalk(tile: TileId): void {
    this.walking = false;
    this.veiled = false;
    if (this.dead) return;
    this.teleport(this.landing ?? tile);
    this.landing = null;
    const inside = this.insideLanding;
    this.insideLanding = undefined;
    if (inside !== undefined) this.setInside(inside);
  }

  /** 走出 / 走进建筑的一段：从 a 到 b 按原版 tick 匀速走，第 switchTick 个 tick 走完时调用 onSwitch（中止时直接到终点） */
  private async walkSegment(
    a: Pt,
    b: Pt,
    ticks: number,
    o: { tickMs: number; signal?: AbortSignal; onSwitch: () => void },
  ): Promise<void> {
    const at = walkOutSwitchTick(ticks);
    let switched = false;
    // 原版行走中不改朝向（0x40befb：bit4 / bit5 时跳过按来路取朝向），朝向在获释时按建筑 → 格算好（0x40d1d5）
    const d = dirOfWorldStep(a, b);
    if (d !== null) this.dir = d;
    this.applyStatusDecor();
    this.walking = true;
    this.walkMs = 0;
    this.throwFrame = null;
    this.throwToken++;
    this.pos = { ...a };
    this.relayout();
    this.refresh();
    await tweenValue(
      0,
      ticks,
      ticks * o.tickMs,
      (x) => {
        if (this.dead) return;
        const t = Math.min(1, x / ticks);
        this.pos = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        this.relayout();
        if (!switched && x >= at - 1e-9) {
          switched = true;
          o.onSwitch();
        }
      },
      { clock: this.o.clock, signal: o.signal, ease: linear },
    );
  }

  /**
   * 获释：从所在的建筑走一步到格 to（原版 fcn.0040bb40 的 bit4 分支）：起点是建筑坐标、终点是节点坐标，每 tick 8 px，
   * tick 数 = trunc(距离 / 8)；前半程看不见，剩余 tick 少于一半时画出来（onShow，调用方在这一刻换掉关押状态），走到停在 to。
   * 不在建筑里（找不到建筑）时直接在 to 上出现。中止时立即落到 to 并显示
   * @source exe v2.06 0x40d184（获释：朝向 = 当前坐标 → 节点）、0x40bba3–0x40bbcc（bit4：起点当前坐标、终点节点）、
   *         0x40bd5a（8 px / tick）、0x40bdec（fcn.0045641c 截断取整）、0x40be98–0x40beb3（过半清计数，从此画出来）
   */
  async walkOut(to: TileId, o: OrigWalkOutOptions): Promise<void> {
    if (this.dead) return;
    const from = this.walking ? null : this.inside;
    const end = this.o.tileWorld(to);
    if (!from || !end) {
      if (!this.walking) {
        this.inside = null;
        this.teleport(to);
      }
      o.onShow?.();
      return;
    }
    const ticks = walkOutTicks(Math.hypot(end.x - from.x, end.y - from.y));
    this.landing = null;
    this.insideLanding = undefined;
    this.inside = null;
    this.veiled = true;
    this._tile = to;
    this.boat = this.o.boatTiles.has(to);
    let shown = false;
    const show = (): void => {
      if (shown) return;
      shown = true;
      this.veiled = false;
      this.refresh();
      o.onShow?.();
    };
    try {
      await this.walkSegment(from, end, ticks, { tickMs: o.tickMs, signal: o.signal, onSwitch: show });
    } finally {
      if (!this.dead) show();
      this.settleWalk(to);
    }
  }

  /**
   * 住旅馆：从当前格走进旅馆 world（原版 fcn.0040bb40 的 bit5 分支，fcn.0040d06b 置位）：前半程看得见，剩余 tick 少于一半时
   * 不再画（0x40bebb 清 bit5），走完人在旅馆里（setInside(world)）。已经在建筑里时不动
   * @source exe v2.06 0x40d0d4（置 bit5、朝向 = 节点 → 旅馆）、0x40bbd1–0x40bc0b（bit5：起点节点、终点旅馆坐标）
   */
  async walkIn(world: Pt, o: OrigWalkOutOptions): Promise<void> {
    if (this.dead || this.walking || this.inside || this._tile === null) return;
    const tile = this._tile;
    const from = this.o.tileWorld(tile) ?? this.pos;
    const ticks = walkOutTicks(Math.hypot(world.x - from.x, world.y - from.y), WALK_OUT.hotelMaxTicks);
    this.landing = null;
    this.insideLanding = undefined;
    try {
      await this.walkSegment(from, world, ticks, {
        tickMs: o.tickMs,
        signal: o.signal,
        onSwitch: () => {
          this.veiled = true;
          this.refresh();
        },
      });
    } finally {
      // 走完人在旅馆里；之后的同步（住旅馆的状态）给出同一个建筑坐标
      if (this.insideLanding === undefined) this.insideLanding = { ...world };
      this.settleWalk(tile);
    }
  }

  /** 原地跳一下；刚被放上棋盘时改播降落（开局跳伞） */
  async hop(signal?: AbortSignal): Promise<void> {
    if (this.dead) return;
    if (this.dropPending) {
      // 本体继续藏着，直到棋盘伞 FLIC 播完或程序化降落开始（drop 负责再显示）
      this.dropping = true;
      this.dropPending = false;
      await this.drop(signal ?? new AbortController().signal);
      return;
    }
    await tweenValue(
      0,
      1,
      HOP_MS,
      (t) => {
        if (this.dead) return;
        this.hopY = hopArc(t) * 10;
        this.relayout();
        this.placeTag();
      },
      { clock: this.o.clock, signal, ease: linear },
    );
    this.hopY = 0;
    this.relayout();
    this.placeTag();
  }

  /** 降落结束（含中止、瞬时、载入失败）：本体与名牌重新出现 */
  private endDrop(): void {
    if (this.dead) return;
    this.dropping = false;
    this.refresh();
  }

  /**
   * 开局降落：棋盘伞 FLIC（按预算 playFit）或程序化从天而降。进来时本体已经藏起（dropping），
   * FLIC 播完、程序化降落开始、或中止时再显示
   */
  private async drop(signal: AbortSignal): Promise<void> {
    if (this.o.clock.instant || signal.aborted) {
      this.endDrop();
      return;
    }
    const t0 = this.o.clock.now();
    const fit0 = this.dropFitMs?.() ?? PARACHUTE_FIT_MS;
    const player = this.parachute ? await this.parachute(signal).catch(() => null) : null;
    if (this.dead) {
      player?.destroy();
      return;
    }
    if (player?.canvas && !signal.aborted) {
      const tex = new Texture({ source: new CanvasSource({ resource: player.canvas as HTMLCanvasElement }) });
      tex.source.scaleMode = 'nearest';
      const spr = new Sprite(tex);
      spr.label = 'parachute';
      (this.flyLayer ?? this.root).addChild(spr);
      this.chute = spr;
      if (this.flyLayer) this.relayout();
      else spr.position.set(-BOARD_FLIC_CENTER, -BOARD_FLIC_CENTER);
      const onFrame = (): void => tex.source.update();
      try {
        onFrame();
        const off = this.o.clock.onFrame(onFrame);
        try {
          // 载入 FLIC 用掉的时间从可用时长里扣除
          const fit = fit0 - (this.o.clock.now() - t0);
          await player.playFit(Math.max(0, fit), { signal });
        } finally {
          off();
        }
      } finally {
        this.chute = null;
        player.destroy();
        spr.destroy();
        tex.destroy(true);
        this.endDrop();
      }
      return;
    }
    player?.destroy();
    if (signal.aborted) {
      this.endDrop();
      return;
    }
    // 程序化降落：先抬到空中再显示，从天而降
    this.hopY = DROP_PX;
    this.relayout();
    this.endDrop();
    try {
      await tweenValue(
        1,
        0,
        DROP_MS,
        (v) => {
          if (this.dead) return;
          this.hopY = v * DROP_PX;
          this.relayout();
          this.placeTag();
        },
        { clock: this.o.clock, signal, ease: cubicOut },
      );
    } finally {
      this.hopY = 0;
      this.relayout();
      this.placeTag();
    }
  }

  /**
   * 头顶气泡（聊天、表情）：挂在角色上随行走移动，ms 为真实时间。emote=true 时只放大显示一个表情字形；
   * 聊天原文超过 18 个字截断加省略号（与程序化一致）
   */
  say(text: string, ms: number, emote = false): void {
    if (this.dead) return;
    this.clearSpeech();
    const chars = [...text];
    const shown =
      emote || chars.length <= ORIG_SAY_MAX_CHARS ? text : `${chars.slice(0, ORIG_SAY_MAX_CHARS).join('')}…`;
    const root = new Container({ label: 'speech' });
    const t = new Text({
      text: shown,
      style: {
        fontFamily: ORIGINAL_FONT_STACK,
        fontSize: emote ? 22 : 12,
        fill: 0x000000,
        wordWrap: !emote,
        wordWrapWidth: 132,
        breakWords: true,
      },
      resolution: 2,
    });
    t.anchor.set(0.5, 1);
    const w = Math.max(28, Math.ceil(t.width) + 12);
    const h = Math.ceil(t.height) + 8;
    const bg = new Graphics()
      .rect(-w / 2, -h - 6, w, h)
      .fill(0xffffff)
      .stroke({ width: 1, color: 0x000000 })
      .poly([-4, -7, 4, -7, 0, 0], true)
      .fill(0xffffff)
      .stroke({ width: 1, color: 0x000000 });
    t.position.set(0, -10);
    root.addChild(bg, t);
    this.root.addChild(root);
    const timer = setTimeout(() => {
      if (this.speech?.root === root) this.clearSpeech();
    }, ms);
    this.speech = { root, timer };
    this.placeTag();
  }

  private clearSpeech(): void {
    const sp = this.speech;
    if (!sp) return;
    this.speech = null;
    clearTimeout(sp.timer);
    if (!sp.root.destroyed) sp.root.destroy({ children: true });
  }

  /** 附身神明节点（离身演出取走时用；调用方不销毁） */
  get godNode(): Sprite | null {
    return this.godSprite;
  }

  destroy(): void {
    if (this.dead) return;
    this.clearSpeech();
    this.dead = true;
    this.offFrame();
    this.root.destroy({ children: true });
  }
}
