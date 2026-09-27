/**
 * 乞丐（design/engine.md §10.9；docs/research/g_villains.md §5）：破产者的棋子留在原格。
 * 玩家停在某格（路过不算），且该格除自己外座位号最小的那个人已出局（是乞丐）时：
 *   施舍 1000 × PI 进公库（先现金后存款，付不起就破产；不走被动卡）；
 *   乞丐换位：从空道路格里随机抽，与原位置 |dx| ≥ 300 或 |dy| ≥ 300，64 次后放宽（DEV-08；原版候选为 0 时会除零崩溃）
 * → BEGGAR_ALMS{payer, beggar, amount, newNode}。恶人不理会乞丐。结算顺序：乞丐 → 物件 → 格子事件。
 */
import { ECON } from '../../data/tables/economy';
import type { Ctx } from '../core/ctx';
import { isOnBoard, tileWorld } from '../decisions/targets';
import type { SeatIndex, TileId } from '../types/ids';
import { timesPI } from './common';
import { farRandomTile } from './gods/lifecycle';

/** tile 上「除 seat 外座位号最小的人」如果是乞丐就返回他的座位 */
export function beggarAt(ctx: Ctx, seat: SeatIndex, tile: TileId): SeatIndex | null {
  let lowest: { seat: SeatIndex; beggar: boolean } | null = null;
  const consider = (s: SeatIndex, beggar: boolean) => {
    if (s === seat) return;
    if (lowest === null || s < lowest.seat) lowest = { seat: s, beggar };
  };
  for (const p of ctx.s.players) if (isOnBoard(p) && p.node === tile) consider(p.seat, false);
  for (const b of ctx.s.beggars) if (b.node === tile) consider(b.seat, true);
  const l = lowest as { seat: SeatIndex; beggar: boolean } | null;
  return l?.beggar ? l.seat : null;
}

/** LAND 'beggar' 阶段：施舍并让乞丐换位；返回是否施舍了 */
export function settleBeggar(ctx: Ctx, seat: SeatIndex, tile: TileId): boolean {
  const who = beggarAt(ctx, seat, tile);
  if (who === null) return false;
  const amount = timesPI(ctx, ECON.BEGGAR_ALMS);
  ctx.pay({ t: 'seat', seat }, { t: 'pool' }, amount, {
    reason: 'beggar',
    accident: true,
    cause: { k: 'beggar', ref: who, by: null },
  });
  const b = ctx.s.beggars.find((x) => x.seat === who)!;
  const next = farRandomTile(ctx.s, ctx.map, tileWorld(ctx.map, b.node), (n) => ctx.pick('beggar', n), [b.node]);
  if (next !== null) b.node = next;
  ctx.emit('BEGGAR_ALMS', { payer: seat, beggar: who, amount, newNode: b.node });
  return true;
}
