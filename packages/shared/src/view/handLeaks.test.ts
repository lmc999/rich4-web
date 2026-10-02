import { describe, expect, it } from 'vitest';
import type { GameEvent, GameState, PlayerState, SeatIndex } from '../engine/types/index';
import { findHandLeaks } from './handLeaks';
import { projectEvent, projectState } from './project';
import type { Viewer } from './types';

const PUBLIC = { handVisibility: 'public' } as const;
const PRIVATE = { handVisibility: 'private' } as const;

function player(seat: SeatIndex): PlayerState {
  const items = new Array<number>(14).fill(0);
  items[8] = 9;
  // 0 号对 1 号、1 号对 0 号各有敌意
  const hostility = seat === 0 ? [0, 5, 0, 0] : [9, 0, 0, 0];
  return { seat, cards: [13, 18], items, cash: 1, vehicle: 'walk', hostility } as unknown as PlayerState;
}

function state(): GameState {
  return {
    v: 1,
    players: [player(0), player(1)],
    lands: [],
    noticeBoard: [{ id: 1, seller: 0, asset: { t: 'card', card: 13 }, price: 1 }],
    pools: { cards: [0, 3], items: [0, 9] },
  } as unknown as GameState;
}

/** 覆盖每一种会带卡号 / 道具号的事件 */
const EVENTS: GameEvent[] = [
  { type: 'CARD_GAINED', seat: 0, card: 13, source: 'shop', post: { players: [{ seat: 0, set: { cards: [13] } }] } },
  { type: 'CARD_LOST', seat: 0, card: 18, cause: 'sold' },
  { type: 'SHOP_OPENED', seat: 0, shelf: [3, 4], fullDeck: false },
  { type: 'SHOP_TRADE', seat: 0, op: 'buyItem', card: null, item: 8, qty: 1, points: 30 },
  { type: 'CHAIRMAN_GIFT', seat: 0, card: 5, item: null },
  {
    type: 'ITEM_GAINED',
    seat: 0,
    item: 8,
    qty: 1,
    source: 'shop',
    post: {
      players: [{ seat: 0, set: { items: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0] } }],
      pools: { cards: [], items: [] },
    },
  },
  { type: 'ITEM_LOST', seat: 0, item: 3, qty: 1, cause: 'used' },
  { type: 'CARD_USED', seat: 0, card: 13, target: { t: 'rob', seat: 1, take: { k: 'item', item: 3 } } },
  { type: 'ITEM_USED', seat: 0, item: 8, target: { t: 'dice', value: 6 } },
  { type: 'RESEARCH_DONE', seat: 0, lot: 'F1' as never, project: 'missile' as never, item: 7, delivered: true },
  { type: 'LISTING_ADDED', listing: { id: 2, seller: 0, asset: { t: 'item', item: 8, qty: 1 }, price: 5 } as never },
  // 抢夺：被抢人 1 号对出卡人 0 号的敌意 += 被抢物标价（地雷 25）
  {
    type: 'ITEM_LOST',
    seat: 1,
    item: 3,
    qty: 1,
    cause: 'robbed',
    post: { players: [{ seat: 1, set: { hostility: [25, 0, 0, 0] } }] },
  },
];

const seat = (s: SeatIndex): Viewer => ({ kind: 'seat', seat: s });

function payloadFor(v: Viewer, o: typeof PUBLIC | typeof PRIVATE) {
  return { view: projectState(state(), v, o), events: EVENTS.map((e) => projectEvent(e, v, o)) };
}

describe('findHandLeaks', () => {
  it('private 投影：座位 2、观战者看不到 0 号的任何手牌；被抢的 1 号看得到抢走的道具', () => {
    expect(findHandLeaks(payloadFor(seat(2), PRIVATE), 2)).toEqual([]);
    expect(findHandLeaks(payloadFor({ kind: 'spectator' }, PRIVATE), null)).toEqual([]);
    expect(findHandLeaks(payloadFor(seat(1), PRIVATE), 1)).toEqual([]);
    // 0 号自己
    expect(findHandLeaks(payloadFor(seat(0), PRIVATE), 0)).toEqual([]);
  });

  it('public 投影在别人视角下报告每一处泄漏', () => {
    const leaks = findHandLeaks(payloadFor(seat(2), PUBLIC), 2);
    for (const k of [
      '$.view.players[0].cards',
      '$.view.players[0].items',
      '$.view.players[1].cards',
      '$.view.pools',
      '$.events[0].card',
      '$.events[0].post.players[0].set.cards',
      '$.events[1].card',
      '$.events[2].shelf',
      '$.events[3].item',
      '$.events[4].card',
      '$.events[5].item',
      '$.events[5].post.players[0].set.items',
      '$.events[5].post.pools',
      '$.events[6].item',
      '$.events[7].target.take',
      '$.view.players[0].hostility',
      '$.view.players[1].hostility',
      '$.events[11].post.players[0].set.hostility',
    ]) {
      expect(
        leaks.some((l) => l.startsWith(`${k}:`)),
        k,
      ).toBe(true);
    }
    // 公开的出卡、用道具、研究所成果、公布栏挂牌不算泄漏
    expect(leaks.some((l) => /events\[(8|9|10)\]|noticeBoard/.test(l))).toBe(false);
  });

  it('敌意值：别人的只能带对本人的一项（抢夺后增量等于被抢物标价）', () => {
    const view = (h: number[]) => ({ view: { players: [{ seat: 1, cardCount: 0, hostility: h }] } });
    expect(findHandLeaks(view([25, 0, 0, 0]), 0)).toEqual([]);
    expect(findHandLeaks(view([25, 0, 0, 0]), 2)).toEqual(['$.view.players[0].hostility: player 1 hostility']);
    expect(findHandLeaks(view([25, 0, 0, 0]), null)).toEqual(['$.view.players[0].hostility: player 1 hostility']);
    expect(findHandLeaks(view([25, 3, 0, 0]), 1)).toEqual([]); // 本人
    const patch = (h: number[]) => ({ post: { players: [{ seat: 1, set: { hostility: h } }] } });
    expect(findHandLeaks(patch([0, 0, 4, 0]), 2)).toEqual([]);
    expect(findHandLeaks(patch([25, 0, 4, 0]), 2)).toEqual(['$.post.players[0].set.hostility: patch 1 hostility']);
    expect(findHandLeaks({ foo: { hostility: [0, 0, 0, 0] } }, 0)).toEqual(['$.foo.hostility: unknown location']);
  });

  it('未知位置的手牌键一律报告；yourDecision 子树不扫描', () => {
    expect(findHandLeaks({ foo: { cards: [1] } }, 0)).toEqual(['$.foo.cards: unknown location']);
    expect(findHandLeaks({ yourDecision: { options: { victims: [{ cards: [1], items: [2] }] } } }, 0)).toEqual([]);
  });
});
