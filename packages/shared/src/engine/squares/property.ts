/**
 * 落点码 0（地产）：住宅（design/engine.md §8 kind 0；docs/research/r_property.md §3.2）。
 * - 无主：满足 canBuy（未梦游、无土地公 / 衰神 / 死神、现金 ≥ 价格）→ BUY_LAND；否则 INVEST_BLOCKED 或 CANNOT_AFFORD。
 * - 自己的：等级 < 5、非连锁店、现金足够 → UPGRADE_LAND（梦游中不问）。
 * - 别人的：TOLL 帧。
 * 设施（F）与企业（C）属于 M4，这里先做空处理。
 */
import type { LotId } from '../../data/maps/types';
import type { Ctx } from '../core/ctx';
import { EngineRuleError } from '../errors';
import { addTenure } from '../rules/calendar';
import { levelUpLand } from '../rules/landMutation';
import { canBuyLand, canUpgradeLand, fortuneBonus, upgradedLevel } from '../rules/purchase';
import type { SeatIndex } from '../types/ids';
import type { SquareHandler } from './index';

export const propertySquare: SquareHandler = (ctx, sq) => {
  const lot = ctx.map.lotOfTile(sq.tile.id);
  if (lot === null) return;
  if (lot.startsWith('L')) landSquare(ctx, sq.seat, lot, sq.sleepwalk);
  // TODO(M4)：设施（BUY_FACILITY / BUILD_FACILITY / UPGRADE_FACILITY / FEE）与企业格（COMPANY_FEE / SUBSCRIBE_SHARES）
};

function landSquare(ctx: Ctx, seat: SeatIndex, lot: LotId, sleepwalk: boolean): void {
  const i = ctx.map.landIdx(lot);
  if (i < 0) return;
  const land = ctx.s.lands[i]!;
  if (land.owner === seat) {
    if (sleepwalk) return;
    const chk = canUpgradeLand(ctx.s, ctx.map, seat, i);
    if (chk.ok) ctx.push({ k: 'ASK', seat, kind: 'UPGRADE_LAND', data: { lot }, stage: 'ask' });
    else if (chk.reason === 'investBlocked') ctx.emit('INVEST_BLOCKED', { seat, lot, god: chk.god });
    else if (chk.reason === 'notEnoughCash') ctx.emit('CANNOT_AFFORD', { seat, lot, price: chk.price });
    return;
  }
  if (land.owner === null) {
    if (sleepwalk) return;
    const chk = canBuyLand(ctx.s, ctx.map, seat, i);
    if (chk.ok) ctx.push({ k: 'ASK', seat, kind: 'BUY_LAND', data: { lot }, stage: 'ask' });
    else if (chk.reason === 'investBlocked') ctx.emit('INVEST_BLOCKED', { seat, lot, god: chk.god });
    else if (chk.reason === 'notEnoughCash') ctx.emit('CANNOT_AFFORD', { seat, lot, price: chk.price });
    return;
  }
  ctx.push({ k: 'TOLL', payer: seat, lot, stage: 'compute', q: null });
}

/** BUY_LAND 的 CONFIRM：只用现金，成功后写地契期限；PROGRAM 下福神附身额外送 1 级 */
export function confirmBuyLand(ctx: Ctx, seat: SeatIndex, lot: LotId): void {
  const i = ctx.map.landIdx(lot);
  const land = ctx.s.lands[i];
  if (!land || land.owner !== null) throw new EngineRuleError('NOT_ALLOWED', `${lot} is not for sale`);
  const chk = canBuyLand(ctx.s, ctx.map, seat, i);
  if (!chk.ok) throw new EngineRuleError(chk.reason === 'notEnoughCash' ? 'CANNOT_AFFORD' : 'NOT_ALLOWED', chk.reason);
  const p = ctx.player(seat);
  const bonus = fortuneBonus(ctx.s, p);
  if (!ctx.spendCash(seat, chk.price)) throw new EngineRuleError('CANNOT_AFFORD');
  land.owner = seat;
  land.tenure = addTenure(ctx.s.clock.date, ctx.s.config.tenure);
  ctx.emit('LAND_BOUGHT', { seat, lot, price: chk.price });
  if (bonus > 0) {
    const ch = levelUpLand(land, 1);
    if (ch.to !== ch.from)
      ctx.emit('LOT_LEVEL', { lot, from: ch.from, to: ch.to, cause: { k: 'god', ref: p.god?.kind ?? null, by: seat } });
  }
}

/** UPGRADE_LAND 的 CONFIRM：房价 × PI，只用现金；福神附身多送 1 级（封顶 5） */
export function confirmUpgradeLand(ctx: Ctx, seat: SeatIndex, lot: LotId): void {
  const i = ctx.map.landIdx(lot);
  const land = ctx.s.lands[i];
  if (!land || land.owner !== seat) throw new EngineRuleError('NOT_ALLOWED', `${lot} is not yours`);
  const chk = canUpgradeLand(ctx.s, ctx.map, seat, i);
  if (!chk.ok) throw new EngineRuleError(chk.reason === 'notEnoughCash' ? 'CANNOT_AFFORD' : 'NOT_ALLOWED', chk.reason);
  const p = ctx.player(seat);
  const from = land.level;
  const to = upgradedLevel(from, fortuneBonus(ctx.s, p));
  if (!ctx.spendCash(seat, chk.price)) throw new EngineRuleError('CANNOT_AFFORD');
  land.level = to;
  ctx.emit('LOT_LEVEL', { lot, from, to, cause: { k: 'system', ref: 'upgrade', by: seat } });
}
