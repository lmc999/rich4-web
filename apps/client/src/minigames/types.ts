// 小游戏前端模块的契约（design/minigames-ai.md §7；client.md §9.2 按 architecture 修订）：
// 每个游戏提供 Pixi 场景（view）、输入适配（input）与 HUD（React），由 MiniGameHost 按 registry 懒加载。
// 舞台固定 640×480（原版坐标），宿主负责等比 letterbox 与指针坐标换算。
import type { MinigameId, MinigameSim, SimBase, SimFx } from '@rich4/shared/minigames';
import type { Application, Container } from 'pixi.js';
import type { ComponentType } from 'react';

export const STAGE_W = 640;
export const STAGE_H = 480;

export interface Pt {
  x: number;
  y: number;
}

export type HostMode = 'play' | 'spectate' | 'replay';

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
  createInput(ctx: InputContext<S>): MinigameInput;
  Hud: ComponentType<HudProps<S>>;
  /** 结算姿势分档的文案键（表现层；null 表示没有姿势，例如喜从天降被炸） */
  poseKey(s: Readonly<S>, score: number): string | null;
}
