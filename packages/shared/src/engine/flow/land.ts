/**
 * LAND 帧：落点结算，顺序 beggar → object → square → tail → lab（design/engine.md §7.6，@0x41b077 settle）。
 * 每个阶段先把 stage 推进到下一阶段，再执行本阶段（可能压子帧或 ask），子帧完成后从下一阶段继续。
 *
 * beggar  LANDED；该格除自己外座位号最小的人是乞丐 → 施舍 1000×PI 进公库，乞丐换位（effects/beggar.ts）
 * object  物件与路上的神（effects/objects.ts）：地雷、恶犬咬人 → 本次落点结束；神明 → GOD 帧
 * square  17 类落点（squares/index.ts）
 * tail    神明显灵（天使 +1、恶魔 −1、土地公强占，只作用于落点那一格）→ 工程车拆房（PROGRAM：别人或无主的、
 *         已有建筑的住宅或设施清到 0 级，地主敌意 +30×PI）⚑两者先后
 * lab     业主停在自己已建成、未查封的研究所（未梦游）→ RESEARCH
 * skipSquare=true 是「走回棋盘」（刚从监狱、医院等释放）：从 object 阶段开始，只做物件结算、显灵与工程车，不结算格子事件。
 */
import { CMB } from '../../data/tables/combat';
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { lotState } from '../decisions/targets';
import { settleBeggar } from '../effects/beggar';
import { addHostility, mutateLot, timesPI } from '../effects/common';
import { godEffect } from '../effects/gods/index';
import { settleLandingObjects } from '../effects/objects';
import { EngineInvariantError } from '../errors';
import { wantsResearch } from '../squares/facility';
import { settleSquare } from '../squares/index';
import type { FrameOf } from '../types/frames';
import type { FacilityLotId, SeatIndex, TileId } from '../types/ids';

type LandFrame = FrameOf<'LAND'>;

/** 'tail'：神明显灵 → 工程车拆房（PROGRAM） */
function settleTail(ctx: Ctx, seat: SeatIndex, tile: TileId): void {
  const p = ctx.player(seat);
  if (!p.alive) return;
  const lot = ctx.map.lotOfTile(tile);
  if (lot === null || lot.startsWith('C')) return;
  const manifest = p.god ? godEffect(p.god.kind).manifest : null;
  if (manifest) manifest(ctx, seat, lot);
  if (p.vehicle !== 'engineer' || ctx.s.config.rules.engineeringVehicle !== 'program') return;
  const st = lotState(ctx.s, ctx.map, lot);
  if (!st || st.owner === seat || st.level <= 0) return;
  if (st.owner !== null) addHostility(ctx, st.owner, seat, timesPI(ctx, CMB.HATE_DEMOLISH_PI));
  mutateLot(ctx, lot, 2, { k: 'engineer', ref: lot, by: seat });
}

export const LAND: FrameHandler<LandFrame> = {
  step(ctx, f) {
    if (f.actor.t !== 'seat') throw new EngineInvariantError('NOT_IMPLEMENTED', 'villain landing (M7)');
    const seat = f.actor.seat;
    switch (f.stage) {
      case 'beggar':
        f.stage = 'object';
        ctx.emit('LANDED', { actor: f.actor, node: f.node });
        settleBeggar(ctx, seat, f.node);
        return;
      case 'object':
        f.stage = 'square';
        if (!ctx.player(seat).alive) return;
        if (settleLandingObjects(ctx, f) === 'stop') f.stage = 'done';
        return;
      case 'square':
        f.stage = 'tail';
        if (!f.skipSquare) settleSquare(ctx, f);
        return;
      case 'tail':
        f.stage = 'lab';
        settleTail(ctx, seat, f.node);
        return;
      case 'lab': {
        f.stage = 'done';
        if (f.skipSquare || !ctx.player(seat).alive) return;
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
