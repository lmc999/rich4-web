import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { MinigameId as DataMinigameId } from '../../data/tables/ids';
import {
  CARD,
  CARD_IDS,
  CARD_KEYS,
  CHARACTER,
  CHARACTER_IDS,
  CHARACTER_KEYS,
  FATE_IDS,
  GOD_KEYS,
  GOD_KINDS,
  INITIAL_FUND_OPTIONS,
  ITEM_IDS,
  ITEM_KEYS,
  isPassiveCard,
  NEWS_IDS,
  researchItemOf,
} from '../../data/tables/ids';
import {
  clampStartDate,
  DEFAULT_INITIAL_FUND,
  defaultGameConfig,
  MANUAL_RULES,
  PROGRAM_RULES,
  type RuleConfig,
} from './config';
import { DECISION_KINDS, type DecisionKind, type DecisionOptionsMap, type PendingDecision } from './decision';
import {
  EVENT_META,
  GAME_EVENT_TYPES,
  type GameEvent,
  type GameEventOf,
  type GameEventPayloads,
  type GameEventType,
  isGameEventType,
  type RedactCardsEventType,
  type ResetsViewEventType,
} from './events';
import { FRAME_KINDS, type FrameKind } from './frames';
import type { CardId, SeatIndex } from './ids';
import {
  type DebugOp,
  DebugOpSchema,
  type GameAction,
  INTENT_TYPES,
  type IntentType,
  isSystemAction,
  type PlayerIntent,
  PlayerIntentSchema,
  SYSTEM_ACTION_TYPES,
} from './intent';
import type { GameState, PublicWorld } from './state';

describe('领域枚举（data/tables/ids.ts）', () => {
  it('卡片 1..30、道具 1..13、角色 0..11、神明 13 种、新闻 36、命运 37', () => {
    expect(CARD_IDS).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(ITEM_IDS).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(CHARACTER_IDS).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(GOD_KINDS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15]);
    expect(NEWS_IDS).toHaveLength(36);
    expect(FATE_IDS).toHaveLength(37);
    expect(Object.keys(CARD_KEYS).map(Number)).toEqual([...CARD_IDS]);
    expect(Object.keys(ITEM_KEYS).map(Number)).toEqual([...ITEM_IDS]);
    expect(Object.keys(CHARACTER_KEYS).map(Number)).toEqual([...CHARACTER_IDS]);
    expect(Object.keys(GOD_KEYS).map(Number)).toEqual([...GOD_KINDS]);
    expect(new Set(Object.values(CARD_KEYS)).size).toBe(30);
  });

  it('原作角色顺序与常用常量', () => {
    expect(CHARACTER.JOHN_JOE).toBe(0);
    expect(CHARACTER.ATUBO).toBe(4);
    expect(CHARACTER.JIN_BEIBEI).toBe(11);
    expect(CARD.TORTOISE).toBe(30);
    expect([18, 19, 20, 21].every((c) => isPassiveCard(c as CardId))).toBe(true);
    expect(isPassiveCard(CARD.FRAME)).toBe(false);
    expect(researchItemOf(1)).toBe(9);
    expect(researchItemOf(5)).toBe(13);
  });

  it('engine 与 data 的 MinigameId 同源', () => {
    expectTypeOf<DataMinigameId>().toEqualTypeOf<'penguin' | 'balloon' | 'xicong'>();
  });
});

describe('GameConfig / RuleConfig 默认值（architecture §7.1、g_arbitration §2.h）', () => {
  it('默认总资金 200000，溢出饱和，时光机 global', () => {
    expect(DEFAULT_INITIAL_FUND).toBe(200000);
    expect(INITIAL_FUND_OPTIONS).toContain(DEFAULT_INITIAL_FUND);
    const c = defaultGameConfig('test', 20260927);
    expect(c).toMatchObject({
      mapId: 'test',
      initialFund: 200000,
      vehicle: 'walk',
      tenure: 'unlimited',
      timeLimitDays: 0,
      winMultiple: 0,
      startDate: 20260927,
      minigames: 'play',
      debug: false,
    });
    expect(c.rules).toEqual(PROGRAM_RULES);
    expect(c.rules).not.toBe(PROGRAM_RULES);
    expect(PROGRAM_RULES.intOverflow).toBe('saturate');
    expect(PROGRAM_RULES.timeMachine).toBe('global');
    expect(PROGRAM_RULES.targetRange).toBe('window');
    expect(PROGRAM_RULES.windowHalf).toBe(220);
    expect(PROGRAM_RULES.endWhenNoHumans).toBe(true);
  });

  it('MANUAL 只在 §7.1 列出的开关上不同，联机适配项相同', () => {
    const keys = Object.keys(PROGRAM_RULES) as (keyof RuleConfig)[];
    const diff = keys.filter((k) => PROGRAM_RULES[k] !== MANUAL_RULES[k]).sort();
    expect(diff).toEqual(
      [
        'preset',
        'redBlack',
        'fortuneGodLand',
        'smallPoorToll',
        'engineeringVehicle',
        'bombBlast',
        'sundayBankClosed',
        'handFull',
        'blessingOnNews',
        'deathGodDispellable',
        'freeCardOnFines',
        'stockSuspendDays',
        'constructionChairmanLevels',
      ].sort(),
    );
    expect(Object.isFrozen(PROGRAM_RULES)).toBe(true);
  });

  it('startDate 夹到 1998-01-01..2010-01-01', () => {
    expect(clampStartDate(19970101)).toBe(19980101);
    expect(clampStartDate(20260927)).toBe(20100101);
    expect(clampStartDate(20050505)).toBe(20050505);
    expect(clampStartDate(Number.NaN)).toBe(19980101);
  });
});

describe('DecisionKind 与帧', () => {
  it('23 种 DecisionKind，唯一', () => {
    expect(DECISION_KINDS).toHaveLength(23);
    expect(new Set(DECISION_KINDS).size).toBe(23);
    expectTypeOf<(typeof DECISION_KINDS)['length']>().toEqualTypeOf<23>();
    expectTypeOf<keyof DecisionOptionsMap>().toEqualTypeOf<DecisionKind>();
  });

  it('FRAME_KINDS 对 Frame 穷举', () => {
    expectTypeOf<(typeof FRAME_KINDS)[number]>().toEqualTypeOf<FrameKind>();
    expect(new Set(FRAME_KINDS).size).toBe(FRAME_KINDS.length);
  });

  it('PendingDecision<K> 的 options 随 kind 收窄', () => {
    expectTypeOf<PendingDecision<'BUY_LAND'>['options']>().toEqualTypeOf<DecisionOptionsMap['BUY_LAND']>();
    expectTypeOf<PendingDecision<'BUY_LAND'>>().toExtend<PendingDecision>();
  });
});

describe('PlayerIntent 与 PlayerIntentSchema', () => {
  it('zod 推导类型与手写类型完全一致', () => {
    expectTypeOf<z.infer<typeof PlayerIntentSchema>>().toEqualTypeOf<PlayerIntent>();
    expectTypeOf<z.infer<typeof DebugOpSchema>>().toEqualTypeOf<DebugOp>();
    expectTypeOf<(typeof INTENT_TYPES)[number]>().toEqualTypeOf<IntentType>();
  });

  it('INTENT_TYPES 与 schema 的选项一一对应', () => {
    const schemaTypes = PlayerIntentSchema.options.map((o) => o.shape.type.value);
    expect([...schemaTypes].sort()).toEqual([...INTENT_TYPES].sort());
    expect(INTENT_TYPES).toHaveLength(38);
  });

  it('接受合法 intent', () => {
    const ok: PlayerIntent[] = [
      { type: 'ROLL' },
      { type: 'ROLL', dice: 3 },
      { type: 'USE_CARD', slot: 0, card: 13, target: { t: 'rob', seat: 2, take: { k: 'card', slot: 4 } } },
      { type: 'USE_CARD', slot: 1, card: 9, target: { t: 'lot', lot: 'F1', facility: 'hotel' } },
      { type: 'USE_ITEM', item: 8, target: { t: 'dice', value: 6 } },
      {
        type: 'USE_ITEM',
        item: 11,
        target: {
          t: 'teleport',
          source: { k: 'actor', actor: { t: 'villain', kind: 'spy' } },
          dest: { k: 'road', node: 7 },
        },
      },
      { type: 'STOCK_BUY', stock: 3, shares: 100 },
      { type: 'BOARD_LIST', asset: { t: 'item', item: 2, qty: 1 }, price: 3000 },
      { type: 'ATM', op: 'withdraw', amount: 0 },
      { type: 'LOTTERY_BUY', number: 35 },
      { type: 'HIRE', villain: 'thief' },
      { type: 'MAGIC_CAST', effect: 11 },
      { type: 'PICK_LOT', lot: 'L12' },
      { type: 'BID', inc: 0 },
      { type: 'PICK_CARDS', picks: [{ from: 1, slot: 0 }] },
      { type: 'MINIGAME_DECLINE' },
    ];
    for (const i of ok) expect(PlayerIntentSchema.safeParse(i).success, JSON.stringify(i)).toBe(true);
  });

  it('拒绝系统 action、未知字段与越界值', () => {
    const bad: unknown[] = [
      { type: 'MINIGAME_RESULT', seat: 0, decisionId: 'd1', score: 10, logHash: 1 },
      { type: 'SYS_DEBUG', op: { op: 'setDate', date: 19980101 } },
      { type: 'SET_DICE', count: 2 },
      { type: 'ROLL', dice: 4 },
      { type: 'ROLL', seat: 0 },
      { type: 'USE_CARD', slot: 0, card: 31, target: { t: 'none' } },
      { type: 'USE_CARD', slot: -1, card: 1, target: { t: 'none' } },
      { type: 'STOCK_BUY', stock: 0, shares: 1.5 },
      { type: 'PICK_LOT', lot: 'X1' },
      { type: 'PICK_LOT', lot: 'L0' },
      { type: 'BID', inc: 200 },
      { type: 'BAIL', seat: 4 },
      { type: 'LOTTERY_BUY', number: 36 },
    ];
    for (const i of bad) expect(PlayerIntentSchema.safeParse(i).success, JSON.stringify(i)).toBe(false);
  });

  it('DebugOpSchema', () => {
    expect(DebugOpSchema.safeParse({ op: 'forceNext', purpose: 'dice', values: [6, 6] }).success).toBe(true);
    expect(DebugOpSchema.safeParse({ op: 'forceNext', purpose: 'coin', values: [1] }).success).toBe(false);
    expect(DebugOpSchema.safeParse({ op: 'give', seat: 0, cards: [17], items: [{ item: 3, qty: 2 }] }).success).toBe(
      true,
    );
  });

  it('isSystemAction 区分玩家 action 与系统 action', () => {
    const a: GameAction = { type: 'ROLL', seat: 1, decisionId: 'd3' };
    const s: GameAction = { type: 'MINIGAME_RESULT', seat: 1, decisionId: 'd4', score: 60, logHash: 7 };
    expect(isSystemAction(a)).toBe(false);
    expect(isSystemAction(s)).toBe(true);
    expect(SYSTEM_ACTION_TYPES).toEqual(['MINIGAME_RESULT', 'SYS_SET_CONTROLLER', 'SYS_SET_AI_TRAITS', 'SYS_DEBUG']);
  });
});

describe('GameEvent 与 EVENT_META', () => {
  it('EVENT_META 对 GameEventType 穷举', () => {
    expectTypeOf<keyof typeof EVENT_META>().toEqualTypeOf<GameEventType>();
    expectTypeOf<(typeof GAME_EVENT_TYPES)[number]>().toEqualTypeOf<GameEventType>();
    expectTypeOf<GameEvent['type']>().toEqualTypeOf<GameEventType>();
    expect(new Set(GAME_EVENT_TYPES).size).toBe(GAME_EVENT_TYPES.length);
    expect(isGameEventType('DAY_END')).toBe(true);
    expect(isGameEventType('DICE_SET')).toBe(false);
    expect(isGameEventType('MINIGAME_RESULT')).toBe(false);
  });

  it('载荷不得占用保留字段 type / post', () => {
    type Clash = { [T in GameEventType]: Extract<keyof GameEventPayloads[T], 'type' | 'post'> }[GameEventType];
    expectTypeOf<Clash>().toBeNever();
  });

  it('architecture §5.6 的修订', () => {
    expectTypeOf<GameEventOf<'DICE_ROLLED'>['diceCount']>().toEqualTypeOf<1 | 2 | 3>();
    expectTypeOf<GameEventOf<'MINIGAME_STARTED'>>().not.toHaveProperty('seed');
    expectTypeOf<GameEventOf<'MINIGAME_ENDED'>['mode']>().toEqualTypeOf<'played' | 'skipped'>();
    for (const t of ['DAY_END', 'MINIGAME_ENDED', 'MINIGAME_STARTED', 'SYNC', 'TIME_REWOUND'] as const) {
      expect(GAME_EVENT_TYPES).toContain(t);
    }
  });

  it('只有 TIME_REWOUND 重置视图', () => {
    expectTypeOf<ResetsViewEventType>().toEqualTypeOf<'TIME_REWOUND'>();
    const resets = GAME_EVENT_TYPES.filter((t) => 'resetsView' in EVENT_META[t]);
    expect(resets).toEqual(['TIME_REWOUND']);
  });

  it('redactCards 事件都带 seat 与可置空的 card', () => {
    expectTypeOf<GameEventOf<RedactCardsEventType>>().toExtend<{ seat: SeatIndex; card: CardId | null }>();
    const redacted = GAME_EVENT_TYPES.filter((t) => EVENT_META[t].privacy === 'redactCards');
    expect(redacted.sort()).toEqual(['CARD_GAINED', 'CARD_LOST', 'CHAIRMAN_GIFT', 'SHOP_TRADE']);
  });
});

/** 列出类型中可能为 undefined 的路径（state 只放 JSON 值：用 null，不用 undefined） */
type UndefinedPaths<T, P extends string> = undefined extends T
  ? P
  : T extends readonly (infer U)[]
    ? UndefinedPaths<U, `${P}[]`>
    : T extends object
      ? { [K in keyof T & string]-?: UndefinedPaths<T[K], `${P}.${K}`> }[keyof T & string]
      : never;

describe('GameState 形状', () => {
  it('state 里没有 undefined（唯一例外：defaultIntent 的 ROLL.dice 按 architecture §5.5 为可选字段）', () => {
    expectTypeOf<UndefinedPaths<GameState, 's'>>().toEqualTypeOf<'s.pending[].defaultIntent.dice'>();
  });

  it('PublicWorld 不含 secret / flow / pending / counters', () => {
    expectTypeOf<PublicWorld>().not.toHaveProperty('secret');
    expectTypeOf<PublicWorld>().not.toHaveProperty('flow');
    expectTypeOf<PublicWorld>().not.toHaveProperty('pending');
    expectTypeOf<PublicWorld>().not.toHaveProperty('counters');
    expectTypeOf<PublicWorld>().toHaveProperty('dataRef');
    expectTypeOf<GameState['secret']['rng']>().toEqualTypeOf<[number, number, number, number]>();
    expectTypeOf<GameState['players'][number]['turn']['log']>().toEqualTypeOf<
      ('stockBuy' | 'stockSell' | 'boardList' | 'boardBuy' | 'card' | 'item')[]
    >();
  });
});
