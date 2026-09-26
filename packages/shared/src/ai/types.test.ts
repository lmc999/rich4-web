import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DecisionKind, PlayerIntent } from '../engine/types/index';
import type { DecisionForYou, GameView } from '../view/types';
import {
  AI_PRESET_PERSONALITY,
  type AiContext,
  type AiHandler,
  type AiHandlers,
  type AiPolicy,
  type AiTraits,
  applyTrusteeSettings,
  isValidTrusteeSettings,
  type TrusteeSettings,
  trusteeSettingsOf,
} from './types';

const traits: AiTraits = {
  personality: 1,
  useCards: true,
  useItems: true,
  loanRatio: 50,
  cashRatio: 40,
  stockRatio: 25,
};

describe('AI 契约', () => {
  it('托管设置与特质互转，借贷比例保留', () => {
    const t: TrusteeSettings = { personality: 2, useCards: false, useItems: true, cashRatio: 70, stockRatio: 0 };
    expect(isValidTrusteeSettings(t)).toBe(true);
    expect(isValidTrusteeSettings({ ...t, cashRatio: 75 })).toBe(false);
    expect(applyTrusteeSettings(traits, t)).toEqual({
      personality: 2,
      useCards: false,
      useItems: true,
      loanRatio: 50,
      cashRatio: 70,
      stockRatio: 0,
    });
    expect(trusteeSettingsOf(traits)).toEqual({
      personality: 1,
      useCards: true,
      useItems: true,
      cashRatio: 40,
      stockRatio: 25,
    });
  });

  it('预设只覆盖 personality', () => {
    expect(AI_PRESET_PERSONALITY).toEqual({ character: null, gentle: 0, normal: 1, cunning: 2 });
  });

  it('HANDLERS 可以用 satisfies AiHandlers 对 23 种 kind 穷举', () => {
    expectTypeOf<keyof AiHandlers>().toEqualTypeOf<DecisionKind>();
    expectTypeOf<Parameters<AiHandler<'BUY_LAND'>>[1]>().toEqualTypeOf<DecisionForYou<'BUY_LAND'>>();
    expectTypeOf<AiPolicy['decide']>().toEqualTypeOf<
      (view: GameView, d: DecisionForYou, ctx: AiContext) => PlayerIntent
    >();
  });
});
