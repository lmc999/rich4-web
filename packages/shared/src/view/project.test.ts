import { describe, expect, it } from 'vitest';
import type { CardId, GameEvent, GameState, PlayerState, SeatIndex } from '../engine/types/index';
import { canSeeCards, projectEvent, projectState, viewerClassKey } from './project';
import type { Viewer } from './types';

const PUBLIC = { handVisibility: 'public' } as const;
const PRIVATE = { handVisibility: 'private' } as const;

function player(seat: SeatIndex, cards: CardId[]): PlayerState {
  // 投影只关心 seat 与 cards，其余字段原样透传
  return { seat, cards, cash: 1000 + seat, items: [0, 1] } as unknown as PlayerState;
}

/** 只含投影会读取的字段；secret 等键故意填上可识别的值，便于断言不外泄 */
function state(): GameState {
  return {
    v: 1,
    engine: '0.1.0',
    dataRef: { mapId: 'test', mapHash: 'h', tablesHash: 't' },
    config: { mapId: 'test' },
    status: 'playing',
    result: null,
    clock: { turnNo: 3 },
    econ: { pool: 0 },
    players: [player(0, [1, 2]), player(2, [3])],
    villains: [],
    lands: [{ id: 'L1', owner: 0 }],
    facilities: [],
    companies: [],
    objects: [],
    gods: [],
    beggars: [],
    stocks: [],
    pools: { cards: [0, 5], items: [0] },
    lottery: { owners: [] },
    noticeBoard: [],
    flow: [{ fid: 1, k: 'ROOT' }],
    pending: [{ id: 'd1', seat: 0 }],
    counters: { action: 1, decision: 1, frame: 1, object: 0, listing: 0 },
    secret: { rng: [1, 2, 3, 4], newsOrder: [5, 6], aiSeed: 42 },
  } as unknown as GameState;
}

function keysDeep(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) for (const v of x) keysDeep(v, out);
  else if (x !== null && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

const seat = (s: SeatIndex): Viewer => ({ kind: 'seat', seat: s });
const spectator: Viewer = { kind: 'spectator' };

describe('projectState', () => {
  it('不下发 secret / flow / pending / counters', () => {
    const s = state();
    const v = projectState(s, spectator, PUBLIC);
    const keys = keysDeep(v);
    for (const k of ['secret', 'rng', 'newsOrder', 'aiSeed', 'flow', 'pending', 'counters'])
      expect(keys.has(k)).toBe(false);
    const expected = Object.keys(s)
      .filter((k) => !['secret', 'flow', 'pending', 'counters'].includes(k))
      .sort();
    expect(Object.keys(v).sort()).toEqual(expected);
  });

  it('public 模式所有人都能看到手牌并带 cardCount', () => {
    const v = projectState(state(), spectator, PUBLIC);
    expect(v.players.map((p) => [p.cards, p.cardCount])).toEqual([
      [[1, 2], 2],
      [[3], 1],
    ]);
  });

  it('private 模式只有本人看到自己的手牌', () => {
    const s = state();
    const mine = projectState(s, seat(2), PRIVATE);
    expect(mine.players.map((p) => p.cards)).toEqual([null, [3]]);
    expect(mine.players.map((p) => p.cardCount)).toEqual([2, 1]);
    const spec = projectState(s, spectator, PRIVATE);
    expect(spec.players.map((p) => p.cards)).toEqual([null, null]);
    expect(spec.players.map((p) => p.cardCount)).toEqual([2, 1]);
  });

  it('不修改输入，手牌数组是副本', () => {
    const s = state();
    const before = JSON.stringify(s);
    const v = projectState(s, seat(0), PUBLIC);
    v.players[0]!.cards!.push(9);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('projectEvent', () => {
  const gained: GameEvent = {
    type: 'CARD_GAINED',
    seat: 0,
    card: 7,
    source: 'square',
    post: { players: [{ seat: 0, set: { cards: [1, 7], cash: 5 } }] },
  };

  it('public 模式不脱敏，但给 post 补 cardCount', () => {
    const e = projectEvent(gained, spectator, PUBLIC) as Extract<GameEvent, { type: 'CARD_GAINED' }>;
    expect(e.card).toBe(7);
    expect(e.post?.players?.[0]?.set).toEqual({ cards: [1, 7], cash: 5, cardCount: 2 });
  });

  it('private 模式对他人把 card 与 post.cards 置 null', () => {
    for (const v of [seat(2), spectator]) {
      const e = projectEvent(gained, v, PRIVATE) as Extract<GameEvent, { type: 'CARD_GAINED' }>;
      expect(e.card).toBeNull();
      expect(e.post?.players?.[0]?.set).toEqual({ cards: null, cash: 5, cardCount: 2 });
    }
    const own = projectEvent(gained, seat(0), PRIVATE) as Extract<GameEvent, { type: 'CARD_GAINED' }>;
    expect(own.card).toBe(7);
    expect(own.post?.players?.[0]?.set.cards).toEqual([1, 7]);
  });

  it('public 类事件在 private 模式下载荷不变（CARD_USED 是公开的）', () => {
    const used: GameEvent = { type: 'CARD_USED', seat: 0, card: 3, target: { t: 'none' } };
    expect(projectEvent(used, seat(1), PRIVATE)).toEqual(used);
  });

  it('不修改输入事件', () => {
    const before = JSON.stringify(gained);
    projectEvent(gained, seat(1), PRIVATE);
    expect(JSON.stringify(gained)).toBe(before);
  });

  it('没有 cards 改动的 post 原样返回', () => {
    const money: GameEvent = {
      type: 'MONEY',
      from: { t: 'seat', seat: 0 },
      to: { t: 'bank' },
      amount: 1,
      paid: 1,
      reason: 'fine',
      ref: null,
      post: { players: [{ seat: 0, set: { cash: 1 } }] },
    };
    expect(projectEvent(money, seat(1), PRIVATE)).toBe(money);
  });
});

describe('viewerClassKey / canSeeCards', () => {
  it('public 模式全员一个 key，private 模式按座位区分', () => {
    expect(viewerClassKey(seat(0), PUBLIC)).toBe('public');
    expect(viewerClassKey(spectator, PUBLIC)).toBe('public');
    expect(viewerClassKey(seat(3), PRIVATE)).toBe('seat:3');
    expect(viewerClassKey(spectator, PRIVATE)).toBe('spectator');
  });

  it('canSeeCards', () => {
    expect(canSeeCards(1, seat(1), PRIVATE)).toBe(true);
    expect(canSeeCards(1, seat(0), PRIVATE)).toBe(false);
    expect(canSeeCards(1, spectator, PUBLIC)).toBe(true);
  });
});
