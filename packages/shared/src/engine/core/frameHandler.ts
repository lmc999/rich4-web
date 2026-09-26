/**
 * 帧处理器接口（design/engine.md §6.2）。FRAME_HANDLERS（core/flow.ts）按 FrameKind 穷举注册。
 * - step：推进一步，可能压子帧、ask、改 stage 或 ctx.pop(f)；
 * - resume：消费本帧发出的决策（action 已通过 seat / ALLOWED_INTENTS / schema 校验，pending 已移除）。
 *   resume 里的合法性检查必须先于任何状态修改（抛 EngineRuleError 时整个草稿被丢弃）。
 */
import type { PendingDecision } from '../types/decision';
import type { Frame } from '../types/frames';
import type { PlayerAction } from '../types/intent';
import type { Ctx } from './ctx';

export interface FrameHandler<F extends Frame> {
  step(ctx: Ctx, f: F): void;
  resume?(ctx: Ctx, f: F, a: PlayerAction, d: PendingDecision): void;
}
