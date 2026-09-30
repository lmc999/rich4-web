/**
 * 现金类卡片（design/engine.md §10.2；docs/research/r_cards.md §1、§5、§6、§10）。
 *
 * 1  均富  所有在场玩家现金相加后平均（向零取整），每人现金设为平均值（存款不动；余数销毁）；
 *          现金高于平均者对出卡者敌意 +(现金 − 平均)/100
 * 2  均贫  范围内一名对手：两人现金相加 /2（向零取整）；对手吃亏时敌意 +(现金 − 平均)/100
 * 13 抢夺  范围内一名对手 + 指定 1 张卡或 1 个道具（背包里的，含研究所道具；装备中的交通工具不算）：
 *          抢卡：满手按 rules.handFull；抢道具：自己已有 9 个（交通工具 10 个）则该道具回库存（研究所道具消失）；
 *          敌意 + 所抢物品的标价
 * 26 查税  范围内一名对手：税额 = trunc(现金 / 5)，敌意 + 税额/100 → CARD 帧查税链：
 *          free（对手持免费卡、税额 ≥ 2000×PI → USE_FREE_CARD）→ scapegoat（持嫁祸卡 → SCAPEGOAT，候选可含出卡者；
 *          转移后按新目标现金重算，嫁祸回出卡者则不收）→ pay（从最终目标转入出卡者的存款）
 */
import { cardDef } from '../../../data/tables/cards';
import { CMB } from '../../../data/tables/combat';
import { ITEM_IDS, isPoolItem } from '../../../data/tables/ids';
import { itemDef } from '../../../data/tables/items';
import { divTrunc } from '../../../util/int32';
import type { Ctx } from '../../core/ctx';
import { opponentsInRange } from '../../decisions/targets';
import { EngineInvariantError } from '../../errors';
import {
  askFreeCard,
  askScapegoat,
  passiveThreshold,
  resolveFreeCard,
  resolveScapegoat,
  scapegoatCandidates,
} from '../../flow/passive';
import { ITEM_MAX } from '../../rules/inventory';
import type { RobVictim, ScapegoatOptions } from '../../types/decision';
import type { FrameOf } from '../../types/frames';
import type { CardId, ItemId, SeatIndex } from '../../types/ids';
import type { PlayerAction } from '../../types/intent';
import { addHostility, gainCard } from '../common';
import type { CardEffect } from '../types';
import { usable, usableIf } from '../types';

type CardFrame = FrameOf<'CARD'>;

/** 直接改写现金并记入台账（均富、均贫：总额减少的余数视为销毁） */
function setCash(ctx: Ctx, seat: SeatIndex, cash: number): number {
  const p = ctx.player(seat);
  const delta = cash - p.cash;
  p.cash = cash;
  if (delta > 0) ctx.s.econ.ledger.minted += delta;
  else if (delta < 0) ctx.s.econ.ledger.burned += -delta;
  return delta;
}

function equalize(ctx: Ctx, by: SeatIndex, seats: readonly SeatIndex[]): void {
  let sum = 0;
  for (const seat of seats) sum += ctx.player(seat).cash;
  const avg = divTrunc(sum, seats.length, ctx.s.config.rules.intOverflow);
  for (const seat of seats) {
    const p = ctx.player(seat);
    const before = p.cash;
    if (before > avg) addHostility(ctx, seat, by, divTrunc(before - avg, CMB.HATE_CASH_DIV));
    const delta = setCash(ctx, seat, avg);
    if (delta === 0) continue;
    const who = { t: 'seat', seat } as const;
    const amount = delta < 0 ? -delta : delta;
    ctx.emit('MONEY', {
      from: delta < 0 ? who : { t: 'bank' },
      to: delta < 0 ? { t: 'bank' } : who,
      amount,
      paid: amount,
      reason: 'equalize',
      ref: null,
    });
  }
}

export const equalWealth: CardEffect = {
  menu: () => usable({ t: 'none' }),
  apply(ctx, seat) {
    equalize(
      ctx,
      seat,
      ctx.s.players.filter((p) => p.alive).map((p) => p.seat),
    );
  },
};

export const equalPoverty: CardEffect = {
  menu(s, em, seat) {
    const seats = opponentsInRange(s, em, seat);
    return usableIf({ t: 'seat', seats }, seats.length === 0);
  },
  apply(ctx, seat, t) {
    if (t.t !== 'seat') return;
    equalize(ctx, seat, [seat, t.seat]);
  },
};

// ───────────────────────── 抢夺 ─────────────────────────

/** 抢夺卡的候选：范围内每个对手的手牌与背包道具（有东西可抢的才列出） */
export function robVictims(ctx: { s: Ctx['s']; em: Ctx['map'] }, seat: SeatIndex): RobVictim[] {
  const out: RobVictim[] = [];
  for (const o of opponentsInRange(ctx.s, ctx.em, seat)) {
    const p = ctx.s.players.find((x) => x.seat === o)!;
    const cards = p.cards.map((card, slot) => ({ slot, card }));
    const items = ITEM_IDS.filter((it) => (p.items[it] ?? 0) > 0).map((item) => ({ item, count: p.items[item]! }));
    if (cards.length > 0 || items.length > 0) out.push({ seat: o, cards, items });
  }
  return out;
}

export const rob: CardEffect = {
  menu(s, em, seat) {
    const victims = robVictims({ s, em }, seat);
    return usableIf({ t: 'rob', victims }, victims.length === 0);
  },
  apply(ctx, seat, t) {
    if (t.t !== 'rob') return;
    const victim = ctx.player(t.seat);
    const me = ctx.player(seat);
    if (t.take.k === 'card') {
      const card = victim.cards[t.take.slot] as CardId;
      addHostility(ctx, t.seat, seat, cardDef(card).price);
      victim.cards.splice(t.take.slot, 1);
      ctx.emit('CARD_LOST', { seat: t.seat, card, cause: 'robbed' });
      gainCard(ctx, seat, card, 'rob');
      return;
    }
    const item: ItemId = t.take.item;
    addHostility(ctx, t.seat, seat, itemDef(item).price);
    victim.items[item] = (victim.items[item] ?? 0) - 1;
    // 抢道具属于一般得道具途径（receive_tool ≥9 不给），机车 / 汽车也按 9 封顶；第 10 台只出现在换车退回背包
    const keep = (me.items[item] ?? 0) < ITEM_MAX;
    // 自己已满：被抢的道具回库存（研究所道具直接消失）
    if (!keep && isPoolItem(item)) ctx.s.pools.items[item] = (ctx.s.pools.items[item] ?? 0) + 1;
    ctx.emit('ITEM_LOST', { seat: t.seat, item, qty: 1, cause: 'robbed' });
    if (keep) {
      me.items[item] = (me.items[item] ?? 0) + 1;
      ctx.emit('ITEM_GAINED', { seat, item, qty: 1, source: 'rob' });
    }
  },
};

// ───────────────────────── 查税 ─────────────────────────

function taxOf(ctx: Ctx, seat: SeatIndex): number {
  const cash = ctx.player(seat).cash;
  return cash > 0 ? divTrunc(cash, CMB.TAX_AUDIT_DIV) : 0;
}

export const taxAudit: CardEffect = {
  menu(s, em, seat) {
    const seats = opponentsInRange(s, em, seat);
    return usableIf({ t: 'seat', seats }, seats.length === 0);
  },
  before(ctx, seat, t) {
    if (t.t === 'seat') addHostility(ctx, t.seat, seat, divTrunc(taxOf(ctx, t.seat), CMB.HATE_CASH_DIV));
  },
  apply(ctx, seat, t) {
    if (t.t !== 'seat') return;
    const amount = taxOf(ctx, t.seat);
    ctx.push({ k: 'CARD', seat, card: 26, target: t, stage: 'free', data: { target: t.seat, amount } });
  },
};

function targetOf(f: CardFrame): SeatIndex {
  const v = f.data.target;
  if (typeof v !== 'number') throw new EngineInvariantError('CARD_DATA', 'tax audit without target');
  return v as SeatIndex;
}

/** CARD 帧的查税链（card 26） */
export const taxChain = {
  step(ctx: Ctx, f: CardFrame): void {
    const target = targetOf(f);
    const amount = Number(f.data.amount ?? 0);
    const p = ctx.s.players.find((x) => x.seat === target);
    switch (f.stage) {
      case 'free':
        if (!p?.alive || amount <= 0 || !askFreeCard(ctx, f, target, 'taxAudit', amount, null)) f.stage = 'scapegoat';
        return;
      case 'scapegoat': {
        const cands = scapegoatCandidates(ctx.s, target);
        const asked =
          p?.alive === true &&
          passiveThreshold(ctx.s, p, amount) &&
          askScapegoat(ctx, f, target, 'taxAudit', amount, null, cands);
        if (!asked) f.stage = 'pay';
        return;
      }
      case 'pay': {
        f.stage = 'done';
        if (!p?.alive || amount <= 0 || target === f.seat) return;
        const from = { t: 'seat', seat: target } as const;
        const to = { t: 'seat', seat: f.seat } as const;
        const r = ctx.pay(from, to, amount, {
          reason: 'taxAudit',
          credit: 'deposit',
          accident: true,
          cause: { k: 'card', ref: 26, by: f.seat },
        });
        ctx.emit('MONEY', { from, to, amount, paid: r.paid, reason: 'taxAudit', ref: null });
        return;
      }
      default:
        ctx.pop(f);
        return;
    }
  },
  resume(ctx: Ctx, f: CardFrame, a: PlayerAction, kind: string, options: unknown): void {
    const target = targetOf(f);
    if (f.stage === 'free' && kind === 'USE_FREE_CARD') {
      f.stage = resolveFreeCard(ctx, target, a, 'taxAudit', f.seat) ? 'done' : 'scapegoat';
      return;
    }
    if (f.stage === 'scapegoat' && kind === 'SCAPEGOAT') {
      const t = resolveScapegoat(ctx, target, a, (options as ScapegoatOptions).candidates, 'taxAudit');
      f.stage = 'pay';
      if (t === null) return;
      // 转给新目标：按他的现金重算；嫁祸回出卡者本人则不收
      f.data = { target: t, amount: t === f.seat ? 0 : taxOf(ctx, t) };
      return;
    }
    throw new EngineInvariantError('CARD_RESUME', `tax ${f.stage}/${kind}`);
  },
};
