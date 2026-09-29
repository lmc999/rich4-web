// 骰子颗数选择的作用域 × 真实引擎（审查回归：选 1 颗后用道具 / 买股票，按 GO 仍掷 3 颗）：
// 回合菜单里的非终结操作之后引擎换 decisionId 重发 TURN_MENU，作用域（座位、回合、上限、current）不变，选择保留；
// 换车时引擎把 current 置为新上限，作用域不同；换车再换回原来的车时作用域的值又相同——所以 useDiceChoice 看到作用域不同的
// TURN_MENU 就要主动清掉选择，不能只靠 chosenDice 的比较。
import type { DiceCount, SeatIndex } from '@rich4/shared/engine';
import { decisionForSeat, scenario } from '@rich4/shared/engine-testing';
import { projectState } from '@rich4/shared/view';
import { describe, expect, it } from 'vitest';
import { chosenDice, type DiceChoiceScope, diceScopeOf, sameDiceScope } from './uiStore';

interface MenuSnap {
  id: string;
  scope: DiceChoiceScope;
  allowed: DiceCount[];
  current: DiceCount;
}

function menuOf(sc: ReturnType<typeof scenario>, seat: SeatIndex): MenuSnap {
  sc.expectAsk(seat, 'TURN_MENU');
  const d = decisionForSeat(sc.pending(seat)) as unknown as {
    decisionId: string;
    seat: SeatIndex;
    options: { dice: { allowed: DiceCount[]; current: DiceCount } };
  };
  const view = projectState(sc.state, { kind: 'seat', seat }, { handVisibility: 'public' });
  const scope = diceScopeOf(d, view.clock.turnNo);
  if (!scope) throw new Error('no scope');
  return { id: d.decisionId, scope, allowed: d.options.dice.allowed, current: d.options.dice.current };
}

describe('骰子颗数选择的作用域（真实引擎）', () => {
  it('菜单操作后重发的 TURN_MENU 作用域不变、选择保留；换车后作用域不同；换回原来的车作用域的值又相同', () => {
    const sc = scenario({ players: ['human', 'human'], map: 'test' }).untilMenu(0);
    sc.give(0, {
      items: [
        { item: 6, qty: 1 },
        { item: 5, qty: 1 },
        { item: 1, qty: 2 },
      ],
    });
    sc.useItem(0, 6);
    const car = menuOf(sc, 0);
    expect([car.allowed, car.current]).toEqual([[1, 2, 3], 3]);
    // 选 1 颗，再用一次机器娃娃（非终结）：新的 decisionId，作用域不变 → 仍掷 1 颗
    const choice = { diceChoice: 1 as DiceCount, diceChoiceScope: car.scope };
    sc.useItem(0, 1);
    const again = menuOf(sc, 0);
    expect(again.id).not.toBe(car.id);
    expect(again.current).toBe(3);
    expect(sameDiceScope(again.scope, car.scope)).toBe(true);
    expect(chosenDice(choice, again.scope, again.allowed, again.current)).toBe(1);
    // 换机车：上限 2、current 2 → 作用域不同，按新上限
    sc.useItem(0, 5);
    const moto = menuOf(sc, 0);
    expect([moto.allowed, moto.current]).toEqual([[1, 2], 2]);
    expect(sameDiceScope(moto.scope, car.scope)).toBe(false);
    expect(chosenDice(choice, moto.scope, moto.allowed, moto.current)).toBe(2);
    // 汽车退回了背包，再装备一次：作用域的值与选择时相同（useDiceChoice 已在看到机车那一次时清掉选择）
    sc.useItem(0, 6);
    const back = menuOf(sc, 0);
    expect(sameDiceScope(back.scope, car.scope)).toBe(true);
    // 掷骰：提交的颗数写回引擎，下一回合的 current 就是它；回合号不同，旧的选择不再适用
    sc.roll(0, 1);
    sc.untilMenu(0);
    const next = menuOf(sc, 0);
    expect(next.current).toBe(1);
    expect(next.scope.turnNo).not.toBe(car.scope.turnNo);
    expect(chosenDice({ diceChoice: 3, diceChoiceScope: back.scope }, next.scope, next.allowed, next.current)).toBe(1);
  });
});
