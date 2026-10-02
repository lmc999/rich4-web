import { describe, expect, it } from 'vitest';
import type {
  CardId,
  DecisionOptionsMap,
  GameEvent,
  GameState,
  PlayerState,
  SeatIndex,
  ShopOptions,
} from '../engine/types/index';
import { canSeeHand, itemTotal, projectDecisionOptions, projectEvent, projectState, viewerClassKey } from './project';
import type { Viewer } from './types';

const PUBLIC = { handVisibility: 'public' } as const;
const PRIVATE = { handVisibility: 'private' } as const;

function player(seat: SeatIndex, cards: CardId[], items: number[] = [0, 1]): PlayerState {
  // 投影只关心 seat、cards、items 与 hostility，其余字段原样透传
  const hostility = [100 + seat, 200 + seat, 300 + seat, 400 + seat];
  return { seat, cards, cash: 1000 + seat, items, vehicle: 'walk', points: 7, hostility } as unknown as PlayerState;
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
    players: [player(0, [1, 2], [0, 0, 3, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0]), player(2, [3])],
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

  it('public 模式所有人都能看到手牌、背包与牌堆，并带 cardCount / itemCount', () => {
    const v = projectState(state(), spectator, PUBLIC);
    expect(v.players.map((p) => [p.cards, p.cardCount, p.itemCount])).toEqual([
      [[1, 2], 2, 12],
      [[3], 1, 1],
    ]);
    expect(v.players[0]!.items).toEqual([0, 0, 3, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0]);
    expect(v.pools).toEqual({ cards: [0, 5], items: [0] });
  });

  it('private 模式只有本人看到自己的卡片与道具；张数、道具总数、交通工具、点券照常公开；pools 对所有人为 null', () => {
    const s = state();
    const mine = projectState(s, seat(2), PRIVATE);
    expect(mine.players.map((p) => p.cards)).toEqual([null, [3]]);
    expect(mine.players.map((p) => p.items)).toEqual([null, [0, 1]]);
    expect(mine.players.map((p) => [p.cardCount, p.itemCount])).toEqual([
      [2, 12],
      [1, 1],
    ]);
    expect(mine.players.map((p) => [p.vehicle, p.points])).toEqual([
      ['walk', 7],
      ['walk', 7],
    ]);
    expect(mine.pools).toBeNull();
    const spec = projectState(s, spectator, PRIVATE);
    expect(spec.players.map((p) => [p.cards, p.items])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(spec.players.map((p) => [p.cardCount, p.itemCount])).toEqual([
      [2, 12],
      [1, 1],
    ]);
    expect(spec.pools).toBeNull();
  });

  it('private 模式：别人的敌意值只留对观察者本人的一项，观战者全为 0；本人与 public 模式完整', () => {
    const s = state();
    // 座位 2 看：0 号的 hostility 只剩 [2]（0 号对 2 号的敌意），自己的完整
    expect(projectState(s, seat(2), PRIVATE).players.map((p) => p.hostility)).toEqual([
      [0, 0, 300, 0],
      [102, 202, 302, 402],
    ]);
    // 不在局中的座位 1 看：只剩 [1]
    expect(projectState(s, seat(1), PRIVATE).players.map((p) => p.hostility)).toEqual([
      [0, 200, 0, 0],
      [0, 202, 0, 0],
    ]);
    expect(projectState(s, spectator, PRIVATE).players.map((p) => p.hostility)).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    for (const v of [seat(2), spectator]) {
      expect(projectState(s, v, PUBLIC).players.map((p) => p.hostility)).toEqual([
        [100, 200, 300, 400],
        [102, 202, 302, 402],
      ]);
    }
    expect(s.players[0]!.hostility).toEqual([100, 200, 300, 400]); // 不修改输入
  });

  it('不修改输入，手牌与背包数组是副本', () => {
    const s = state();
    const before = JSON.stringify(s);
    const v = projectState(s, seat(0), PUBLIC);
    v.players[0]!.cards!.push(9);
    v.players[0]!.items![1] = 5;
    expect(JSON.stringify(s)).toBe(before);
  });

  it('itemTotal', () => {
    expect(itemTotal([0, 1, 0, 9, 2])).toBe(12);
    expect(itemTotal([])).toBe(0);
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

  it('public 模式不脱敏，但给 post 补 cardCount（没有改动 items 时不补 itemCount）', () => {
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

  it('出卡与用道具在 private 模式下载荷不变（原版亮卡；抢夺卡抢卡只带卡槽下标）', () => {
    const used: GameEvent = { type: 'CARD_USED', seat: 0, card: 3, target: { t: 'none' } };
    expect(projectEvent(used, seat(1), PRIVATE)).toBe(used);
    const robCard: GameEvent = {
      type: 'CARD_USED',
      seat: 0,
      card: 13,
      target: { t: 'rob', seat: 1, take: { k: 'card', slot: 2 } },
    };
    expect(projectEvent(robCard, spectator, PRIVATE)).toBe(robCard);
    const item: GameEvent = { type: 'ITEM_USED', seat: 0, item: 8, target: { t: 'dice', value: 6 } };
    expect(projectEvent(item, seat(1), PRIVATE)).toBe(item);
  });

  it('private 模式：道具得失、交易、赠礼对他人只剩数量与来源', () => {
    type E<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;
    const gained: E<'ITEM_GAINED'> = {
      type: 'ITEM_GAINED',
      seat: 0,
      item: 8,
      qty: 2,
      source: 'shop',
      post: { players: [{ seat: 0, set: { items: [0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0], points: 3 } }] },
    };
    const lost: E<'ITEM_LOST'> = { type: 'ITEM_LOST', seat: 0, item: 3, qty: 1, cause: 'robbed' };
    const trade: E<'SHOP_TRADE'> = {
      type: 'SHOP_TRADE',
      seat: 0,
      op: 'buyItem',
      card: null,
      item: 8,
      qty: 2,
      points: 60,
    };
    const tradeCard: E<'SHOP_TRADE'> = {
      type: 'SHOP_TRADE',
      seat: 0,
      op: 'buyCard',
      card: 13,
      item: null,
      qty: 1,
      points: 40,
    };
    const gift: E<'CHAIRMAN_GIFT'> = { type: 'CHAIRMAN_GIFT', seat: 0, card: 5, item: 9 };
    for (const v of [seat(1), spectator]) {
      const g = projectEvent(gained, v, PRIVATE) as E<'ITEM_GAINED'>;
      expect(g).toMatchObject({ item: null, qty: 2, source: 'shop' });
      expect(g.post?.players?.[0]?.set).toEqual({ items: null, itemCount: 2, points: 3 });
      expect(projectEvent(lost, v, PRIVATE)).toMatchObject({ item: null, qty: 1, cause: 'robbed' });
      expect(projectEvent(trade, v, PRIVATE)).toMatchObject({
        card: null,
        item: null,
        qty: 2,
        points: 60,
        op: 'buyItem',
      });
      expect(projectEvent(tradeCard, v, PRIVATE)).toMatchObject({ card: null, item: null, points: 40 });
      expect(projectEvent(gift, v, PRIVATE)).toMatchObject({ card: null, item: null });
    }
    // 本人看得到；public 模式不脱敏
    for (const [v, o] of [
      [seat(0), PRIVATE],
      [seat(1), PUBLIC],
    ] as const) {
      const g = projectEvent(gained, v, o) as E<'ITEM_GAINED'>;
      expect(g.item).toBe(8);
      expect(g.post?.players?.[0]?.set).toEqual({
        items: [0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0],
        itemCount: 2,
        points: 3,
      });
      expect(projectEvent(lost, v, o)).toBe(lost);
      expect(projectEvent(trade, v, o)).toBe(trade);
      expect(projectEvent(gift, v, o)).toBe(gift);
    }
  });

  it('private 模式：货架只给进店的人；抢夺卡抢到的道具种类只给出卡人与被抢人', () => {
    const shop: GameEvent = { type: 'SHOP_OPENED', seat: 0, shelf: [3, 13, 20], fullDeck: false };
    expect(projectEvent(shop, seat(1), PRIVATE)).toEqual({ ...shop, shelf: [] });
    expect(projectEvent(shop, spectator, PRIVATE)).toEqual({ ...shop, shelf: [] });
    expect(projectEvent(shop, seat(0), PRIVATE)).toBe(shop);
    expect(projectEvent(shop, seat(1), PUBLIC)).toBe(shop);
    const rob: GameEvent = {
      type: 'CARD_USED',
      seat: 0,
      card: 13,
      target: { t: 'rob', seat: 2, take: { k: 'item', item: 7 } },
    };
    expect(projectEvent(rob, seat(0), PRIVATE)).toBe(rob);
    expect(projectEvent(rob, seat(2), PRIVATE)).toBe(rob);
    for (const v of [seat(1), seat(3), spectator]) {
      expect(projectEvent(rob, v, PRIVATE)).toEqual({
        ...rob,
        target: { t: 'rob', seat: 2, take: { k: 'item', item: null } },
      });
    }
  });

  it('private 模式：抢夺后 post 里被抢人的敌意（增量 = 被抢物标价）只给被抢人完整、出卡人只见对自己的一项，第三方与观战者全为 0', () => {
    // 0 号抢走 1 号的飞弹（标价 100）：被抢人 1 号对 0 号的敌意 +100
    const lost: GameEvent = {
      type: 'ITEM_LOST',
      seat: 1,
      item: 7,
      qty: 1,
      cause: 'robbed',
      post: { players: [{ seat: 1, set: { hostility: [100, 0, 7, 0] } }] },
    };
    const hate = (v: Viewer) => projectEvent(lost, v, PRIVATE).post?.players?.[0]?.set.hostility;
    expect(hate(seat(1))).toEqual([100, 0, 7, 0]);
    expect(hate(seat(0))).toEqual([100, 0, 0, 0]);
    expect(hate(seat(2))).toEqual([0, 0, 7, 0]);
    expect(hate(seat(3))).toEqual([0, 0, 0, 0]);
    expect(hate(spectator)).toEqual([0, 0, 0, 0]);
    expect(projectEvent(lost, seat(3), PRIVATE)).toMatchObject({ item: null, qty: 1 });
    expect(projectEvent(lost, seat(3), PUBLIC)).toBe(lost);
    // 可重复套用（上游已经改写过）
    const once = projectEvent(lost, spectator, PRIVATE);
    expect(projectEvent(once, spectator, PRIVATE)).toEqual(once);
    expect(lost.post?.players?.[0]?.set.hostility).toEqual([100, 0, 7, 0]); // 不修改输入
  });

  it('private 模式去掉 post.pools（public 模式保留）', () => {
    const e: GameEvent = {
      type: 'CARD_GAINED',
      seat: 0,
      card: 7,
      source: 'square',
      post: { players: [{ seat: 0, set: { cards: [7] } }], pools: { cards: [0, 4], items: [0] }, clock: { turnNo: 9 } },
    };
    for (const v of [seat(0), seat(1), spectator]) {
      const out = projectEvent(e, v, PRIVATE);
      expect(out.post && 'pools' in out.post).toBe(false);
      expect(out.post?.clock).toEqual({ turnNo: 9 });
    }
    expect(projectEvent(e, seat(1), PUBLIC).post?.pools).toEqual({ cards: [0, 4], items: [0] });
    const poolsOnly: GameEvent = { type: 'SYNC', reason: 'flush', post: { pools: { cards: [0, 4], items: [0] } } };
    expect(projectEvent(poolsOnly, seat(0), PRIVATE)).toEqual({ type: 'SYNC', reason: 'flush', post: {} });
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

describe('projectDecisionOptions', () => {
  // 只含改写会读取的字段
  const shop = {
    points: 500,
    items: [
      { item: 2, price: 30, pool: 7, own: 2, maxQty: 1, listed: true, bought: false },
      { item: 3, price: 25, pool: 0, own: 0, maxQty: 0, listed: false, bought: false },
      { item: 8, price: 30, pool: 1, own: 0, maxQty: 0, listed: true, bought: true },
    ],
  } as unknown as ShopOptions;

  it('private 模式：SHOP 道具行的共享库存只留有没有货（0 / 1），其余字段不变', () => {
    const out = projectDecisionOptions('SHOP', shop, PRIVATE);
    expect(out.items.map((r) => r.pool)).toEqual([1, 0, 1]);
    expect(out.items.map(({ pool: _p, ...r }) => r)).toEqual(shop.items.map(({ pool: _p, ...r }) => r));
    expect(out.points).toBe(500);
    expect(shop.items[0]!.pool).toBe(7); // 不修改输入
  });

  it('public 模式与其他决策原样返回；没有要改的也原样返回', () => {
    expect(projectDecisionOptions('SHOP', shop, PUBLIC)).toBe(shop);
    const lottery = { cash: 1, price: 1000, sold: [], pool: 18000 } as unknown as DecisionOptionsMap['LOTTERY'];
    expect(projectDecisionOptions('LOTTERY', lottery, PRIVATE)).toBe(lottery);
    const small = { ...shop, items: shop.items.slice(1) } as ShopOptions;
    expect(projectDecisionOptions('SHOP', small, PRIVATE)).toBe(small);
  });
});

describe('viewerClassKey / canSeeHand', () => {
  it('public 模式全员一个 key，private 模式按座位区分', () => {
    expect(viewerClassKey(seat(0), PUBLIC)).toBe('public');
    expect(viewerClassKey(spectator, PUBLIC)).toBe('public');
    expect(viewerClassKey(seat(3), PRIVATE)).toBe('seat:3');
    expect(viewerClassKey(spectator, PRIVATE)).toBe('spectator');
  });

  it('canSeeHand', () => {
    expect(canSeeHand(1, seat(1), PRIVATE)).toBe(true);
    expect(canSeeHand(1, seat(0), PRIVATE)).toBe(false);
    expect(canSeeHand(1, spectator, PRIVATE)).toBe(false);
    expect(canSeeHand(1, spectator, PUBLIC)).toBe(true);
  });
});
