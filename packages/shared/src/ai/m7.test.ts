import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../data/maps/registry';
import { editState, newGame, simpleView } from '../engine/testing/index';
import type {
  AuctionBidOptions,
  DecisionKind,
  DecisionOptionsMap,
  GameState,
  PlayerIntent,
  SeatIndex,
  TurnMenuOptions,
} from '../engine/types/index';
import type { DecisionForYou, GameView } from '../view/types';
import { BASIC_HANDLERS } from './basic';
import { auctionBid, auctionLimit } from './decisions/auction';
import { boardBuy, boardList } from './decisions/board';
import { birthdayPick, deathGodTarget } from './decisions/events';
import { magicCast } from './decisions/magic';
import { bail } from './decisions/passive';
import { isLegalIntent, ORIGINAL_HANDLERS, OriginalAiPolicy } from './policy';
import { aiRngFromSeed, makeAiContext } from './rng';
import type { AiContext } from './types';
import { AiView } from './view';

/**
 * AI4（design/minigames-ai.md §9.4、§9.7）：拍卖心理价位、魔法屋、公布栏、保释与雇恶人、生日、死神目标；
 * OriginalAiPolicy 对 23 种决策全部走原版判据（不再委托 BasicAiPolicy）。
 */
const map = fixtureRegistry.getMap('test');

function view(s: GameState): GameView {
  return simpleView(s) as GameView;
}

function ctxFor(s: GameState, seat: SeatIndex, decisionId = 'd1', traits?: Partial<AiContext['traits']>): AiContext {
  const p = s.players.find((x) => x.seat === seat)!;
  return makeAiContext({
    aiSeed: s.secret.aiSeed,
    seat,
    decisionId,
    turnNo: s.clock.turnNo,
    traits: { ...p.aiTraits, ...traits },
    map,
    handVisibility: 'public',
  });
}

function decision<K extends DecisionKind>(
  kind: K,
  seat: SeatIndex,
  options: DecisionOptionsMap[K],
  defaultIntent: PlayerIntent = { type: 'SKIP' },
): DecisionForYou<K> {
  return { decisionId: 'd1', seat, kind, timing: 'pick', options, defaultIntent, deadlineAt: null };
}

function base(edit: (s: GameState) => void = () => {}): GameState {
  const g = newGame({ players: ['human', 'ai', 'ai'] });
  return editState(g.state, edit);
}

function bidOptions(o: Partial<AuctionBidOptions>): AuctionBidOptions {
  return {
    lot: 'L1',
    level: 2,
    seller: 0,
    start: 4000,
    price: 4000,
    leader: null,
    increments: [0, 100, 500, 1000, 5000, 10000],
    cash: 100000,
    others: 1,
    source: 'card',
    ...o,
  };
}

describe('AI4 auction（拍卖心理价位）', () => {
  it('心理价位 L = min(v1, v2, 现金)，同一回合内稳定；出价取不超过 L 的最大一档', () => {
    const s = base((x) => {
      x.lands[1]!.owner = 1;
    });
    const d = decision('AUCTION_BID', 1, bidOptions({}), { type: 'PASS' });
    const v = new AiView(view(s), 1, map);
    const l1 = auctionLimit(v, d, ctxFor(s, 1, 'd1'));
    const l2 = auctionLimit(v, d, ctxFor(s, 1, 'd9'));
    expect(l1).toBe(l2);
    // v2 = 地价 × PI × (3 + r/65536) ∈ [6000, 7000]；v1 ≥ (1 + 1 + 1) × 4000 × 1 × 2 × 0.5
    expect(l1).toBeGreaterThanOrEqual(6000);
    expect(l1).toBeLessThanOrEqual(7000);
    const intent = auctionBid(v, d, ctxFor(s, 1));
    expect(intent).toEqual({ type: 'BID', inc: 1000 });
  });

  it('只剩自己可出价时压成最小档；现金 < 现价 → QUIT；心理价位 < 现价 → PASS', () => {
    const s = base();
    const v = new AiView(view(s), 1, map);
    expect(auctionBid(v, decision('AUCTION_BID', 1, bidOptions({ others: 0 })), ctxFor(s, 1))).toEqual({
      type: 'BID',
      inc: 0,
    });
    expect(
      auctionBid(v, decision('AUCTION_BID', 1, bidOptions({ leader: 2, price: 4100, others: 0 })), ctxFor(s, 1)),
    ).toEqual({ type: 'BID', inc: 100 });
    expect(auctionBid(v, decision('AUCTION_BID', 1, bidOptions({ cash: 3999 })), ctxFor(s, 1))).toEqual({
      type: 'QUIT',
    });
    expect(auctionBid(v, decision('AUCTION_BID', 1, bidOptions({ leader: 2, price: 50000 })), ctxFor(s, 1))).toEqual({
      type: 'PASS',
    });
  });
});

describe('AI4 magic（魔法屋）', () => {
  it('名单里有自己 → 效果 6；否则 rng % 11，抽到 6 改为 7', () => {
    const s = base();
    const all = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
    const self = decision('MAGIC_CAST', 1, { condition: 10, targets: [1, 2], effects: [...all] });
    expect(magicCast(self, ctxFor(s, 1))).toEqual({ type: 'MAGIC_CAST', effect: 6 });
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const d = decision('MAGIC_CAST', 1, { condition: 11, targets: [0], effects: [...all] });
      const r = magicCast(d, ctxFor(s, 1, `d${i}`));
      if (r.type === 'MAGIC_CAST') seen.add(r.effect);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 9, 10]);
  });
});

describe('AI4 bail（保释与雇恶人）', () => {
  it('大老奸只考虑恶人：点券 ≥ 700 才雇（实际收 300）；乖宝宝只保释玩家', () => {
    const s = base((x) => {
      x.players[1]!.points = 700;
    });
    const o = {
      where: 'jail' as const,
      points: 700,
      inmates: [{ seat: 0 as SeatIndex, remaining: 3 }],
      villains: [
        { kind: 'thief' as const, available: true },
        { kind: 'robber' as const, available: true },
      ],
      costs: { bail: 30, hire: 300 },
    };
    const v = new AiView(view(s), 1, map);
    const results = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const r = bail(v, decision('BAIL', 1, o), ctxFor(s, 1, `d${i}`, { personality: 2 }));
      results.add(r.type === 'HIRE' ? `HIRE:${r.villain}` : r.type);
    }
    expect([...results].sort()).toEqual(['HIRE:robber', 'HIRE:thief', 'SKIP']);
    const poor = editState(s, (x) => {
      x.players[1]!.points = 699;
    });
    const pv = new AiView(view(poor), 1, map);
    for (let i = 0; i < 30; i++) {
      const r = bail(pv, decision('BAIL', 1, { ...o, points: 699 }), ctxFor(poor, 1, `d${i}`, { personality: 2 }));
      expect(r.type).toBe('SKIP');
    }
    for (let i = 0; i < 30; i++) {
      const r = bail(v, decision('BAIL', 1, o), ctxFor(s, 1, `d${i}`, { personality: 0 }));
      expect(r.type === 'SKIP' || r.type === 'BAIL').toBe(true);
    }
  });

  it('候选只按个性组（恶人不看点券），点券门槛在抽中之后检查；随机数顺序 rand&1 → rand%3（个性 1）→ rand%n', () => {
    // 点券 100：够保释玩家（> 30），不够雇恶人（available=false，也不到 700）
    const s = base((x) => {
      x.players[1]!.points = 100;
    });
    const o = {
      where: 'jail' as const,
      points: 100,
      inmates: [{ seat: 0 as SeatIndex, remaining: 3 }],
      villains: [
        { kind: 'thief' as const, available: false },
        { kind: 'robber' as const, available: false },
      ],
      costs: { bail: 30, hire: 300 },
    };
    const v = new AiView(view(s), 1, map);
    let villainPicked = 0;
    for (let i = 0; i < 300; i++) {
      // 按 g_villains §1 手算：个性 1 在 rand%3==0 时候选 = 1 名玩家 + 2 个恶人，抽中恶人就什么也不做
      const ref = aiRngFromSeed(5000 + i);
      let want: PlayerIntent = { type: 'SKIP' };
      if (ref.bit() === 1) {
        const n = ref.mod(3) === 0 ? 3 : 1;
        const pick = ref.mod(n);
        if (pick === 0) want = { type: 'BAIL', target: 0 };
        else villainPicked++;
      }
      const rng = aiRngFromSeed(5000 + i);
      const got = bail(v, decision('BAIL', 1, o), { ...ctxFor(s, 1, `d${i}`, { personality: 1 }), rng });
      expect(got).toEqual(want);
      // 两边消耗的随机数一样多
      expect(rng.next15()).toBe(ref.next15());
      // 个性 2：候选 = 2 个恶人，照样消耗 rand%2，点券不足 → 不理会
      const ref2 = aiRngFromSeed(9000 + i);
      if (ref2.bit() === 1) ref2.mod(2);
      const rng2 = aiRngFromSeed(9000 + i);
      expect(bail(v, decision('BAIL', 1, o), { ...ctxFor(s, 1, `e${i}`, { personality: 2 }), rng: rng2 })).toEqual({
        type: 'SKIP',
      });
      expect(rng2.next15()).toBe(ref2.next15());
    }
    // 旧实现先按点券筛掉恶人，个性 1 永远抽中玩家
    expect(villainPicked).toBeGreaterThan(10);
  });
});

describe('AI4 noticeBoard（公布栏）', () => {
  function menuOf(_s: GameState, board: Partial<TurnMenuOptions['board']>): TurnMenuOptions {
    return {
      dice: { allowed: [1], current: 1, locked: null },
      cards: [],
      items: [],
      stock: { open: true, reason: null, rows: [], deposit: 0 },
      board: { listings: [], mine: 0, canList: true, lotCaps: [], ...board },
      canSurrender: false,
      timeMachine: { usable: false, anchorTurn: null },
      turnLog: [],
      menuActions: { used: 0, limit: 40 },
    } satisfies TurnMenuOptions & { stock: unknown } as TurnMenuOptions;
  }

  it('挂牌：rng % 15 == 0 才挂；手牌 > 12 张时从成对的卡里挑，标价 = 卡价 × 100 × PI；满 7 格先撤最早的', () => {
    const s = base((x) => {
      x.players[1]!.cards = [14, 14, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12];
      x.econ.priceIndex = 2;
    });
    const v = new AiView(view(s), 1, map);
    const hits: PlayerIntent[] = [];
    for (let t = 0; t < 400; t++) {
      const st = editState(s, (x) => {
        x.clock.turnNo = t;
      });
      const r = boardList(new AiView(view(st), 1, map), menuOf(st, {}), ctxFor(st, 1));
      if (r) hits.push(r);
    }
    expect(hits.length).toBeGreaterThan(10);
    expect(hits.length).toBeLessThan(50);
    expect(hits[0]).toEqual({ type: 'BOARD_LIST', asset: { t: 'card', card: 14 }, price: 20 * 100 * 2 });
    const mine = Array.from({ length: 7 }, (_, i) => ({
      id: 10 + i,
      seller: 1 as SeatIndex,
      price: 1,
      asset: { t: 'card' as const, card: 14 as const },
      mine: true,
      affordable: false,
    }));
    for (let t = 0; t < 400; t++) {
      const st = editState(s, (x) => {
        x.clock.turnNo = t;
      });
      const r = boardList(v, menuOf(st, { listings: mine, mine: 7 }), ctxFor(st, 1));
      if (r) {
        expect(r).toEqual({ type: 'BOARD_DELIST', listingId: 10 });
        break;
      }
    }
  });

  it('购买：rng % 4 == 0 才买；股票 round(标价 / 股数) < 现价、地产 3 × 估值 > 标价且现金 > 2 × 标价', () => {
    const s = base();
    const listings = [
      {
        id: 1,
        seller: 0 as SeatIndex,
        price: 7000,
        asset: { t: 'stock' as const, stock: 0, shares: 100 },
        mine: false,
        affordable: true,
      },
      {
        id: 2,
        seller: 0 as SeatIndex,
        price: 5000,
        asset: { t: 'lot' as const, lot: 'L1' as const },
        mine: false,
        affordable: true,
      },
    ];
    let bought: PlayerIntent | null = null;
    for (let t = 0; t < 40 && bought === null; t++) {
      const st = editState(s, (x) => {
        x.clock.turnNo = t;
      });
      bought = boardBuy(new AiView(view(st), 1, map), menuOf(st, { listings }), ctxFor(st, 1));
    }
    // 70 元 < 现价 80 元：先买股票
    expect(bought).toEqual({ type: 'BOARD_BUY', listingId: 1 });
    const lotOnly = [{ ...listings[1]!, price: 6001 }];
    for (let t = 0; t < 40; t++) {
      const st = editState(s, (x) => {
        x.clock.turnNo = t;
      });
      // 3 × 2000 = 6000 < 6001：不买
      expect(boardBuy(new AiView(view(st), 1, map), menuOf(st, { listings: lotOnly }), ctxFor(st, 1))).toBeNull();
    }
  });
});

describe('AI4 其余决策', () => {
  it('BIRTHDAY_PICK：每个对手随机一张；DEATH_GOD_TARGET：总资产最高的对手', () => {
    const s = base((x) => {
      x.players[2]!.deposit += 50000;
    });
    const d = decision('BIRTHDAY_PICK', 0, {
      victims: [
        { seat: 1, cards: [{ slot: 0, card: 3 }] },
        {
          seat: 2,
          cards: [
            { slot: 0, card: 4 },
            { slot: 1, card: 5 },
          ],
        },
      ],
    });
    const r = birthdayPick(d, ctxFor(s, 0));
    expect(r.type === 'PICK_CARDS' && r.picks.map((p) => p.from)).toEqual([1, 2]);
    expect(isLegalIntent(d, r)).toBe(true);
    const g = decision('DEATH_GOD_TARGET', 0, { candidates: [1, 2] });
    expect(deathGodTarget(new AiView(view(s), 0, map), g)).toEqual({ type: 'DEATH_GOD_TARGET', target: 2 });
  });

  it('OriginalAiPolicy：23 种决策都有原版处理（不再委托 BasicAiPolicy）；AI 永不投降', () => {
    for (const k of Object.keys(ORIGINAL_HANDLERS) as DecisionKind[]) {
      expect(ORIGINAL_HANDLERS[k], k).not.toBe(BASIC_HANDLERS[k] as unknown);
    }
    expect(Object.keys(ORIGINAL_HANDLERS)).toHaveLength(23);
    const g = newGame({ players: ['ai', 'human', 'human'] });
    const d = g.state.pending[0]!;
    const opts = d.options as TurnMenuOptions;
    const s2 = editState(g.state, (x) => {
      (x.pending[0]!.options as TurnMenuOptions).canSurrender = true;
    });
    const dfy = {
      decisionId: d.id,
      seat: d.seat,
      kind: d.kind,
      timing: d.timing,
      options: { ...opts, canSurrender: true },
      defaultIntent: d.defaultIntent,
      deadlineAt: null,
    } as DecisionForYou;
    const intent = OriginalAiPolicy.decide(view(s2), dfy, ctxFor(s2, d.seat, d.id));
    expect(intent.type).not.toBe('SURRENDER');
  });
});
