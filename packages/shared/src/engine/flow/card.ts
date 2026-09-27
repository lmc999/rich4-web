/**
 * CARD 帧：需要跨决策的卡片效果链（design/engine.md §6.1、§10.1）。按 f.card 分派到 effects/cards 的 CARD_CHAINS：
 *   16 梦游（hostility → check → exempt → scapegoat → apply → revenge）；26 查税（free → scapegoat → pay）。
 * 其余卡片在 USE_CARD 时直接结算，或压 CONFINE（陷害）/ GOD（请神）/ AUCTION（拍卖，M7）帧。
 * 帧的 seat 是出卡者；链中的决策（USE_FREE_CARD、SCAPEGOAT）发给目标座位，由本帧的 resume 处理。
 */
import type { FrameHandler } from '../core/frameHandler';
import { CARD_CHAINS } from '../effects/cards/index';
import { EngineInvariantError } from '../errors';
import type { FrameOf } from '../types/frames';

type CardFrame = FrameOf<'CARD'>;

export const CARD: FrameHandler<CardFrame> = {
  step(ctx, f) {
    if (f.stage === 'done') {
      ctx.pop(f);
      return;
    }
    const chain = CARD_CHAINS[f.card];
    if (!chain) throw new EngineInvariantError('CARD_CHAIN', `card ${f.card} has no chain`);
    chain.step(ctx, f);
  },
  resume(ctx, f, a, d) {
    const chain = CARD_CHAINS[f.card];
    if (!chain) throw new EngineInvariantError('CARD_CHAIN', `card ${f.card} has no chain`);
    chain.resume(ctx, f, a, d.kind, d.options);
  },
};
