/**
 * MOVE 帧：逐格移动（design/engine.md §7.5；docs/research/g_arbitration.md §2.e、§2.l、§2.m）。
 * 路过只触发：身上定时炸弹的倒数与转移、路障拦停、银行 ATM（以及 MANUAL 工程车的沿路拆房）；其余一律停下才触发。
 * 每一步（先移动，再按下面的顺序）：
 *   炸弹   引信 −1：到 0 爆炸（先公布已走的路段）→ 本帧出栈，不结算落点；否则同格有人则转手（BOMB_TRANSFERRED）
 *   路障   拦停：移除（回库存）→ ROADBLOCK_HIT，剩余步数作废，照常结算该格
 *   工程车 MANUAL（engineeringVehicle='manual'）：经过与停留的对手房屋各拆 1 级
 *   银行   还有剩余步数、正常移动而非梦游、银行格上没有路障：先公布已走的路段，压 BANK(pass)，完成后回到本帧继续走
 * 岔路随机：候选为空掉头（不耗随机数），否则 候选[rand15()%n]（1 个候选也消耗一次）。
 * 走完后把自身替换为 LAND(node, steps=total)。恶人（mode 'villain'）另见 villainMove。
 */
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { lotState } from '../decisions/targets';
import { mutateLot } from '../effects/common';
import { hitRoadblock, tickCarriedBomb } from '../effects/objects';
import { onNpcStep, villainOf } from '../effects/villains/index';
import { nextTile } from '../rules/movement';
import type { FrameOf } from '../types/frames';
import type { SeatIndex, TileId, VillainKind } from '../types/ids';

type MoveFrame = FrameOf<'MOVE'>;

function passesBank(ctx: Ctx, tile: TileId): boolean {
  if (ctx.map.index.tile(tile).kind !== 'bank') return false;
  return !ctx.s.objects.some((o) => o.node === tile && o.kind === 'roadblock');
}

function emitSegment(ctx: Ctx, f: MoveFrame): void {
  if (f.seg.length === 0) return;
  const path = f.seg;
  f.seg = [];
  ctx.emit('MOVE_SEGMENT', { actor: f.actor, path, remaining: f.remaining });
}

/** MANUAL 工程车：经过或停留的对手（有主且不是自己）房屋拆 1 级 */
function manualEngineer(ctx: Ctx, f: MoveFrame, seat: SeatIndex, tile: TileId): void {
  const p = ctx.player(seat);
  if (p.vehicle !== 'engineer' || ctx.s.config.rules.engineeringVehicle !== 'manual') return;
  const lot = ctx.map.lotOfTile(tile);
  if (lot === null || lot.startsWith('C')) return;
  const st = lotState(ctx.s, ctx.map, lot);
  if (!st || st.owner === null || st.owner === seat || st.level <= 0) return;
  emitSegment(ctx, f);
  mutateLot(ctx, lot, 0, { k: 'engineer', ref: lot, by: seat });
}

/**
 * 恶人移动（mode 'villain'；docs/research/g_villains.md §2–§3）：每一步先走再按 onNpcStep 结算；
 * 结算可能压子帧（受害者破产、雇主满手弃牌）：此时先返回，子帧完成后从下一步继续（本格已结算完）。
 * 恶人被送医院 / 送回老家或被路障拦下时，剩余步数作废；走完后本帧出栈（恶人没有落点结算）。
 */
function villainMove(ctx: Ctx, f: MoveFrame, kind: VillainKind): void {
  const v = villainOf(ctx.s, kind);
  while (f.remaining > 0) {
    if (!v.onBoard || v.employer === null) {
      f.remaining = 0;
      break;
    }
    const next = nextTile(ctx.map.index, v.node, v.prevNode, (n) => ctx.pick('fork', n));
    v.prevNode = v.node;
    v.node = next;
    f.seg.push(next);
    f.remaining -= 1;
    const r = onNpcStep(ctx, f, v, next, () => emitSegment(ctx, f));
    if (r !== 'go') f.remaining = 0;
    if (ctx.top() !== f) return;
  }
  emitSegment(ctx, f);
  ctx.pop(f);
}

export const MOVE: FrameHandler<MoveFrame> = {
  step(ctx, f) {
    if (f.actor.t !== 'seat') {
      villainMove(ctx, f, f.actor.kind);
      return;
    }
    const seat = f.actor.seat;
    const p = ctx.player(seat);
    while (f.remaining > 0) {
      const next = nextTile(ctx.map.index, p.node, p.prevNode, (n) => ctx.pick('fork', n));
      p.prevNode = p.node;
      p.node = next;
      f.seg.push(next);
      f.remaining -= 1;
      if (tickCarriedBomb(ctx, seat, next, () => emitSegment(ctx, f)) === 'exploded') {
        // 爆炸：携带者已住院，移动终止，不结算落点
        ctx.pop(f);
        return;
      }
      if (ctx.s.objects.some((o) => o.node === next && o.kind === 'roadblock')) {
        emitSegment(ctx, f);
        f.remaining = 0;
        hitRoadblock(ctx, seat, next);
      }
      manualEngineer(ctx, f, seat, next);
      if (f.remaining > 0 && f.mode === 'normal' && passesBank(ctx, next)) {
        f.bankPassed = true;
        emitSegment(ctx, f);
        ctx.push({ k: 'BANK', seat, mode: 'pass', stage: 'atm' });
        return;
      }
    }
    emitSegment(ctx, f);
    ctx.replace(f, { k: 'LAND', actor: f.actor, node: p.node, steps: f.total, stage: 'beggar', skipSquare: false });
  },
};
