// 演出层接口（design/client.md §4.2，按 architecture §14 修订）：handler 只依赖这些端口，
// 真实实现是 Pixi 棋盘（game/BoardController）与 DOM 桥（UiPresenter），测试里换成假实现。
import type { MapIndex } from '@rich4/shared/data';
import type { GameEvent, GameEventOf, GameEventType, LotId, SeatIndex, TileId } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import type { NameKit } from './names';

/** 飘字、镜头聚焦的位置 */
export type Anchor = { seat: SeatIndex } | { tile: TileId } | { lot: LotId };

export type FloatTone = 'gain' | 'loss' | 'info' | 'points';

export interface LotLook {
  owner: SeatIndex | null;
  level: number;
  /** 设施地的类型（'vacant' 为未建） */
  facility?: 'vacant' | 'park' | 'hotel' | 'mall' | 'gas' | 'lab';
}

/** 棋盘演出端口（Pixi 实现见 game/BoardController.ts；没有棋盘时用 NULL_BOARD） */
export interface BoardPort {
  readonly ready: boolean;
  /** 按显示态整体同步：地块归属/等级、企业董事长、角色位置与可见性（批尾与 reset 调用） */
  syncView(view: GameView): void;
  /** path[0] 为起点；中止时直接落到终点 */
  walk(
    seat: SeatIndex,
    path: readonly TileId[],
    signal: AbortSignal,
    onStep?: (tile: TileId, i: number) => void,
  ): Promise<void>;
  placeActor(seat: SeatIndex, tile: TileId): void;
  hop(seat: SeatIndex, signal: AbortSignal): Promise<void>;
  setActorPose(seat: SeatIndex, pose: 'idle' | 'cheer' | 'sad' | 'hurt' | 'sleep' | 'cast'): void;
  setLot(lot: LotId, look: LotLook): void;
  /** 镜头移到某处（ms 为 1x 时长） */
  focus(at: Anchor, ms: number, signal: AbortSignal): Promise<void>;
  /** 镜头跟随座位（null 取消） */
  follow(seat: SeatIndex | null): void;
  floatText(at: Anchor, text: string, tone: FloatTone): void;
  coinFlight(from: Anchor, to: Anchor, signal: AbortSignal): Promise<void>;
  plantFlag(lot: LotId, seat: SeatIndex, signal: AbortSignal): Promise<void>;
  /** 建筑长高 / 弹跳（等级变化后调用） */
  popBuilding(lot: LotId, signal: AbortSignal): Promise<void>;
  pulseTile(tile: TileId): void;
  shake(amp: number, ms: number): void;
  /** 清掉所有临时特效（reset / skipAll） */
  clearFx(): void;
}

/** DOM 演出端口（UiPresenter 实现，写 uiStore） */
export interface UiPort {
  toast(text: string, kind?: 'info' | 'success' | 'warn' | 'error'): void;
  /** 横幅：显示 ms（1x 时长）后收起；返回在显示时长结束时 resolve */
  banner(
    b: {
      kind: 'turn' | 'start' | 'bankrupt' | 'holiday' | 'gameOver' | 'info';
      title: string;
      subtitle?: string;
      seat?: SeatIndex;
    },
    ms: number,
    signal: AbortSignal,
  ): Promise<void>;
  /** 骰子：先滚动再落定到 faces；返回滚动 + 停留结束 */
  dice(seat: SeatIndex, faces: readonly number[], signal: AbortSignal): Promise<void>;
  flash(seat: SeatIndex, field: 'cash' | 'deposit' | 'points', delta: number): void;
  closeTransient(): void;
}

export interface AudioPort {
  play(id: string): void;
}

/**
 * 事件的声音钩子（原版皮肤 A9）：GameClient 在每个事件 handler 外层调用（audio/ 的 AudioDirector 经 app/audio.ts 接入，
 * ?audio=off 或音频模块尚未加载时为 null）。音效与语音在事件开始时触发，事件期间的场景曲在 handler 结束（含中止）时收起。
 */
export interface EventAudioHook {
  /** 事件 handler 开始前调用；返回的函数在该事件演出结束（自然结束、封顶或中止）时调用 */
  onEvent(e: GameEvent, ctx: PresentationContext): () => void;
  /** PresentationContext.audio 的实现 */
  readonly port: AudioPort;
  /** 演出被中止（reset / skipAll）或离开房间：收起事件场景曲、停掉语音 */
  reset(): void;
  /**
   * 事件没有播放演出就直接提交（instant、后台标签页、skipAll 追帧）时调用：不放声音，只收起以它为终点的跨事件场景曲
   * （拍卖曲到 AUCTION_ENDED 为止）
   */
  observe?(e: GameEvent): void;
}

/**
 * 事件在权威流里的位置（original-skin.md §3 修正 7）：同一批事件在所有客户端与观战者上完全相同，
 * 需要随机的演出（原版语音的 1/3、1/2、二选一）用 hash32(epoch, seq, eventIndex, seat) 取值，保证大家听到同一句。
 */
export interface EventStamp {
  /** 房间 epoch（读档 / 重开后变化） */
  epoch: number;
  /** 批次 seq */
  seq: number;
  /** 事件在批内的下标（0 起） */
  eventIndex: number;
}

export interface PresentationContext {
  signal: AbortSignal;
  /** 当前事件的位置（EventPlayer 调 handler 时总会给出；测试替身可省略） */
  at?: EventStamp;
  /** 由动画时钟驱动的等待（倍速、中止、instant 即刻完成） */
  wait(ms: number): Promise<void>;
  board: BoardPort;
  ui: UiPort;
  audio: AudioPort;
  /** 本人座位；观战者为 null */
  me: SeatIndex | null;
  role: 'player' | 'spectator';
  /** 本事件提交之前的显示态 */
  view(): GameView;
  map: MapIndex | null;
  names: NameKit;
  t(key: string, params?: Record<string, unknown>): string;
  /** 动画时钟当前倍速（弹窗把 1x 时长换算成真实时长）；缺省视为 1 */
  animSpeed?(): number;
}

export type EventHandler<T extends GameEventType> = (e: GameEventOf<T>, ctx: PresentationContext) => Promise<void>;

/** 对 GameEvent['type'] 穷举（handlers/index.ts 用 satisfies 强制） */
export type HandlerMap = { readonly [T in GameEventType]: EventHandler<T> };

export type AnyHandler = (e: GameEvent, ctx: PresentationContext) => Promise<void>;

const noop = (): void => {};
const resolved = (): Promise<void> => Promise.resolve();

/** 棋盘尚未挂载（或观战者切换页面）时的空实现 */
export const NULL_BOARD: BoardPort = {
  ready: false,
  syncView: noop,
  walk: resolved,
  placeActor: noop,
  hop: resolved,
  setActorPose: noop,
  setLot: noop,
  focus: resolved,
  follow: noop,
  floatText: noop,
  coinFlight: resolved,
  plantFlag: resolved,
  popBuilding: resolved,
  pulseTile: noop,
  shake: noop,
  clearFx: noop,
};

export const NULL_AUDIO: AudioPort = { play: noop };

/** 失效上下文（演出已被 reset / skipAll 中止）用的界面端口：收尾代码不再弹横幅、飘字、提示 */
export const NULL_UI: UiPort = {
  toast: noop,
  banner: resolved,
  dice: resolved,
  flash: noop,
  closeTransient: noop,
};
