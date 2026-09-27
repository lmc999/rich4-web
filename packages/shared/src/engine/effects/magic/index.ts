/**
 * 魔法屋（design/engine.md §10.8，以 docs/research/events-from-exe.md §3、§4 为准；数值读 data/tables/magic.ts）。
 *
 * 落点码 16（squares/magic.ts）→ MAGIC 帧：
 *   cond   条件 rand15() % 12（purpose 'magicCond'，真人与电脑相同），名单为空就重抽（不设上限；实现上 256 次后按序取
 *          第一个非空条件，性别条件总是非空，实际不会用到）→ MAGIC_CONDITION{caster, cond, targets} → MAGIC_CAST 决策
 *          （options 列出全部 12 种效果；电脑的选法在 ai/decisions/magic.ts）
 *   apply  MAGIC_CAST{caster, effect, targets} 后对名单逐人执行（idx 为游标；压子帧时先返回，子帧完成后继续下一人）：
 *     0 卡片全部按商店价全价折点券（CARD_LOST{magic}）；8 道具全部全价折点券（座驾先折回道具、改回步行 → VEHICLE；
 *       ITEM_LOST{magic}）
 *     1 连抽三张命运（按目标自己的加持判定；effects/fate 的 draw 帧）
 *     2 / 10 目标对施法者敌意 +90 × PI（即使随后被免罪卡挡下）→ 免罪 → 嫁祸 → 坐牢 / 住院 3 天（CONFINE）
 *     3 停留计数 + 1；4 现金全部存入（ATM{deposit}）；6 得到一张卡（牌堆加权抽）
 *     5 / 7 / 9 / 11（跳过受困者；脚下须是住宅或设施）：免费加盖一层（0 级设施由目标选类型 FACILITY_TYPE）/
 *       原地向后转 / 拆一层 / 以目标为卖方拍卖脚下地产（成交款进目标存款，流拍变无主 ⚑V-R7）
 */

import { characterDef } from '../../../data/tables/characters';
import { MAGIC_CONDITION_IDS, type MagicConditionId, type MagicEffectId } from '../../../data/tables/ids';
import { magicEffectDef, magicParam } from '../../../data/tables/magic';
import type { Ctx } from '../../core/ctx';
import type { FrameHandler } from '../../core/frameHandler';
import type { EngineMap } from '../../core/mapCache';
import { defaultIntentFor } from '../../decisions/defaults';
import { isFacilityLot, lotState, underfootLot } from '../../decisions/targets';
import { EngineInvariantError, EngineRuleError } from '../../errors';
import { pushAuction } from '../../flow/auction';
import { pushConfine } from '../../flow/confine';
import { addCounterDays, mainBlockOf } from '../../rules/counters';
import { drawFromDeck } from '../../rules/inventory';
import { addMoney } from '../../rules/payment';
import { netWorth } from '../../rules/wealth';
import type { MagicCastOptions } from '../../types/decision';
import type { FrameOf } from '../../types/frames';
import type { SeatIndex } from '../../types/ids';
import type { GameState, PlayerState } from '../../types/state';
import { gainCard, mutateLot, raiseLot, timesPI } from '../common';
import { pushFateDraw, sellAllCardsFull, sellAllItemsDetailed } from '../fate/index';

type MagicFrame = FrameOf<'MAGIC'>;

const ALL_EFFECTS: readonly MagicEffectId[] = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const);

/** 数值最多者（并列全选）；zeroCounts=false 时数值 ≤ 0 的不参选 */
function maxBy(ps: readonly PlayerState[], score: (p: PlayerState) => number, zeroCounts: boolean): SeatIndex[] {
  let max: number | null = null;
  for (const p of ps) {
    const v = score(p);
    if (!zeroCounts && v <= 0) continue;
    if (max === null || v > max) max = v;
  }
  if (max === null) return [];
  return ps.filter((p) => (zeroCounts || score(p) > 0) && score(p) === max).map((p) => p.seat);
}

/** 条件名单（在场玩家，按座位） */
export function magicTargets(s: GameState, em: EngineMap, cond: MagicConditionId): SeatIndex[] {
  const ps = s.players.filter((p) => p.alive);
  const lots = (p: PlayerState, built: boolean) =>
    s.lands.filter((l) => l.owner === p.seat && (!built || l.level > 0)).length +
    s.facilities.filter((f) => f.owner === p.seat && (!built || f.level > 0)).length;
  switch (cond) {
    case 0:
      return maxBy(ps, (p) => netWorth(s, em, p.seat), true);
    case 1:
      return maxBy(ps, (p) => lots(p, false), false);
    case 2:
      return maxBy(ps, (p) => lots(p, true), false);
    case 3:
      return maxBy(ps, (p) => p.cash, false);
    case 4:
      return maxBy(ps, (p) => p.deposit, false);
    case 5:
      return maxBy(ps, (p) => p.points, false);
    case 6:
      return ps.filter((p) => p.vehicle === 'walk').map((p) => p.seat);
    case 7:
      return ps.filter((p) => p.vehicle === 'moto').map((p) => p.seat);
    case 8:
      return ps.filter((p) => p.vehicle === 'car').map((p) => p.seat);
    case 9:
      return ps.filter((p) => p.god !== null).map((p) => p.seat);
    case 10:
      return ps.filter((p) => characterDef(p.character).gender === 'm').map((p) => p.seat);
    case 11:
      return ps.filter((p) => characterDef(p.character).gender === 'f').map((p) => p.seat);
  }
}

/** 魔法屋格：压 MAGIC 帧 */
export function pushMagic(ctx: Ctx, caster: SeatIndex): void {
  ctx.push({ k: 'MAGIC', caster, cond: 0, targets: [], effect: null, idx: 0, stage: 'cond' });
}

export function magicCastOptions(f: MagicFrame): MagicCastOptions {
  return { condition: f.cond, targets: f.targets.slice(), effects: ALL_EFFECTS.slice() };
}

/** 受困：坐牢、住院、住旅馆、消失（计数非 0） */
function confined(p: PlayerState): boolean {
  return mainBlockOf(p.st) !== null;
}

function applyToTarget(ctx: Ctx, f: MagicFrame, effect: MagicEffectId, seat: SeatIndex): void {
  const s = ctx.s;
  const q = ctx.player(seat);
  if (!q.alive) return;
  const def = magicEffectDef(effect);
  if (def.skipConfined && confined(q)) return;
  const cause = { k: 'magic', ref: effect, by: f.caster } as const;
  switch (def.key) {
    case 'sellCards': {
      const cards = q.cards.slice();
      if (cards.length === 0) return;
      sellAllCardsFull(ctx, seat);
      for (const card of cards) ctx.emit('CARD_LOST', { seat, card, cause: 'magic' });
      return;
    }
    case 'sellTools': {
      const r = sellAllItemsDetailed(ctx, seat);
      // 座驾改回步行单独公布（工程车 + 空背包时后面一个 ITEM_LOST 都没有，变化不能夹带进下一个事件）
      if (r.vehicleChanged) ctx.emit('VEHICLE', { seat, vehicle: 'walk', dice: 1 });
      for (const x of r.sold) ctx.emit('ITEM_LOST', { seat, item: x.item, qty: x.qty, cause: 'magic' });
      return;
    }
    case 'drawFate3':
      // LIFO：三张依次压栈，执行时逐张现抽
      for (let i = 0; i < 3; i++) pushFateDraw(ctx, seat);
      return;
    case 'jail':
    case 'hospital':
      pushConfine(
        ctx,
        { t: 'seat', seat },
        {
          where: def.key === 'jail' ? 'jail' : 'hospital',
          days: magicParam(effect, 'days'),
          cause,
          passive: true,
          hate: timesPI(ctx, magicParam(effect, 'hate')),
        },
      );
      return;
    case 'stay':
      q.st.stay = q.st.stay === 0 ? 1 : addCounterDays(q.st.stay, 1);
      ctx.emit('STATUS_SET', { actor: { t: 'seat', seat }, status: 'stay', value: q.st.stay });
      return;
    case 'depositAll': {
      const amount = q.cash;
      if (amount <= 0) return;
      q.cash = 0;
      q.deposit = addMoney(s, q.deposit, amount);
      ctx.emit('ATM', { seat, op: 'deposit', amount });
      return;
    }
    case 'drawCard': {
      const card = drawFromDeck(s);
      if (card !== null) gainCard(ctx, seat, card, 'magic');
      return;
    }
    case 'turnAround': {
      // 还没跳伞（首回合）的人不在棋盘上，没有方向可转
      if (!q.placed) return;
      const cands = ctx.map.index.forwardCandidates(q.node, q.prevNode);
      if (cands.length > 0) q.prevNode = cands[ctx.pick('reverse', cands.length)]!;
      ctx.emit('REVERSED', { actor: { t: 'seat', seat } });
      return;
    }
    case 'upgradeHere': {
      const lot = underfootLot(s, ctx.map, seat);
      if (lot === null) return;
      const st = lotState(s, ctx.map, lot);
      if (!st) return;
      if (isFacilityLot(lot) && st.level === 0) {
        // 空的商业用地：免费首建，由目标选类型（电脑随机）
        ctx.push({ k: 'ASK', seat, kind: 'FACILITY_TYPE', data: { lot }, stage: 'ask' });
        return;
      }
      raiseLot(ctx, lot, cause);
      return;
    }
    case 'demolishHere': {
      const lot = underfootLot(s, ctx.map, seat);
      if (lot !== null) mutateLot(ctx, lot, 0, cause);
      return;
    }
    case 'auctionHere': {
      const lot = underfootLot(s, ctx.map, seat);
      if (lot !== null) pushAuction(ctx, lot, seat, 'magic');
      return;
    }
  }
}

export const MAGIC: FrameHandler<MagicFrame> = {
  step(ctx, f) {
    switch (f.stage) {
      case 'cond': {
        let cond: MagicConditionId | null = null;
        let targets: SeatIndex[] = [];
        for (let i = 0; i < 256 && cond === null; i++) {
          const c = ctx.pick('magicCond', MAGIC_CONDITION_IDS.length) as MagicConditionId;
          const t = magicTargets(ctx.s, ctx.map, c);
          if (t.length > 0) {
            cond = c;
            targets = t;
          }
        }
        if (cond === null) {
          for (const c of MAGIC_CONDITION_IDS) {
            const t = magicTargets(ctx.s, ctx.map, c);
            if (t.length > 0) {
              cond = c;
              targets = t;
              break;
            }
          }
        }
        if (cond === null) {
          f.stage = 'done';
          return;
        }
        f.cond = cond;
        f.targets = targets;
        f.stage = 'cast';
        ctx.emit('MAGIC_CONDITION', { caster: f.caster, cond, targets: targets.slice() });
        const options = magicCastOptions(f);
        ctx.ask(f, f.caster, 'MAGIC_CAST', options, defaultIntentFor('MAGIC_CAST', options, f.caster));
        return;
      }
      case 'cast':
        throw new EngineInvariantError('MAGIC_STAGE', 'cast without a pending decision');
      case 'apply': {
        const effect = f.effect;
        if (effect === null) {
          f.stage = 'done';
          return;
        }
        while (f.idx < f.targets.length) {
          const seat = f.targets[f.idx]!;
          f.idx += 1;
          applyToTarget(ctx, f, effect, seat);
          if (ctx.top() !== f) return;
        }
        f.stage = 'done';
        return;
      }
      case 'done':
        ctx.pop(f);
        return;
    }
  },
  resume(ctx, f, a, d) {
    if (f.stage !== 'cast' || d.kind !== 'MAGIC_CAST' || a.type !== 'MAGIC_CAST') {
      throw new EngineInvariantError('MAGIC_RESUME', f.stage);
    }
    if (!(d.options as MagicCastOptions).effects.includes(a.effect)) {
      throw new EngineRuleError('INVALID_TARGET', `effect ${a.effect} is not offered`);
    }
    f.effect = a.effect;
    f.idx = 0;
    f.stage = 'apply';
    ctx.emit('MAGIC_CAST', { caster: f.caster, effect: a.effect, targets: f.targets.slice() });
  },
};
