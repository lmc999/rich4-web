// M6 / M7 的棋盘演出端口（design/client.md §3.6、§4.5）：路面物件、神明、恶人、角色状态外观与各种特效。
// 只定义接口与空实现，不 import Pixi（handlers 在首屏 chunk 里）；Pixi 实现是 game/fx/BoardStage，
// 由棋盘（BoardController）的 fx.stageFor(board) 懒创建。整合后 BoardController 可直接暴露 `stage` 属性。
import type {
  GodKind,
  GodManifestEffect,
  PostPatch,
  RoadObject,
  SeatIndex,
  StrikeKind,
  TileId,
  Vehicle,
  VillainKind,
} from '@rich4/shared/engine';
import { applyPostPatch, type GameView } from '@rich4/shared/view';
import type { Anchor, PresentationContext } from '../types';

export type ConfineKind = 'jail' | 'hospital';
export type ObjectRemoval = 'burst' | 'fade' | 'boom' | 'pickup';

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
  /** 救护车 / 警车沿路开来接走（之后角色显示在医院 / 监狱窗口气泡里） */
  escort(seat: SeatIndex, where: ConfineKind, signal: AbortSignal): Promise<void>;
  release(seat: SeatIndex, signal: AbortSignal): Promise<void>;
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
 * 事件中途把舞台外观（关押窗口气泡、figure 显隐等）同步到「提交前显示态 + post」：handler 在演出分段之间需要
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
