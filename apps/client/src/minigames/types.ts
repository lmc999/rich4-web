// 小游戏前端模块的契约（design/minigames-ai.md §7；client.md §9.2 按 architecture 修订）：
// 每个游戏提供 Pixi 场景（view）、输入适配（input）与 HUD（React），由 MiniGameHost 按 registry 懒加载。
// 舞台固定 640×480（原版坐标），宿主负责等比 letterbox 与指针坐标换算。
import type { MinigameId, MinigameSim, SimBase, SimFx } from '@rich4/shared/minigames';
import type { Application, Container } from 'pixi.js';
import type { ComponentType } from 'react';
import type { MgSound } from './orig/audio';
import type { OrigMgKit } from './orig/kit';

export const STAGE_W = 640;
export const STAGE_H = 480;

export interface Pt {
  x: number;
  y: number;
}

export type HostMode = 'play' | 'spectate' | 'replay';

/** 宿主阶段（视图据此区分开局前 / 游玩 / 结算） */
export type ViewPhase = 'loading' | 'countdown' | 'playing' | 'waiting' | 'result' | 'closed';

/** 视图外观：程序化（自绘）或原版（素材包） */
export type ViewLook = 'procedural' | 'original';

/** 结算画面的分数（服务器结算到达前为本地分数，final=false） */
export interface ViewResult {
  score: number;
  final: boolean;
}

export interface ViewContext {
  app: Application;
  /** 玩家角色（喜从天降的接物者复用棋盘角色 rig）；未知时为 null */
  characterId: number | null;
  mode: HostMode;
}

export interface MinigameView<S extends SimBase> {
  readonly root: Container;
  /**
   * prev / curr 为相邻两个 tick 的状态，alpha ∈ [0,1] 为插值系数；fx 为自上次 render 以来新出现的表现提示；
   * timeMs 为本机单调时间（闪烁、摆动等纯装饰动画用）。
   */
  render(prev: Readonly<S>, curr: Readonly<S>, alpha: number, fx: readonly SimFx[], timeMs: number): void;
  /** 指针在舞台上的位置（准星、靶圈）；null 表示离开或不显示 */
  setPointer(p: Pt | null): void;
  destroy(): void;
  /** 外观（缺省 procedural） */
  readonly look?: ViewLook;
  /** 宿主阶段变化（原版视图：开局前不亮出埋藏物、结算画姿势与大号分数） */
  setPhase?(phase: ViewPhase): void;
  /** 结算分数（null 表示还没到结算） */
  setResult?(r: ViewResult | null): void;
  /** 舞台像素 → 设备像素的倍率（原版像素整数倍最近邻、非整数倍平滑） */
  setScale?(scale: number): void;
  /** 调试与测试：视图当前画了什么（JSON 值） */
  debug?(): Record<string, unknown>;
}

/** 原版视图的上下文：素材工具（已按必需条目预载）与声音 */
export interface OrigViewContext extends ViewContext {
  kit: OrigMgKit;
  sound: MgSound;
}

/** 输入适配器发给宿主的操作（舞台整数坐标）；宿主决定 tick 归属并记录 InputEvent */
export interface InputSink {
  /** 点击（企鹅：换算成格号；气球：射击） */
  click(p: Pt): void;
  /** 企鹅：键盘选格 */
  pick(cell: number): void;
  /** 喜从天降：光标横坐标 */
  cursor(x: number): void;
  /** 指针移动（只用于显示） */
  hover(p: Pt | null): void;
}

export interface InputContext<S extends SimBase> {
  /** 接收指针与键盘事件的元素（覆盖整个舞台） */
  el: HTMLElement;
  toStage(clientX: number, clientY: number): Pt;
  sink: InputSink;
  state(): Readonly<S>;
  /** 本局是否接受本机输入（观战为 false） */
  interactive: boolean;
}

export interface MinigameInput {
  /** 每次 step 之前调用（键盘虚拟光标按 tick 移动） */
  beforeTick?(): void;
  destroy(): void;
}

export interface HudProps<S extends SimBase> {
  state: Readonly<S>;
  mode: HostMode;
}

export interface MinigameClientModule<S extends SimBase = SimBase> {
  id: MinigameId;
  sim: MinigameSim<S>;
  createView(ctx: ViewContext): Promise<MinigameView<S>>;
  /**
   * 原版视图（原版皮肤且必需条目可用时由宿主选用；抛错或返回 null 时整局回退 createView）。
   * 实现放在各游戏的 origView.ts，按需懒加载。
   */
  createOrigView?(ctx: OrigViewContext): Promise<MinigameView<S> | null>;
  createInput(ctx: InputContext<S>): MinigameInput;
  Hud: ComponentType<HudProps<S>>;
  /** 结算姿势分档的文案键（表现层；null 表示没有姿势，例如喜从天降被炸） */
  poseKey(s: Readonly<S>, score: number): string | null;
}
