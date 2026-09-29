// 回合菜单的骰子颗数（原版皮肤 GO 钮竖槽 / D 键、程序化行动区的颗数按钮共用）：选择的作用域见 uiStore 的 DiceChoiceScope
// ——本座位本回合、交通工具没换时一直有效（回合菜单里用卡、用道具、买卖股票后引擎换 decisionId 重发 TURN_MENU 也不丢），
// 与原版把颗数立刻写进玩家结构 +0x0A、只在换车时改写一致。
import type { DiceCount } from '@rich4/shared/engine';
import type { YourDecisionOf } from '@rich4/shared/net';
import { useCallback, useEffect, useMemo } from 'react';
import { useGameStore } from '../../store/gameStore';
import { chosenDice, type DiceChoiceScope, sameDiceScope, useUiStore } from '../../store/uiStore';

export interface DiceChoice {
  /** 这次按下 GO / 掷骰要掷的颗数 */
  chosen: DiceCount;
  /** 当前 TURN_MENU 的作用域（不是本人的 TURN_MENU 时为 null） */
  scope: DiceChoiceScope | null;
  /** 选颗数（不在允许的颗数里时不变） */
  pick(n: DiceCount): void;
}

/** turn：本人的 TURN_MENU（其余为 null） */
export function useDiceChoice(turn: YourDecisionOf<'TURN_MENU'> | null): DiceChoice {
  const turnNo = useGameStore((s) => s.view?.clock.turnNo ?? null);
  const diceChoice = useUiStore((s) => s.diceChoice);
  const stored = useUiStore((s) => s.diceChoiceScope);
  const dice = turn?.options.dice;
  const seat = turn?.seat ?? null;
  const cap = dice ? dice.allowed.length : null;
  const current = dice?.current ?? null;
  // 按字段记忆：引擎重发的 TURN_MENU 是新对象，作用域相同时引用不变
  const scope = useMemo<DiceChoiceScope | null>(
    () =>
      seat === null || cap === null || current === null || turnNo === null ? null : { seat, turnNo, cap, current },
    [seat, turnNo, cap, current],
  );
  // 看到作用域不同的 TURN_MENU（换了回合、换了车）就清掉旧的选择：同一回合里换车再换回原来的车（上限与 current 又和选择时
  // 相同）时，原版的 +0x0A 已被换车改写为上限，旧的选择不能复活。渲染时 chosenDice 也只认同一作用域，清掉之前不会闪一下
  useEffect(() => {
    if (scope === null) return;
    const s = useUiStore.getState();
    if (s.diceChoice !== null && !sameDiceScope(s.diceChoiceScope, scope)) s.setDiceChoice(null);
  }, [scope]);
  const allowed = dice?.allowed;
  const pick = useCallback(
    (n: DiceCount) => {
      if (scope === null || !allowed?.includes(n)) return;
      useUiStore.getState().setDiceChoice(n, scope);
    },
    [scope, allowed],
  );
  const chosen = chosenDice({ diceChoice, diceChoiceScope: stored }, scope, allowed ?? [], dice?.current);
  return { chosen, scope, pick };
}
