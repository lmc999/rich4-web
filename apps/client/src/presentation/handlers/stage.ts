// M6 / M7 的棋盘演出端口（design/client.md §3.6、§4.5）：路面物件、神明、恶人、角色状态外观与各种特效。
// 只定义接口与空实现，不 import Pixi（handlers 在首屏 chunk 里）；Pixi 实现是 game/fx/BoardStage，
// 由棋盘（BoardController）的 fx.stageFor(board) 懒创建。整合后 BoardController 可直接暴露 `stage` 属性。
import type {
  GameEvent,
  GodKind,
  GodManifestEffect,
  LotId,
  PostPatch,
  RoadObject,
  SeatIndex,
  StrikeKind,
  TileId,
  Vehicle,
  VillainKind,
} from '@rich4/shared/engine';
import { applyPostPatch, type GameView } from '@rich4/shared/view';
import type { Anchor, AudioPort, PresentationContext } from '../types';

export type ConfineKind = 'jail' | 'hospital';
export type ObjectRemoval = 'burst' | 'fade' | 'boom' | 'pickup';
/** 获释后从哪里走出来：监狱 / 医院景观、旅馆 */
export type WalkOutFrom = 'jail' | 'hospital' | 'hotel';

/** 走出 / 走进建筑的参数 */
export interface WalkOutOptions {
  /** 原版 tick（ms，当前演出节奏的 DICE_TIMING.throwTickMs；原版皮肤按它匀速走，程序化按自己的步长） */
  tickMs: number;
  /** 走出：棋子出现的那一刻（handler 在这时把关押状态换成获释后的显示态）；中止或找不到建筑时也会调用 */
  onShow?: () => void;
}

/** 事件开始时交给舞台的上下文（原版皮肤 A8：FLIC 的可用时长与同步音效） */
export interface StageEventContext {
  /** 当前事件的音频端口（FLIC 同步音效经它播放） */
  audio: AudioPort;
  /** 当前演出节奏下该事件的预算（1x ms；与 handler 包装的封顶是同一个值） */
  budgetMs: number;
}

export interface StagePort {
  readonly ready: boolean;
  /**
   * 按显示态同步路面物件、路上神明、乞丐、四大恶人与角色状态外观（无动画、幂等）。
   * handler 包装在每个事件前后各调用一次，保证 reset / 跳过之后也能追上。
   */
  syncWorld(view: GameView): void;
  /** 清掉进行中的演出（reset / skipAll 时 BoardPort.clearFx 已清 Fx；这里清舞台自己的临时对象） */
  clear(): void;

  // 路面物件
  dropObject(obj: RoadObject, signal: AbortSignal): Promise<void>;
  removeObject(obj: RoadObject, how: ObjectRemoval, signal: AbortSignal): Promise<void>;
  /** 机器娃娃从 path[0] 出发沿路走，沿途物件被弹飞（cleared 为物件 id） */
  dollWalk(path: readonly TileId[], cleared: readonly number[], signal: AbortSignal): Promise<void>;

  // 特效
  explode(at: Anchor, size: 'small' | 'big', signal: AbortSignal): Promise<void>;
  /** 飞弹 / 核弹 / 外星人 / 台风 / 3×3 炸弹：落点 center、范围半宽 half（原版世界像素） */
  strike(kind: StrikeKind, center: TileId, half: number, signal: AbortSignal): Promise<void>;
  pillar(at: Anchor, color: number, signal: AbortSignal): Promise<void>;
  beam(from: Anchor, to: Anchor, color: number, signal: AbortSignal): Promise<void>;
  /** 全屏闪光（不阻塞） */
  flash(color: number, ms: number): void;
  rewind(signal: AbortSignal): Promise<void>;
  /** 小粒子喷发（不阻塞） */
  burst(at: Anchor, color: number, count?: number): void;
  /** 头顶小气泡（不阻塞），例如「免罪！」「zzz」 */
  bubble(at: Anchor, text: string, ms: number): void;
  teleport(from: Anchor, to: Anchor, signal: AbortSignal): Promise<void>;
  /** 施放姿势：出卡、用道具（角色举手 + 闪光） */
  cast(seat: SeatIndex, signal: AbortSignal): Promise<void>;
  fireworks(): void;

  // 神明
  godSpawn(kind: GodKind, node: TileId, signal: AbortSignal): Promise<void>;
  godArrive(seat: SeatIndex, kind: GodKind, signal: AbortSignal): Promise<void>;
  godLeave(seat: SeatIndex | null, kind: GodKind, signal: AbortSignal): Promise<void>;
  godPower(seat: SeatIndex, kind: GodKind, signal: AbortSignal): Promise<void>;
  manifest(kind: GodKind, lotAt: Anchor, effect: GodManifestEffect, signal: AbortSignal): Promise<void>;
  dogBite(seat: SeatIndex, node: TileId, knocked: boolean, signal: AbortSignal): Promise<void>;

  // 角色
  /** 救护车 / 警车沿路开来接走（之后人在医院 / 监狱里，棋子不画，syncWorld 按关押状态给出） */
  escort(seat: SeatIndex, where: ConfineKind, signal: AbortSignal): Promise<void>;
  /** 开门闪光（保释、出国回来） */
  release(seat: SeatIndex, signal: AbortSignal): Promise<void>;
  /**
   * 获释：从医院 / 监狱景观（旅馆）走一步到所在的格（关押格 / 旅馆门前的格），前半程看不见、过半出现（这时调 onShow），
   * 停在格上（原版 fcn.0040bb40 的 bit4 分支，shared/view/pacing 的 WALK_OUT）
   */
  walkOut(seat: SeatIndex, from: WalkOutFrom, o: WalkOutOptions, signal: AbortSignal): Promise<void>;
  /** 住旅馆：从门前的格走进旅馆，前半程看得见、过半消失（原版 bit5 分支） */
  walkIn(seat: SeatIndex, lot: LotId, o: WalkOutOptions, signal: AbortSignal): Promise<void>;
  /**
   * 本回合获释的人：计数在回合开始（TURN_STARTED 的 post）就清掉了，但要等 RELEASED 才从建筑里走出来——在那之前的同步都让他
   * 留在建筑里（walkOut 开始时解除）。null 解除全部（批尾整体同步、reset / 跳过时的 clear）
   */
  holdInside(seat: SeatIndex | null): void;
  /** 换车：只刷新外观（换姿态库 / 载具图），不闪光、不跳（原版 fcn.0040b425） */
  vehicle(seat: SeatIndex, v: Vehicle, signal: AbortSignal): Promise<void>;
  wreck(seat: SeatIndex, v: Vehicle, signal: AbortSignal): Promise<void>;
  bombAttach(seat: SeatIndex, fuse: number, signal: AbortSignal): Promise<void>;
  bombPass(from: SeatIndex, to: SeatIndex, fuse: number, signal: AbortSignal): Promise<void>;
  /** 女巫在施法者身边挥杖，名单上的人头顶出现魔法阵 */
  magic(caster: SeatIndex, targets: readonly SeatIndex[], signal: AbortSignal): Promise<void>;
  /** 乞丐挪到新节点 */
  beggarMove(seat: SeatIndex, node: TileId, signal: AbortSignal): Promise<void>;

  // 恶人
  walkVillain(kind: VillainKind, path: readonly TileId[], signal: AbortSignal): Promise<void>;
  villainAnchor(kind: VillainKind): Anchor | null;

  // 原版皮肤（A8，可选；程序化舞台不实现）
  /**
   * 事件 handler 开始前由包装调用（在 syncWorld 之后）：舞台据此为本事件选原版 FLIC、按「当前节奏的预算 − handler 内
   * 其他等待」安排 FLIC 的播放时长，并经 ctx.audio 放 FLIC 的同步音效。
   */
  beginEvent?(e: GameEvent, ctx: StageEventContext): void;
  /**
   * 事件自己的原版 FLIC（卡片格得卡、点券格得点券、节日烟火 / 圣诞、破产），与 handler 其余演出并行；
   * 没有对应 FLIC 时立即 resolve。handler 以 `stage.eventFlic?.(…)` 调用。
   */
  eventFlic?(e: GameEvent, signal: AbortSignal): Promise<void>;
}

const resolved = (): Promise<void> => Promise.resolve();
const noop = (): void => {};

/** 没有棋盘（测试、棋盘未挂载、观战者切页）时的空实现 */
export const NULL_STAGE: StagePort = {
  ready: false,
  syncWorld: noop,
  clear: noop,
  dropObject: resolved,
  removeObject: resolved,
  dollWalk: resolved,
  explode: resolved,
  strike: resolved,
  pillar: resolved,
  beam: resolved,
  flash: noop,
  rewind: resolved,
  burst: noop,
  bubble: noop,
  teleport: resolved,
  cast: resolved,
  fireworks: noop,
  godSpawn: resolved,
  godArrive: resolved,
  godLeave: resolved,
  godPower: resolved,
  manifest: resolved,
  dogBite: resolved,
  escort: resolved,
  release: resolved,
  walkOut: (_seat, _from, o) => {
    o.onShow?.();
    return Promise.resolve();
  },
  walkIn: resolved,
  holdInside: noop,
  vehicle: resolved,
  wreck: resolved,
  bombAttach: resolved,
  bombPass: resolved,
  magic: resolved,
  beggarMove: resolved,
  walkVillain: resolved,
  villainAnchor: () => null,
};

/** 棋盘可能提供舞台的两种方式：直接的 stage 属性（整合后），或 Fx 的懒工厂（BoardController.fx） */
interface StageHost {
  readonly ready?: boolean;
  stage?: StagePort | null;
  fx?: { stageFor?: (host: unknown) => StagePort | null };
}

/**
 * 事件中途把舞台外观（人在医院 / 监狱 / 旅馆里、figure 显隐等）同步到「提交前显示态 + post」：handler 在演出分段之间需要
 * 立即反映状态变化时调用（wrapHandler 在事件前后也会各同步一次）。
 */
export function syncStageTo(ctx: Pick<PresentationContext, 'board' | 'view'>, post: PostPatch | undefined): void {
  const st = stageOf(ctx);
  if (st.ready && post) st.syncWorld(applyPostPatch(ctx.view(), post));
}

/** 当前棋盘的舞台；没有 Pixi 棋盘时为 NULL_STAGE */
export function stageOf(ctx: Pick<PresentationContext, 'board'>): StagePort {
  const b = ctx.board as unknown as StageHost;
  if (!b.ready) return NULL_STAGE;
  if (b.stage) return b.stage;
  const s = b.fx?.stageFor?.(b);
  return s ?? NULL_STAGE;
}
