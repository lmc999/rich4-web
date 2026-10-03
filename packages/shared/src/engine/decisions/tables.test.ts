import { describe, expect, expectTypeOf, it } from 'vitest';
import { fixtureRegistry } from '../../data/maps/registry';
import { createEngine, internal } from '../api';
import { EngineInvariantError, EngineRuleError, isEngineRuleError } from '../errors';
import { DECISION_KINDS, type DecisionKind, type DecisionTimingClass } from '../types/decision';
import { INTENT_TYPES, type IntentType } from '../types/intent';
import { ENGINE_VERSION, STATE_SCHEMA_VERSION } from '../version';
import { ALLOWED_INTENTS, allowedIntents, isIntentAllowed, SYSTEM_RESOLVERS } from './allowed';
import { DECISION_TIMING_CLASS, timingOf, turnMenuBudgetKey } from './timing';

describe('ALLOWED_INTENTS', () => {
  it('对 DecisionKind 穷举，且覆盖全部 IntentType', () => {
    expectTypeOf<keyof typeof ALLOWED_INTENTS>().toEqualTypeOf<DecisionKind>();
    expectTypeOf<(typeof ALLOWED_INTENTS)[DecisionKind][number]>().toEqualTypeOf<IntentType>();
    expect(Object.keys(ALLOWED_INTENTS)).toEqual([...DECISION_KINDS]);
    const used = new Set(Object.values(ALLOWED_INTENTS).flat());
    expect([...used].sort()).toEqual([...INTENT_TYPES].sort());
  });

  it('按 architecture §5.4/§5.5 修订', () => {
    expect(ALLOWED_INTENTS.TURN_MENU).toContain('ROLL');
    expect(ALLOWED_INTENTS.TURN_MENU).not.toContain('SET_DICE');
    expect(ALLOWED_INTENTS.MINIGAME).toEqual(['MINIGAME_DECLINE']);
    expect(SYSTEM_RESOLVERS.MINIGAME).toEqual(['MINIGAME_RESULT']);
    expect(isIntentAllowed('AUCTION_BID', 'BID')).toBe(true);
    expect(isIntentAllowed('AUCTION_BID', 'CONFIRM')).toBe(false);
    expect(allowedIntents('SHOP')).toContain('LEAVE');
  });

  it('每种决策至少有一个 intent，且无重复', () => {
    for (const k of DECISION_KINDS) {
      const list = ALLOWED_INTENTS[k];
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe('DECISION_TIMING_CLASS', () => {
  it('对 DecisionKind 穷举，取值与 architecture §5.4 表一致', () => {
    expectTypeOf<keyof typeof DECISION_TIMING_CLASS>().toEqualTypeOf<DecisionKind>();
    expectTypeOf<(typeof DECISION_TIMING_CLASS)[DecisionKind]>().toExtend<DecisionTimingClass>();
    expect(Object.keys(DECISION_TIMING_CLASS)).toEqual([...DECISION_KINDS]);
    expect(timingOf('TURN_MENU')).toBe('menu');
    expect(timingOf('BANK_ATM')).toBe('bank');
    expect(timingOf('BUILD_FACILITY')).toBe('pick');
    expect(timingOf('SUBSCRIBE_SHARES')).toBe('confirm');
    expect(timingOf('AUCTION_BID')).toBe('auction');
    expect(timingOf('LOTTERY')).toBe('lottery');
    expect(timingOf('MINIGAME')).toBe('minigame');
    const classes = new Set(Object.values(DECISION_TIMING_CLASS));
    expect([...classes].sort()).toEqual(['auction', 'bank', 'confirm', 'lottery', 'menu', 'minigame', 'pick', 'shop']);
  });

  it('TURN_MENU 的 budgetKey', () => {
    expect(turnMenuBudgetKey(12, 3)).toBe('turn:12:3');
  });
});

describe('EngineApi 占位与错误类型', () => {
  it('版本号', () => {
    expect(ENGINE_VERSION).toBe('0.5.0');
    expect(STATE_SCHEMA_VERSION).toBe(1);
  });

  it('createEngine 返回完整的 EngineApi；internal 另有 applyInPlace', () => {
    const e = createEngine(fixtureRegistry);
    expect(e.ENGINE_VERSION).toBe(ENGINE_VERSION);
    expect(e.STATE_SCHEMA_VERSION).toBe(STATE_SCHEMA_VERSION);
    for (const k of [
      'createGame',
      'applyAction',
      'getPendingDecisions',
      'getResult',
      'validateState',
      'migrateState',
    ]) {
      expect(typeof (e as unknown as Record<string, unknown>)[k]).toBe('function');
    }
    expect('applyInPlace' in e).toBe(false);
    expect(typeof internal.createEngine(fixtureRegistry).applyInPlace).toBe('function');
  });

  it('EngineRuleError 带 rule', () => {
    const e = new EngineRuleError('MENU_LIMIT', 'too many actions', { used: 41 });
    expect(e.rule).toBe('MENU_LIMIT');
    expect(e.message).toBe('MENU_LIMIT: too many actions');
    expect(e.details).toEqual({ used: 41 });
    expect(isEngineRuleError(e)).toBe(true);
    expect(isEngineRuleError(new EngineInvariantError('FLOW_EMPTY'))).toBe(false);
    expect(new EngineRuleError('STALE_DECISION').message).toBe('STALE_DECISION');
  });
});
