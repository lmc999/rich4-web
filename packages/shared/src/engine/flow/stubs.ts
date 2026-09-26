/**
 * M1 尚未实现的帧（design/engine.md §17 L3–L5）：执行到就抛 EngineInvariantError('NOT_IMPLEMENTED')。
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

/** 设施费与企业收费（旅馆、购物中心、加油站、航空、电子、保险、汽车、石油、建设、门派） */
export const FEE = notImplementedFrame('FEE', 'M4');
/** 银行 ATM 与柜台 */
export const BANK = notImplementedFrame('BANK', 'M4');
/** 百货公司 */
export const SHOP = notImplementedFrame('SHOP', 'M4');
/** 关押、住院、住旅馆、消失（免罪 → 嫁祸 → 加持 → 施加 → 复仇） */
export const CONFINE = notImplementedFrame('CONFINE', 'M6');
/** 卡片效果链 */
export const CARD = notImplementedFrame('CARD', 'M6');
/** 道具效果链 */
export const ITEM = notImplementedFrame('ITEM', 'M6');
/** 神明附身与发威 */
export const GOD = notImplementedFrame('GOD', 'M6');
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
