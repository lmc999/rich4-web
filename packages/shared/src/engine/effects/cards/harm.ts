/**
 * 梦游卡、陷害卡的伤害链（design/engine.md §10.2 #16/17、§10.3；docs/research/r_cards.md §5；g_villains.md §6）。
 * 目标：范围内的对手或恶人。恶人不查免罪 / 嫁祸 / 复仇，也不计敌意。
 *
 * 17 陷害：敌意 150×PI（before，随 CARD_USED 公布）→ CONFINE 帧（jail 5 天，passive、revenge、selfDays 4）：
 *   免罪（自动，消耗后结束）→ 嫁祸（问目标，可以嫁祸回出卡者：4 天）→ 坐牢 → 复仇（最终目标 == 原目标
 *   且持复仇卡：出卡者也坐牢 5 天）
 * 16 梦游：敌意 150×PI（before，随 CARD_USED 公布）→ CARD 帧，stage：
 *   check      目标正在冬眠 → 整张卡无效（CARD_NO_EFFECT，卡照扣）
 *   exempt     免罪卡自动抵消
 *   scapegoat  嫁祸卡（SCAPEGOAT）；嫁祸回出卡者时 4 天
 *   apply      梦游 5 天（或 4 天）：交通工具退回背包、骰子数改为 1
 *   revenge    没被改嫁、原目标持复仇卡 → 出卡者也梦游 5 天
 */

import { CMB } from '../../../data/tables/combat';
import { CARD } from '../../../data/tables/ids';
import type { Ctx } from '../../core/ctx';
import { actorsInRange } from '../../decisions/targets';
import { EngineInvariantError } from '../../errors';
import { pushConfine } from '../../flow/confine';
import { askScapegoat, consumePassive, holdsCard, resolveScapegoat, scapegoatCandidates } from '../../flow/passive';
import type { ScapegoatOptions } from '../../types/decision';
import type { FrameOf } from '../../types/frames';
import type { SeatIndex } from '../../types/ids';
import type { PlayerAction, UseTarget } from '../../types/intent';
import { addHostility, setActorStatus, stowVehicle, timesPI } from '../common';
import type { CardEffect } from '../types';
import { usableIf } from '../types';
import { confineVillain } from '../villainState';

type CardFrame = FrameOf<'CARD'>;

const TARGETS = { self: false, others: true, villains: true } as const;

function harmMenu(s: Parameters<CardEffect['menu']>[0], em: Parameters<CardEffect['menu']>[1], seat: SeatIndex) {
  const actors = actorsInRange(s, em, seat, TARGETS);
  return usableIf({ t: 'actor', actors }, actors.length === 0);
}

/** 被害者对出卡者的敌意 150×PI（恶人不计）：随 CARD_USED 公布 */
function harmHate(ctx: Ctx, seat: SeatIndex, t: UseTarget): void {
  if (t.t === 'actor' && t.actor.t === 'seat') addHostility(ctx, t.actor.seat, seat, timesPI(ctx, CMB.HATE_HARM_PI));
}

export const frame: CardEffect = {
  menu: harmMenu,
  before: harmHate,
  apply(ctx, seat, t) {
    if (t.t !== 'actor') return;
    const cause = { k: 'card', ref: CARD.FRAME, by: seat } as const;
    if (t.actor.t === 'villain') {
      confineVillain(ctx, t.actor.kind, 'jail', cause);
      return;
    }
    pushConfine(ctx, t.actor, {
      where: 'jail',
      days: CMB.FRAME_DAYS,
      cause,
      passive: true,
      selfDays: CMB.FRAME_SELF_DAYS,
      revenge: true,
    });
  },
};

export const sleepwalk: CardEffect = {
  menu: harmMenu,
  before: harmHate,
  apply(ctx, seat, t) {
    if (t.t !== 'actor') return;
    if (t.actor.t === 'villain') {
      const kind = t.actor.kind;
      const v = ctx.s.villains.find((x) => x.kind === kind)!;
      if (v.st.hibernate !== 0) ctx.emit('CARD_NO_EFFECT', { seat, card: CARD.SLEEPWALK });
      else setActorStatus(ctx, t.actor, 'sleepwalk', CMB.SLEEPWALK_DAYS);
      return;
    }
    const target = t.actor.seat;
    ctx.push({
      k: 'CARD',
      seat,
      card: CARD.SLEEPWALK,
      target: t,
      stage: 'check',
      data: { target, orig: target, days: CMB.SLEEPWALK_DAYS, scapegoated: false },
    });
  },
};

function targetOf(f: CardFrame): SeatIndex {
  const v = f.data.target;
  if (typeof v !== 'number') throw new EngineInvariantError('CARD_DATA', 'sleepwalk without target');
  return v as SeatIndex;
}

/** CARD 帧的梦游链（card 16） */
export const sleepwalkChain = {
  step(ctx: Ctx, f: CardFrame): void {
    const target = targetOf(f);
    const p = ctx.s.players.find((x) => x.seat === target);
    if (!p?.alive && f.stage !== 'done') {
      f.stage = 'done';
      return;
    }
    switch (f.stage) {
      case 'check':
        f.stage = 'exempt';
        if (p!.st.hibernate !== 0) {
          ctx.emit('CARD_NO_EFFECT', { seat: f.seat, card: CARD.SLEEPWALK });
          f.stage = 'done';
        }
        return;
      case 'exempt':
        f.stage = 'scapegoat';
        if (holdsCard(p!, CARD.PARDON)) {
          consumePassive(ctx, target, CARD.PARDON, 'sleepwalk', null);
          f.stage = 'done';
        }
        return;
      case 'scapegoat':
        if (f.data.scapegoated === true) {
          f.stage = 'apply';
          return;
        }
        if (!askScapegoat(ctx, f, target, 'sleepwalk', null, Number(f.data.days), scapegoatCandidates(ctx.s, target))) {
          f.stage = 'apply';
        }
        return;
      case 'apply': {
        f.stage = 'revenge';
        stowVehicle(ctx, target);
        setActorStatus(ctx, { t: 'seat', seat: target }, 'sleepwalk', Number(f.data.days));
        return;
      }
      case 'revenge': {
        f.stage = 'done';
        if (f.data.scapegoated === true || target !== f.data.orig || !holdsCard(p!, CARD.REVENGE)) return;
        const user = ctx.s.players.find((x) => x.seat === f.seat);
        if (!user?.alive) return;
        consumePassive(ctx, target, CARD.REVENGE, 'sleepwalk', f.seat);
        stowVehicle(ctx, f.seat);
        setActorStatus(ctx, { t: 'seat', seat: f.seat }, 'sleepwalk', CMB.REVENGE_DAYS);
        return;
      }
      default:
        ctx.pop(f);
        return;
    }
  },
  resume(ctx: Ctx, f: CardFrame, a: PlayerAction, kind: string, options: unknown): void {
    if (f.stage !== 'scapegoat' || kind !== 'SCAPEGOAT') {
      throw new EngineInvariantError('CARD_RESUME', `sleepwalk ${f.stage}/${kind}`);
    }
    const target = targetOf(f);
    const t = resolveScapegoat(ctx, target, a, (options as ScapegoatOptions).candidates, 'sleepwalk');
    f.stage = 'apply';
    if (t === null) return;
    f.data = {
      target: t,
      orig: f.data.orig ?? target,
      days: t === f.seat ? CMB.SLEEPWALK_SELF_DAYS : CMB.SLEEPWALK_DAYS,
      scapegoated: true,
    };
  },
};
