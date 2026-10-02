/**
 * 测试与脚本里给 AI 喂数据用的简易投影（公开手牌模式）：
 * 结构上等同于 view/project 的 projectState(s, viewer, {handVisibility:'public'})，
 * 但引擎不能依赖 view（architecture §3），所以这里只按结构构造，不引用 view 的类型。
 * 服务器正式路径用 M2 的 view/project.ts。
 */
import { publicWorld } from '../core/postPatch';
import type { PendingDecision } from '../types/decision';
import type { PlayerState, PublicWorld } from '../types/state';

export type SimpleView = Omit<PublicWorld, 'players'> & {
  players: (PlayerState & { cardCount: number; itemCount: number })[];
};

export function simpleView(s: PublicWorld): SimpleView {
  const w = publicWorld(s);
  return {
    ...structuredClone(w),
    players: structuredClone(w.players).map((p) => ({
      ...p,
      cardCount: p.cards.length,
      itemCount: p.items.reduce((a, b) => a + b, 0),
    })),
  };
}

/** PendingDecision → DecisionForYou 的结构（deadlineAt 为 null，不带小游戏票据） */
export function decisionForSeat(d: PendingDecision) {
  return {
    decisionId: d.id,
    seat: d.seat,
    kind: d.kind,
    timing: d.timing,
    options: d.options,
    defaultIntent: d.defaultIntent,
    deadlineAt: null,
  };
}
