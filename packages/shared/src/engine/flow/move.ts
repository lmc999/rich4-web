/**
 * MOVE 帧：逐格移动（design/engine.md §7.5；docs/research/g_arbitration.md §2.l、§2.m）。
 * 路过只触发三件事：银行 ATM、路障拦停、身上定时炸弹的倒数与转移（M6 钩子）；其余一律停下才触发。
 * 路过银行（还有剩余步数、正常移动而非梦游、银行格上没有路障）：先公布已走的路段，压 BANK(pass)，
 * BANK 出栈后回到本帧继续走。
 * 岔路随机：候选为空掉头（不耗随机数），否则 候选[rand15()%n]（1 个候选也消耗一次）。
 * 走完后把自身替换为 LAND(node, steps=total)。
 */
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { EngineInvariantError } from '../errors';
import { nextTile } from '../rules/movement';
import type { FrameOf } from '../types/frames';
import type { TileId } from '../types/ids';

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

export const MOVE: FrameHandler<MoveFrame> = {
  step(ctx, f) {
    if (f.actor.t !== 'seat') throw new EngineInvariantError('NOT_IMPLEMENTED', 'villain movement (M7)');
    const p = ctx.player(f.actor.seat);
    while (f.remaining > 0) {
      const next = nextTile(ctx.map.index, p.node, p.prevNode, (n) => ctx.pick('fork', n));
      p.prevNode = p.node;
      p.node = next;
      f.seg.push(next);
      f.remaining -= 1;
      // TODO(M6)：身上定时炸弹 fuse−1（到 0 爆炸 → emitSegment + CONFINE(hospital,5)；同格有人则转手）
      // TODO(M6)：路障拦停（移除、回库存、ROADBLOCK_HIT、remaining=0）
      if (f.remaining > 0 && f.mode === 'normal' && passesBank(ctx, next)) {
        f.bankPassed = true;
        emitSegment(ctx, f);
        ctx.push({ k: 'BANK', seat: f.actor.seat, mode: 'pass', stage: 'atm' });
        return;
      }
    }
    emitSegment(ctx, f);
    ctx.replace(f, { k: 'LAND', actor: f.actor, node: p.node, steps: f.total, stage: 'beggar', skipSquare: false });
  },
};
