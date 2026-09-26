import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CardId, DecisionKind, PendingDecision } from '../engine/types/index';
import {
  type AnyDecisionForYou,
  asAnyDecision,
  type DecisionForYou,
  type GameView,
  isAutopilot,
  isDecisionForYouOf,
  type PendingView,
  type PlayerView,
  SEAT_CONTROLS,
  type SeatControl,
} from './types';

/** 服务器按 PendingDecision 构造下发结构（M2 的写法示例，确保类型可直接组装） */
function toForYou<K extends DecisionKind>(d: PendingDecision<K>, deadlineAt: number | null): DecisionForYou<K> {
  return {
    decisionId: d.id,
    seat: d.seat,
    kind: d.kind,
    timing: d.timing,
    options: d.options,
    defaultIntent: d.defaultIntent,
    deadlineAt,
  };
}

function toPendingView<K extends DecisionKind>(d: PendingDecision<K>, control: SeatControl): PendingView<K> {
  return {
    decisionId: d.id,
    seat: d.seat,
    kind: d.kind,
    timing: d.timing,
    deadlineAt: null,
    control,
    publicInfo: d.publicInfo,
  };
}

describe('视图类型', () => {
  it('PlayerView 的 cards 可为 null，且带 cardCount', () => {
    expectTypeOf<PlayerView['cards']>().toEqualTypeOf<CardId[] | null>();
    expectTypeOf<PlayerView['cardCount']>().toEqualTypeOf<number>();
    expectTypeOf<GameView>().not.toHaveProperty('secret');
    expectTypeOf<GameView>().not.toHaveProperty('pending');
    expectTypeOf<GameView>().toHaveProperty('dataRef');
  });

  it('PendingDecision 可直接组装为 DecisionForYou / PendingView', () => {
    expectTypeOf(toForYou<'BUY_LAND'>).returns.toEqualTypeOf<DecisionForYou<'BUY_LAND'>>();
    expectTypeOf(toPendingView<'MINIGAME'>).returns.toEqualTypeOf<PendingView<'MINIGAME'>>();
    expectTypeOf<DecisionForYou<'BUY_LAND'>>().toExtend<AnyDecisionForYou>();
  });

  it('按 kind 收窄 options', () => {
    const viaUnion = (d: DecisionForYou): number => {
      const a = asAnyDecision(d);
      return a.kind === 'LOTTERY' ? a.options.price : 0;
    };
    const viaGuard = (d: DecisionForYou): number => (isDecisionForYouOf(d, 'SHOP') ? d.options.points : 0);
    const d = {
      decisionId: 'd9',
      seat: 0,
      kind: 'LOTTERY',
      timing: 'lottery',
      options: { cash: 5000, price: 1000, sold: [], pool: 0 },
      defaultIntent: { type: 'SKIP' },
      deadlineAt: null,
    } satisfies DecisionForYou<'LOTTERY'>;
    expect(viaUnion(d)).toBe(1000);
    expect(viaGuard(d)).toBe(0);
  });

  it('托管状态', () => {
    expect(SEAT_CONTROLS).toHaveLength(6);
    expect(isAutopilot('autopilot:afk')).toBe(true);
    expect(isAutopilot('human')).toBe(false);
  });
});
