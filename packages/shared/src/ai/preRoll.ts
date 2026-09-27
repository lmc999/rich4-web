/**
 * 掷骰前的「用卡或用道具」一步（design/minigames-ai.md §8.1 ④、§8.2、§9.4 cardOrTool；@0x418e18）。
 *
 * 硬币 turnRng('coin').bit()：1 只考虑用卡，0 只考虑用道具（二者互斥，每回合最多 1 件；消耗一次随机数）。
 * 用卡：traits.useCards 为 false 不用；手牌 N > 8 张时从 rng%N 起环形取 8 张，否则从 0 开始；
 *       跳过从不主动出的卡（换屋、转向、四张被动卡）与菜单里不可用的行；个性闸门 gate(f7) 过了再问判据（ai/cards.ts）。
 * 用道具：traits.useItems 为 false 不用；种类 > 4 时从 rng%count 起环形取 4 种（时光机不计入）；闸门 + 判据（ai/items.ts）。
 * 判据给出的目标必须落在引擎的候选里（targetMatches），否则当作不用。
 * 视野：引擎候选按 rules.targetRange / windowHalf 计算，AI 视野固定半宽 220（DEV-04、architecture §20.2）；
 * 交给判据前先用 visibleTargets 收窄到 AI 视野内（默认规则下两者相同，不改变结果）。
 */
import { cardDef } from '../data/tables/cards';
import { itemDef } from '../data/tables/items';
import { targetMatches } from '../engine/index';
import type { LotId, PlayerIntent, SeatIndex, TargetCandidates, TileId, TurnMenuOptions } from '../engine/types/index';
import { CARD_AI } from './cards';
import { AI_NEVER_PLAYS, CARD_RING, ITEM_RING } from './constants';
import { passesGate } from './gate';
import { ITEM_AI } from './items';
import type { AiContext } from './types';
import type { AiView } from './view';

/** 从 start 起环形取 n 个（总数 ≤ n 时原样返回） */
export function ring<T>(xs: readonly T[], n: number, start: () => number): T[] {
  if (xs.length <= n) return xs.slice();
  const s = start();
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[(s + i) % xs.length]!);
  return out;
}

/**
 * 把候选收窄到 AI 视野（以自己为中心、半宽 220 的方窗）：对手与恶人按所在格，地产按地块坐标，路面物件按所在格。
 * 自己、脚下地块、股票、全图落点等与视野无关的候选原样保留。
 */
export function visibleTargets(v: AiView, t: TargetCandidates): TargetCandidates {
  const seatIn = (s: SeatIndex) => s === v.seat || (v.onBoard(s) && v.tileInView(v.player(s).node));
  const lotIn = (id: LotId) => v.inView(v.map.lot(id).world);
  const nodeIn = (n: TileId) => v.tileInView(n);
  switch (t.t) {
    case 'seat':
      return { t: 'seat', seats: t.seats.filter(seatIn) };
    case 'actor':
      return {
        t: 'actor',
        actors: t.actors.filter((a) => {
          if (a.t === 'seat') return seatIn(a.seat);
          const x = v.view.villains.find((y) => y.kind === a.kind);
          return x?.onBoard === true && nodeIn(x.node);
        }),
      };
    case 'lot':
      return { t: 'lot', lots: t.lots.filter(lotIn), needType: t.needType.filter(lotIn) };
    case 'lotPair':
      return { t: 'lotPair', from: t.from, to: t.to.filter(lotIn) };
    case 'lotOrObject':
      return {
        t: 'lotOrObject',
        lots: t.lots.filter(lotIn),
        objects: t.objects.filter((id) => {
          const o = v.view.objects.find((x) => x.id === id);
          return o !== undefined && nodeIn(o.node);
        }),
      };
    case 'rob':
      return { t: 'rob', victims: t.victims.filter((x) => seatIn(x.seat)) };
    case 'node':
      return { t: 'node', nodes: t.nodes.filter(nodeIn) };
    default:
      return t;
  }
}

export function planCard(v: AiView, o: TurnMenuOptions, ctx: AiContext): PlayerIntent | null {
  if (!ctx.traits.useCards) return null;
  const rows = ring(o.cards, CARD_RING, () => ctx.turnRng('cardRing').mod(o.cards.length));
  const gate = ctx.turnRng('cardGate');
  for (const row of rows) {
    if (AI_NEVER_PLAYS.includes(row.card) || !row.usable) continue;
    if (!passesGate(cardDef(row.card).f7, ctx.traits.personality, gate)) continue;
    const seen = { ...row, targets: visibleTargets(v, row.targets) };
    const target = CARD_AI[row.card](v, seen, ctx);
    if (target !== null && targetMatches(seen.targets, target)) {
      return { type: 'USE_CARD', slot: row.slot, card: row.card, target };
    }
  }
  return null;
}

export function planItem(v: AiView, o: TurnMenuOptions, ctx: AiContext): PlayerIntent | null {
  if (!ctx.traits.useItems) return null;
  const kinds = o.items.filter((r) => r.item !== 10);
  const rows = ring(kinds, ITEM_RING, () => ctx.turnRng('itemRing').mod(kinds.length));
  const gate = ctx.turnRng('itemGate');
  for (const row of rows) {
    if (!row.usable) continue;
    if (!passesGate(itemDef(row.item).f7, ctx.traits.personality, gate)) continue;
    const seen = { ...row, targets: visibleTargets(v, row.targets) };
    const target = ITEM_AI[row.item](v, seen, ctx);
    if (target !== null && targetMatches(seen.targets, target)) return { type: 'USE_ITEM', item: row.item, target };
  }
  return null;
}

/** ④ 硬币二选一：用卡或用道具 */
export function cardOrItem(v: AiView, o: TurnMenuOptions, ctx: AiContext): PlayerIntent | null {
  return ctx.turnRng('coin').bit() === 1 ? planCard(v, o, ctx) : planItem(v, o, ctx);
}
