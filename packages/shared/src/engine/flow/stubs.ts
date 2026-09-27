/**
 * 尚未实现的帧（design/engine.md §17 L4–L5）：执行到就抛 EngineInvariantError('NOT_IMPLEMENTED')。
 * M4 已实现 FEE、BANK、SHOP、CONFINE（flow/fee.ts、bank.ts、shop.ts、confine.ts）；M6 实现 CARD、ITEM、GOD
 * （flow/card.ts、item.ts、god.ts）。
 * M1 的流程不会压这些帧；实现时在 flow/ 下新建同名文件并替换 core/flow.ts 中的注册项。
 */
import type { FrameHandler } from '../core/frameHandler';
import { EngineInvariantError } from '../errors';
import type { FrameKind, FrameOf } from '../types/frames';

export function notImplementedFrame<K extends FrameKind>(k: K, milestone: string): FrameHandler<FrameOf<K>> {
  const fail = (): never => {
    throw new EngineInvariantError('NOT_IMPLEMENTED', `frame ${k} (${milestone})`);
  };
  return { step: fail, resume: fail };
}

/** 新闻 36 条 */
export const NEWS = notImplementedFrame('NEWS', 'M7');
/** 命运 37 条 */
export const FATE = notImplementedFrame('FATE', 'M7');
/** 魔法屋 */
export const MAGIC = notImplementedFrame('MAGIC', 'M7');
/** 并发拍卖 */
export const AUCTION = notImplementedFrame('AUCTION', 'M7');
/** 投降与死神 */
export const SURRENDER = notImplementedFrame('SURRENDER', 'M7');
/** 四大恶人的回合 */
export const VILLAIN = notImplementedFrame('VILLAIN', 'M7');
