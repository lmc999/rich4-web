/**
 * TURN_MENU：原版 AI 掷骰前的步骤（design/minigames-ai.md §8.1、§9.4）。
 * 步骤：① 买股票 → ② 卖股票 → ③ 公布栏挂牌 → ④ 公布栏购买 → ⑤ 硬币：用卡或用道具 → ⑥ 骰子颗数并掷骰。
 * 每做完一个非终结操作引擎会重发 TURN_MENU，AI 按 options.turnLog 推算已经做到哪一步（只有有还款压力时卖股票可以重复）。
 * M4 覆盖 ①②⑥；③④（公布栏，M7）与 ⑤（卡片、道具，M6）暂时跳过。
 */
import type { PlayerIntent, TurnLogEntry, TurnMenuOptions } from '../../engine/types/index';
import type { DecisionForYou } from '../../view/types';
import { DICE_BOMB_FUSE, DICE_LOOKAHEAD, REPAY_DAYS } from '../constants';
import { planStockBuy, planStockSell } from '../stock';
import type { AiContext } from '../types';
import type { AiView } from '../view';

type Step = 'stockBuy' | 'stockSell' | 'boardList' | 'boardBuy' | 'cardOrItem';
const STEPS: readonly Step[] = ['stockBuy', 'stockSell', 'boardList', 'boardBuy', 'cardOrItem'];

function stepIndexOf(e: TurnLogEntry): number {
  switch (e) {
    case 'stockBuy':
      return 0;
    case 'stockSell':
      return 1;
    case 'boardList':
      return 2;
    case 'boardBuy':
      return 3;
    default:
      return 4;
  }
}

/** 卖股票可以重复的条件：到期 ≤ 6 天且 现金 + 存款 < 1.1 × 贷款 */
function sellMayRepeat(v: AiView): boolean {
  const me = v.me;
  if (me.loan <= 0) return false;
  const left = v.daysUntil(me.loanDue);
  return left !== null && left <= REPAY_DAYS && (me.cash + me.deposit) * 10 < me.loan * 11;
}

function runStep(step: Step, v: AiView, o: TurnMenuOptions, ctx: AiContext): PlayerIntent | null {
  switch (step) {
    case 'stockBuy': {
      const b = planStockBuy(v, o, ctx);
      return b ? { type: 'STOCK_BUY', stock: b.stock, shares: b.shares } : null;
    }
    case 'stockSell': {
      const s = planStockSell(v, o, ctx);
      return s ? { type: 'STOCK_SELL', stock: s.stock, shares: s.shares } : null;
    }
    default:
      // TODO(M7)：公布栏挂牌与购买；TODO(M6)：硬币 rand&1 二选一，用卡或用道具（个性闸门 + 判定函数）
      return null;
  }
}

/**
 * 骰子颗数（@0x4221c0）：步行或受限 → 当前颗数；汽车默认 3、机车默认 2；身背炸弹引信 < 15 → 1；
 * 否则前瞻 5 格：safe = 无主或自己的地产格数，hostile = 别人的地产格数；
 *   safe == 0 且 hostile > 2 → 汽车 2 + rng.bit()、机车 2；safe ≥ 2 且 hostile ≤ 1 → 1
 */
export function dicePolicy(v: AiView, o: TurnMenuOptions, ctx: AiContext): 1 | 2 | 3 | undefined {
  const d = o.dice;
  if (d.locked !== null) return undefined;
  const max = d.allowed[d.allowed.length - 1] ?? 1;
  if (max <= 1) return undefined;
  const me = v.me;
  if (me.bomb !== null && me.bomb.fuse < DICE_BOMB_FUSE) return 1;
  let dice: 1 | 2 | 3 = me.vehicle === 'car' ? 3 : 2;
  const rng = ctx.turnRng('dice');
  const ahead = v.lookahead(DICE_LOOKAHEAD, rng);
  let safe = 0;
  let hostile = 0;
  for (const node of ahead.nodes) {
    const lot = v.map.tile(node).ref?.lot;
    if (lot === undefined) continue;
    const owner = v.ownerOfLot(lot);
    if (owner === undefined) continue;
    if (owner === null || owner === v.seat) safe++;
    else hostile++;
  }
  if (safe === 0 && hostile > 2) dice = me.vehicle === 'car' ? ((2 + rng.bit()) as 2 | 3) : 2;
  else if (safe >= 2 && hostile <= 1) dice = 1;
  return d.allowed.includes(dice) ? dice : undefined;
}

export function turnMenu(v: AiView, d: DecisionForYou<'TURN_MENU'>, ctx: AiContext): PlayerIntent {
  const o = d.options;
  if (o.menuActions.used < o.menuActions.limit) {
    const log = o.turnLog;
    let cur = 0;
    if (log.length > 0) {
      const last = log[log.length - 1]!;
      const idx = stepIndexOf(last);
      cur = last === 'stockSell' && sellMayRepeat(v) ? idx : idx + 1;
    }
    for (let i = cur; i < STEPS.length; i++) {
      const intent = runStep(STEPS[i]!, v, o, ctx);
      if (intent) return intent;
    }
  }
  const dice = dicePolicy(v, o, ctx);
  return dice === undefined ? { type: 'ROLL' } : { type: 'ROLL', dice };
}
