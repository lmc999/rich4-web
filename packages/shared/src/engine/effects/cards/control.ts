/**
 * 行动控制类卡片（design/engine.md §10.2；docs/research/r_cards.md §8–§9；g_arbitration.md §3.3–§3.4）。
 *
 * 6  转向  范围内任何演员（含自己、恶人）：反向——新的来路从当前前进候选里随机取（purpose 'reverse'）；死路时不变
 * 14 停留  范围内任何演员：stay = 对自己 0x80（本回合就停），对别人与恶人 1（下回合停）
 * 15 冬眠  所有对手：hibernate = 5 并清除梦游；跳过自己、已出局、不在棋盘上（受困、住旅馆、消失、未落地）的人；
 *          棋盘上的恶人也冬眠；每人敌意 150 × PI
 * 29 同盟  范围内一名对手：先解除双方各自的旧同盟，再互相绑定 7 天（两段式倒数）
 * 30 乌龟  范围内任何演员：tortoise = 对自己 2，对别人与恶人 3（每回合固定只走 1 步、不掷骰）
 */
import { CMB } from '../../../data/tables/combat';
import { ECON } from '../../../data/tables/economy';
import { actorsInRange, boardPlayers, boardVillains, opponentsInRange } from '../../decisions/targets';
import type { ActorRef, SeatIndex } from '../../types/ids';
import { addHostility, breakAlliance, setActorStatus, timesPI } from '../common';
import type { CardEffect } from '../types';
import { usable, usableIf } from '../types';

const ALL = { self: true, others: true, villains: true } as const;

function actorMenu(s: Parameters<CardEffect['menu']>[0], em: Parameters<CardEffect['menu']>[1], seat: SeatIndex) {
  const actors = actorsInRange(s, em, seat, ALL);
  return usableIf({ t: 'actor', actors }, actors.length === 0);
}

export const turnAround: CardEffect = {
  menu: actorMenu,
  apply(ctx, _seat, t) {
    if (t.t !== 'actor') return;
    const a: ActorRef = t.actor;
    const pos =
      a.t === 'seat'
        ? ctx.player(a.seat)
        : (ctx.s.villains.find((v) => v.kind === a.kind) as { node: number; prevNode: number });
    const cands = ctx.map.index.forwardCandidates(pos.node, pos.prevNode);
    if (cands.length > 0) pos.prevNode = cands[ctx.pick('reverse', cands.length)]!;
    ctx.emit('REVERSED', { actor: a });
  },
};

export const stay: CardEffect = {
  menu: actorMenu,
  apply(ctx, seat, t) {
    if (t.t !== 'actor') return;
    const self = t.actor.t === 'seat' && t.actor.seat === seat;
    setActorStatus(ctx, t.actor, 'stay', self ? CMB.STAY_SELF : CMB.STAY_OTHER);
  },
};

export const tortoise: CardEffect = {
  menu: actorMenu,
  apply(ctx, seat, t) {
    if (t.t !== 'actor') return;
    const self = t.actor.t === 'seat' && t.actor.seat === seat;
    setActorStatus(ctx, t.actor, 'tortoise', self ? CMB.TORTOISE_SELF : CMB.TORTOISE_OTHER);
  },
};

export const hibernate: CardEffect = {
  menu: () => usable({ t: 'none' }),
  apply(ctx, seat) {
    const hate = timesPI(ctx, CMB.HATE_HARM_PI);
    for (const p of boardPlayers(ctx.s)) {
      if (p.seat === seat) continue;
      addHostility(ctx, p.seat, seat, hate);
      // 取消梦游：停放的座驾不再装回（原版 0x442dcc 只把 +0x37 清 0，+0x66 留着也不会再被读到；机车 / 汽车已在背包里）
      p.st.sleepwalk = 0;
      p.parked = null;
      setActorStatus(ctx, { t: 'seat', seat: p.seat }, 'hibernate', ECON.HIBERNATE_DAYS);
    }
    for (const v of boardVillains(ctx.s)) {
      v.st.sleepwalk = 0;
      setActorStatus(ctx, { t: 'villain', kind: v.kind }, 'hibernate', ECON.HIBERNATE_DAYS);
    }
  },
};

export const alliance: CardEffect = {
  menu(s, em, seat) {
    const seats = opponentsInRange(s, em, seat);
    return usableIf({ t: 'seat', seats }, seats.length === 0);
  },
  apply(ctx, seat, t) {
    if (t.t !== 'seat') return;
    breakAlliance(ctx, seat, 'newAlliance');
    breakAlliance(ctx, t.seat, 'newAlliance');
    ctx.player(seat).alliance = { seat: t.seat, days: ECON.ALLIANCE_DAYS };
    ctx.player(t.seat).alliance = { seat, days: ECON.ALLIANCE_DAYS };
    ctx.emit('ALLIANCE_FORMED', { a: seat, b: t.seat, days: ECON.ALLIANCE_DAYS });
  },
};
