/**
 * 投降与死神（design/engine.md §9.2 DEATH_GOD_TARGET、§10.5 死神；docs/research/r_deities.md §7.13；r_rules_map.md §2）。
 *
 * 条件（canSurrender）：本人是真人、在场真人 ≥ 2、在场玩家 ≥ 3（投降后仍 ≥ 2 人）；AI 永不投降。
 * SURRENDER 帧（TURN_MENU 的终结 intent；投降者的 TURN 随后转入 end）：
 *   announce  SURRENDERED{seat}
 *   target    DEATH_GOD_TARGET（候选：其他在场玩家；投降者此时仍在场，所以决策属于在场座位）→ 召唤死神附身：
 *             目标身上已有神明先送走（搭档刷出）→ DEATH_GOD_SUMMONED → GOD_ATTACHED（13 天）→ 发威（没收卡片与道具）
 *   detach … beggar  与破产相同（flow/liquidation.ts）：出局（out='surrender'）、炸弹与神明与同盟、他雇的恶人送回；
 *             终局判定；清算（> 3 处随机拍 3 处，成交款进公库）；成为乞丐 ⚑V-R9（投降者是否变乞丐未核实，按破产处理）
 */

import { CMB } from '../../data/tables/combat';
import { GOD } from '../../data/tables/ids';
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { godEffect } from '../effects/gods/index';
import { attachedSlot, attachGod, leaveGod } from '../effects/gods/lifecycle';
import { EngineInvariantError, EngineRuleError } from '../errors';
import { checkAfterBankruptcy } from '../rules/victory';
import type { DeathGodTargetOptions } from '../types/decision';
import type { FrameOf } from '../types/frames';
import type { SeatIndex } from '../types/ids';
import type { GameState } from '../types/state';
import { pushAuction } from './auction';
import { becomeBeggar, detachCombat, liquidate, markOut } from './liquidation';

type SurrenderFrame = FrameOf<'SURRENDER'>;

/** 投降条件：本人是在场真人，在场真人 ≥ 2、在场玩家 ≥ 3 */
export function canSurrender(s: GameState, seat: SeatIndex): boolean {
  const me = s.players.find((p) => p.seat === seat);
  if (!me?.alive || me.controller !== 'human') return false;
  const alive = s.players.filter((p) => p.alive);
  const humans = alive.filter((p) => p.controller === 'human').length;
  return humans >= CMB.SURRENDER_MIN_HUMANS && alive.length >= CMB.SURRENDER_MIN_PLAYERS;
}

/** 死神附身的候选：其他在场玩家（按座位） */
export function deathGodCandidates(s: GameState, seat: SeatIndex): SeatIndex[] {
  return s.players.filter((p) => p.alive && p.seat !== seat).map((p) => p.seat);
}

/**
 * 召唤死神附身 target：身上已有神明先送走 → DEATH_GOD_SUMMONED → GOD_ATTACHED → 发威（没收全部卡片与道具，不折点券）。
 * 两个死神槽都在场时无效（返回 false）。
 */
export function summonDeathGod(ctx: Ctx, by: SeatIndex, target: SeatIndex): boolean {
  const slot = ctx.s.gods.find((g) => g.kind === GOD.DEATH && g.where.t === 'absent');
  if (!slot) return false;
  ctx.emit('DEATH_GOD_SUMMONED', { by, target });
  const old = attachedSlot(ctx.s, target);
  let displaced = null;
  if (old !== null) {
    displaced = old.kind;
    leaveGod(ctx, old, 'displaced');
  }
  attachGod(ctx, target, slot, displaced);
  godEffect(GOD.DEATH).power?.(ctx, target);
  return true;
}

export const SURRENDER: FrameHandler<SurrenderFrame> = {
  step(ctx, f) {
    const s = ctx.s;
    switch (f.stage) {
      case 'announce':
        f.stage = 'target';
        ctx.emit('SURRENDERED', { seat: f.seat });
        return;
      case 'target': {
        f.stage = 'detach';
        const candidates = deathGodCandidates(s, f.seat);
        const free = s.gods.some((g) => g.kind === GOD.DEATH && g.where.t === 'absent');
        if (candidates.length === 0 || !free || !ctx.player(f.seat).alive) return;
        f.stage = 'target';
        const options: DeathGodTargetOptions = { candidates };
        ctx.ask(f, f.seat, 'DEATH_GOD_TARGET', options, { type: 'DEATH_GOD_TARGET', target: candidates[0]! });
        return;
      }
      case 'detach':
        f.stage = 'endcheck';
        markOut(ctx, f.seat, 'surrender');
        detachCombat(ctx, f.seat, { k: 'surrender', ref: null, by: f.seat });
        return;
      case 'endcheck': {
        const end = checkAfterBankruptcy(s);
        if (end) {
          ctx.endGame(end);
          return;
        }
        f.stage = 'liquidate';
        return;
      }
      case 'liquidate':
        f.stage = 'auctions';
        f.auctionLots = liquidate(ctx, f.seat).auctionLots;
        return;
      case 'auctions': {
        const lot = f.auctionLots.shift();
        if (lot === undefined) {
          f.stage = 'beggar';
          return;
        }
        pushAuction(ctx, lot, null, 'surrender');
        return;
      }
      case 'beggar':
        f.stage = 'done';
        becomeBeggar(ctx, f.seat);
        return;
      case 'done':
        ctx.pop(f);
        ctx.unwindActor(f.seat);
        return;
    }
  },
  resume(ctx, f, a, d) {
    if (f.stage !== 'target' || d.kind !== 'DEATH_GOD_TARGET' || a.type !== 'DEATH_GOD_TARGET') {
      throw new EngineInvariantError('SURRENDER_RESUME', f.stage);
    }
    const cands = (d.options as DeathGodTargetOptions).candidates;
    if (!cands.includes(a.target)) throw new EngineRuleError('INVALID_TARGET', `seat ${a.target} is not a candidate`);
    const t = ctx.s.players.find((p) => p.seat === a.target);
    if (!t?.alive) throw new EngineRuleError('INVALID_TARGET', `seat ${a.target} is out`);
    f.stage = 'detach';
    summonDeathGod(ctx, f.seat, a.target);
  },
};
