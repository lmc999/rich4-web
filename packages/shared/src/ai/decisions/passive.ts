/**
 * 被动卡与保释（design/minigames-ai.md §9.7；docs/research/r_cards.md §5；g_villains.md §1、§6）：
 * - USE_FREE_CARD：金额 > 现金，或金额 > (rng%3000+3000)·PI → 用
 * - SCAPEGOAT：过路费、设施费、罚款：金额 > (rng%4000+4000)·PI 才用；查税：自己现金 ≥ 20000·PI 才用；
 *   陷害、梦游、关押：一律用。目标 = 候选中最恨的人（严格大于才替换，全为 0 则没有），否则 rng 随机
 * - BAIL（@0x43d3d8 / 0x43ea9a）：先 rng.bit()==0 → 不理会；候选按个性：0 只保释玩家；1 保释玩家，另外 rng%3==0 时
 *   把可雇的恶人也加入；2 只雇恶人。目标 = 候选[rng%n]。保释玩家要求点券 > 30；雇恶人要求点券 ≥ 700（实际收 300）
 */
import type { PlayerIntent, SeatIndex, VillainKind } from '../../engine/types/index';
import type { DecisionForYou } from '../../view/types';
import { BAIL_MIN_POINTS, FREE_CARD_BASE, HIRE_MIN_POINTS, SCAPEGOAT_BASE, SCAPEGOAT_TAX_CASH } from '../constants';
import type { AiContext } from '../types';
import type { AiView } from '../view';

export function freeCard(v: AiView, d: DecisionForYou<'USE_FREE_CARD'>, ctx: AiContext): PlayerIntent {
  const amount = d.options.amount;
  const threshold = (ctx.rng.mod(FREE_CARD_BASE) + FREE_CARD_BASE) * v.pi;
  return amount > v.me.cash || amount > threshold ? { type: 'CONFIRM' } : { type: 'DECLINE' };
}

/** 候选中最恨的人（first-wins，严格大于才替换）；全为 0 返回 null */
function mostHatedAmong(v: AiView, cands: readonly SeatIndex[]): SeatIndex | null {
  let best: SeatIndex | null = null;
  let max = 0;
  for (const s of cands) {
    const h = v.me.hostility[s] ?? 0;
    if (h > max) {
      max = h;
      best = s;
    }
  }
  return best;
}

export function scapegoat(v: AiView, d: DecisionForYou<'SCAPEGOAT'>, ctx: AiContext): PlayerIntent {
  const o = d.options;
  if (o.candidates.length === 0) return { type: 'DECLINE' };
  let use: boolean;
  switch (o.context) {
    case 'frame':
    case 'sleepwalk':
    case 'confine':
      use = true;
      break;
    case 'taxAudit':
      use = v.me.cash >= SCAPEGOAT_TAX_CASH * v.pi;
      break;
    default:
      use = (o.amount ?? 0) > (ctx.rng.mod(SCAPEGOAT_BASE) + SCAPEGOAT_BASE) * v.pi;
  }
  if (!use) return { type: 'DECLINE' };
  const target = mostHatedAmong(v, o.candidates) ?? o.candidates[ctx.rng.mod(o.candidates.length)]!;
  return { type: 'SCAPEGOAT', target };
}

type BailPick = { k: 'seat'; seat: SeatIndex } | { k: 'villain'; kind: VillainKind };

export function bail(v: AiView, d: DecisionForYou<'BAIL'>, ctx: AiContext): PlayerIntent {
  const o = d.options;
  if (ctx.rng.bit() === 0) return { type: 'SKIP' };
  const players: BailPick[] = o.inmates.map((i) => ({ k: 'seat', seat: i.seat }));
  const villains: BailPick[] = o.villains.filter((x) => x.available).map((x) => ({ k: 'villain', kind: x.kind }));
  let cands: BailPick[];
  switch (ctx.traits.personality) {
    case 0:
      cands = players;
      break;
    case 1:
      cands = ctx.rng.mod(3) === 0 ? [...players, ...villains] : players;
      break;
    default:
      cands = villains;
  }
  if (cands.length === 0) return { type: 'SKIP' };
  const pick = cands[ctx.rng.mod(cands.length)]!;
  const points = v.me.points;
  if (pick.k === 'seat') return points > BAIL_MIN_POINTS ? { type: 'BAIL', target: pick.seat } : { type: 'SKIP' };
  return points >= HIRE_MIN_POINTS ? { type: 'HIRE', villain: pick.kind } : { type: 'SKIP' };
}
