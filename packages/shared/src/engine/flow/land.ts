/**
 * LAND 帧：落点结算，顺序 beggar → object → square → tail → lab（design/engine.md §7.6，@0x41b077 settle）。
 * 每个阶段先把 stage 推进到下一阶段，再执行本阶段（可能压子帧或 ask），子帧完成后从下一阶段继续。
 *
 * 钩子：乞丐施舍（M7）、路面物件与神明（M6）、神明显灵与工程车拆房（M6）。
 * 'lab'：业主停在自己已建成、未查封的研究所（未梦游）→ RESEARCH。
 */
import type { FrameHandler } from '../core/frameHandler';
import { EngineInvariantError } from '../errors';
import { wantsResearch } from '../squares/facility';
import { settleSquare } from '../squares/index';
import type { FrameOf } from '../types/frames';
import type { FacilityLotId } from '../types/ids';

type LandFrame = FrameOf<'LAND'>;

export const LAND: FrameHandler<LandFrame> = {
  step(ctx, f) {
    if (f.actor.t !== 'seat') throw new EngineInvariantError('NOT_IMPLEMENTED', 'villain landing (M7)');
    switch (f.stage) {
      case 'beggar':
        f.stage = 'object';
        ctx.emit('LANDED', { actor: f.actor, node: f.node });
        // TODO(M7)：节点上有别人的乞丐 → PAYX(1000×PI → 公库)，乞丐移到随机节点（BEGGAR_ALMS）
        return;
      case 'object':
        f.stage = 'square';
        // TODO(M6)：地雷、恶犬、地面定时炸弹、礼物、宝箱、神明（压 GOD 帧）
        return;
      case 'square':
        f.stage = 'tail';
        if (!f.skipSquare) settleSquare(ctx, f);
        return;
      case 'tail':
        f.stage = 'lab';
        // TODO(M6)：神明显灵（天使 +1、恶魔 −1、土地公强占）→ 工程车拆房（PROGRAM：别人有建筑的地产清到 0 级）
        return;
      case 'lab': {
        f.stage = 'done';
        const seat = f.actor.seat;
        if (!ctx.player(seat).alive) return;
        const lot = ctx.map.lotOfTile(f.node);
        if (lot?.startsWith('F') && wantsResearch(ctx, seat, lot as FacilityLotId)) {
          ctx.push({ k: 'ASK', seat, kind: 'RESEARCH', data: { lot }, stage: 'ask' });
        }
        return;
      }
      case 'done':
        ctx.pop(f);
        return;
    }
  },
};
