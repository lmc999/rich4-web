// 棋盘特效入口（design/client.md §3.3）：BoardController 以 new Fx(overlay, fx, clock) 构造（M3 起不变）。
// M6 起 Fx 就是 FxSystem（粒子预算、爆炸、光柱、光束、闪屏……），另提供 stageFor(board)：
// 懒创建 M6/M7 的棋盘舞台（BoardStage），供 presentation/handlers/stage.ts 的 stageOf 使用。
import type { StagePort } from '../../presentation/handlers/stage';
import { BoardStage } from './BoardStage';
import { FxSystem } from './FxSystem';

export type { FloatTone } from './FloatingText';
export { COIN_COUNT, COIN_MS, COIN_STAGGER_MS, FLAG_MS, FLOAT_MS } from './timings';

export class Fx extends FxSystem {
  private stage: BoardStage | null = null;
  private stageHost: unknown = null;

  /** 棋盘舞台（同一个棋盘只建一次）；host 不是 Pixi 棋盘时返回 null */
  stageFor(host: unknown): StagePort | null {
    if (this.stage && this.stageHost === host && !this.stage.destroyed) return this.stage;
    const s = BoardStage.fromHost(host, this);
    this.stage?.dispose();
    this.stage = s;
    this.stageHost = s ? host : null;
    return s;
  }
}
