import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../data/maps/registry';
import { engineMap } from '../engine/core/mapCache';
import { isIntentAllowed } from '../engine/decisions/allowed';
import { buildTurnMenu } from '../engine/decisions/build';
import { decisionForSeat, editState, newGame, scenario, simpleView } from '../engine/testing/index';
import {
  DECISION_KINDS,
  type DecisionKind,
  type DecisionOptionsMap,
  type GameAction,
  type GameState,
  type PlayerIntent,
  PlayerIntentSchema,
  type SeatIndex,
  type ShopOptions,
} from '../engine/types/index';
import { fnv1a32, mix32 } from '../util/hash';
import type { DecisionForYou, GameView } from '../view/types';
import { atmTargetRatio } from './decisions/bank';
import { aiBuyReserve } from './decisions/property';
import { passesGate } from './gate';
import { ORIGINAL_HANDLERS, OriginalAiPolicy } from './policy';
import { aiRngFromSeed, createAiRng, makeAiContext } from './rng';
import type { AiContext } from './types';
import { AiView } from './view';

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
    map: fixtureRegistry.getMap(s.dataRef.mapId),
    handVisibility: 'public',
  });
}

function decision<K extends DecisionKind>(
  kind: K,
  seat: SeatIndex,
  options: DecisionOptionsMap[K],
  defaultIntent: PlayerIntent = { type: 'SKIP' },
): DecisionForYou<K> {
  return { decisionId: 'd1', seat, kind, timing: 'confirm', options, defaultIntent, deadlineAt: null };
}

function base(o: { fund?: 300000 | 10000; pi?: number; cash?: number; deposit?: number } = {}): GameState {
  const g = newGame({ players: ['human', 'ai'], config: { initialFund: o.fund ?? 200000 } });
  return editState(g.state, (s) => {
    s.econ.priceIndex = o.pi ?? 1;
    const p = s.players[1]!;
    if (o.cash !== undefined) p.cash = o.cash;
    if (o.deposit !== undefined) p.deposit = o.deposit;
  });
}

describe('个性闸门（gate）', () => {
  it('d = f7 − 个性：d ≥ 2 从不做，d == 1 约 1/3，d ≤ 0 照做', () => {
    const rng = aiRngFromSeed(99);
    expect(passesGate(2, 0, rng)).toBe(false);
    expect(passesGate(0, 2, rng)).toBe(true);
    expect(passesGate(1, 1, rng)).toBe(true);
    let yes = 0;
    for (let i = 0; i < 3000; i++) if (passesGate(2, 1, rng)) yes++;
    expect(yes).toBeGreaterThan(850);
    expect(yes).toBeLessThan(1150);
  });

  it('AiView：mostHated 严格大于才替换（first-wins），全为 0 返回 -1；lookahead 沿前进方向', () => {
    const s = editState(base(), (x) => {
      x.players[1]!.hostility = [5, 0, 0, 0];
    });
    const v = new AiView(view(s), 1, map);
    expect(v.mostHated()).toBe(0);
    expect(new AiView(view(base()), 1, map).mostHated()).toBe(-1);
    const moved = editState(base(), (x) => {
      x.players[1]!.placed = true;
      x.players[1]!.node = 4;
      x.players[1]!.prevNode = 3;
    });
    expect(new AiView(view(moved), 1, map).lookahead(3, aiRngFromSeed(1)).nodes).toEqual([5, 6, 7]);
  });
});

describe('OriginalAiPolicy：分派与 rng', () => {
  it('覆盖全部 23 种决策；id 为 original-v1', () => {
    expect(Object.keys(ORIGINAL_HANDLERS).sort()).toEqual([...DECISION_KINDS].sort());
    expect(OriginalAiPolicy.id).toBe('original-v1');
  });

  it('createAiRng 与服务器 AiDriver 的派生一致；turnRng 同一回合同一 salt 稳定', () => {
    const a = createAiRng(123, 2, fnv1a32('d9'));
    const b = aiRngFromSeed(mix32(123, 2, fnv1a32('d9')));
    expect([a.next15(), a.next15(), a.mod(7)]).toEqual([b.next15(), b.next15(), b.mod(7)]);
    const ctx = makeAiContext({
      aiSeed: 7,
      seat: 1,
      decisionId: 'd3',
      turnNo: 5,
      traits: base().players[1]!.aiTraits,
      map,
      handVisibility: 'public',
    });
    expect(ctx.turnRng('rank').next15()).toBe(ctx.turnRng('rank').next15());
    expect(createAiRng(7, 1, 5, 'rank').next15()).toBe(ctx.turnRng('rank').next15());
  });
});

describe('buyLand：保留额 min(trunc(开局资金×5%), 7000) × PI', () => {
  const cases = [
    { fund: 300000, pi: 1, reserve: 7000 },
    { fund: 300000, pi: 3, reserve: 21000 },
    { fund: 10000, pi: 1, reserve: 500 },
    { fund: 10000, pi: 3, reserve: 1500 },
  ] as const;
  for (const c of cases) {
    it(`buyLand 资金 ${c.fund}、PI=${c.pi}：保留额 ${c.reserve}，现金+存款−价格 恰好等于保留额时不买、多 1 元就买`, () => {
      const price = 2000;
      const at = (total: number) => {
        const s = base({ fund: c.fund, pi: c.pi, cash: price, deposit: total - price });
        const v = view(s);
        expect(aiBuyReserve(new AiView(v, 1, map))).toBe(c.reserve);
        const opts: DecisionOptionsMap['BUY_LAND'] = {
          lot: 'L1',
          price,
          cash: price,
          level: 0,
          street: { lots: [], owners: [] },
          tollAfter: 0,
          fortuneBonus: false,
        };
        return OriginalAiPolicy.decide(v, decision('BUY_LAND', 1, opts, { type: 'DECLINE' }), ctxFor(s, 1));
      };
      expect(at(price + c.reserve)).toEqual({ type: 'DECLINE' });
      expect(at(price + c.reserve + 1)).toEqual({ type: 'CONFIRM' });
    });
  }

  it('buyLand：价格高于现金时不买（BUY_FACILITY 同规则）；加盖钱够就盖', () => {
    const s = base({ cash: 1000, deposit: 500000 });
    const v = view(s);
    const fac = { lot: 'F1', price: 4000, cash: 1000, level: 0, type: 'park', fortuneBonus: false } as const;
    expect(OriginalAiPolicy.decide(v, decision('BUY_FACILITY', 1, fac, { type: 'DECLINE' }), ctxFor(s, 1))).toEqual({
      type: 'DECLINE',
    });
    const up = { lot: 'L1', cost: 1000, cash: 1000, fromLevel: 0, toLevel: 1, tollBefore: 0, tollAfter: 0 } as const;
    expect(OriginalAiPolicy.decide(v, decision('UPGRADE_LAND', 1, up), ctxFor(s, 1))).toEqual({ type: 'CONFIRM' });
  });
});

describe('bank：ATM 按现金比例重新分配；柜台借还', () => {
  it('bank ATM 目标比例：1–7 日 ×1.5、26 日起 ×0.5，t ≥ 1 取 0.9、t ≤ 0 取 0.1', () => {
    expect(atmTargetRatio(40, 10)).toBeCloseTo(0.4, 6);
    expect(atmTargetRatio(40, 3)).toBeCloseTo(0.6, 6);
    expect(atmTargetRatio(40, 26)).toBeCloseTo(0.2, 6);
    expect(atmTargetRatio(80, 1)).toBeCloseTo(0.9, 6);
    expect(atmTargetRatio(0, 10)).toBeCloseTo(0.1, 6);
  });

  it('bank ATM：偏离 ≥ 0.25 或现金为 0 时调到 trunc(总额 × t)；否则不动；挤兑时不取', () => {
    // 阿土伯 cashRatio 40；2005-05-15（中旬）→ t = 0.4
    const atm = (cash: number, deposit: number, canWithdraw = true) => {
      const s = editState(base({ cash, deposit }), (x) => {
        x.clock.date = 20050515;
      });
      const o = { mode: 'pass', cash, deposit, canWithdraw, reserveShortfallPayer: null } as const;
      return OriginalAiPolicy.decide(view(s), decision('BANK_ATM', 1, o), ctxFor(s, 1));
    };
    expect(atm(80000, 20000)).toEqual({ type: 'ATM', op: 'deposit', amount: 40000 });
    expect(atm(60000, 40000)).toEqual({ type: 'SKIP' });
    expect(atm(0, 100000)).toEqual({ type: 'ATM', op: 'withdraw', amount: 40000 });
    expect(atm(0, 100000, false)).toEqual({ type: 'SKIP' });
    expect(atm(10000, 90000)).toEqual({ type: 'ATM', op: 'withdraw', amount: 30000 });
  });

  it('bank counter：2×贷款 < 存款或临近到期且够还 → 还清；无贷款时 rng%10==0 或现金+存款 < 30000 → 借 身家×loanRatio%', () => {
    const counter = (o: Partial<DecisionOptionsMap['BANK_COUNTER']>, cash: number, deposit: number, loanRatio = 50) => {
      const s = base({ cash, deposit });
      const full = {
        cash,
        deposit,
        loan: 0,
        loanDue: 0,
        loanLimit: 100000,
        loanBlocked: null,
        dueDatePreview: 20050803,
        repayMax: 0,
        financeLimit: null,
        finance: 0,
        ...o,
      };
      return OriginalAiPolicy.decide(view(s), decision('BANK_COUNTER', 1, full), ctxFor(s, 1, 'd1', { loanRatio }));
    };
    expect(counter({ loan: 10000, loanDue: 20050803, repayMax: 10000 }, 5000, 25000)).toEqual({
      type: 'REPAY',
      amount: 10000,
    });
    // 到期前 3 天，现金+存款 11000 ≥ 1.1 × 10000
    expect(counter({ loan: 10000, loanDue: 20050508, repayMax: 10000 }, 1000, 10000)).toEqual({
      type: 'REPAY',
      amount: 10000,
    });
    expect(counter({ loan: 10000, loanDue: 20050508, repayMax: 10000 }, 1000, 9000)).toEqual({ type: 'SKIP' });
    // 现金+存款 < 30000 → 借 min(trunc(身家 × 50%), 额度)
    const s = base({ cash: 10000, deposit: 10000 });
    const worth = new AiView(view(s), 1, map).netWorth();
    expect(counter({}, 10000, 10000)).toEqual({ type: 'LOAN', amount: Math.min(Math.trunc(worth / 2), 100000) });
    expect(counter({}, 10000, 10000, 0)).toEqual({ type: 'SKIP' });
    expect(counter({ loanBlocked: 'bankRun' }, 10000, 10000)).toEqual({ type: 'SKIP' });
  });
});

describe('shop：电脑面对整副牌堆', () => {
  function shopDecision(
    points: number,
    o: { hand?: number[]; items?: { item: number; qty: number }[]; personality?: 0 | 1 | 2 } = {},
  ) {
    const sc = scenario({ players: ['human', 'ai'] }).untilMenu(1);
    if (o.hand || o.items) sc.give(1, { cards: (o.hand ?? []) as never[], items: (o.items ?? []) as never[] });
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 1, points } });
    sc.teleport(1, 9, 8).force('dice', 1).roll(1).expectAsk(1, 'SHOP');
    const run = (): PlayerIntent[] => {
      const out: PlayerIntent[] = [];
      for (let i = 0; i < 80; i++) {
        const d = sc.state.pending[0]!;
        if (d.kind !== 'SHOP' || d.seat !== 1) break;
        const traits = { personality: o.personality ?? 1 } as const;
        const intent = OriginalAiPolicy.decide(
          view(sc.state),
          decisionForSeat(d) as DecisionForYou,
          ctxFor(sc.state, 1, d.id, traits),
        );
        out.push(intent);
        sc.act(1, intent);
      }
      return out;
    };
    return { sc, run };
  }
  const FULL_HAND = [3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 7, 7, 7];

  it('shop：步行、满手、460 点券 → 买机车后预算 150，买不到汽车', () => {
    const { sc, run } = shopDecision(460, { hand: FULL_HAND });
    const trades = run();
    expect(trades[0]).toEqual({ type: 'SHOP_BUY_ITEM', item: 5, qty: 1 });
    expect(trades.some((t) => t.type === 'SHOP_BUY_ITEM' && t.item === 6)).toBe(false);
    expect(trades.at(-1)).toEqual({ type: 'LEAVE' });
    expect(sc.player(1).items[5]).toBe(1);
    expect(sc.player(1).items[6]).toBe(0);
  });

  it('shop：461 点券 → 买机车后预算 151，买得到汽车', () => {
    const { sc, run } = shopDecision(461, { hand: FULL_HAND });
    const trades = run();
    expect(trades.slice(0, 2)).toEqual([
      { type: 'SHOP_BUY_ITEM', item: 5, qty: 1 },
      { type: 'SHOP_BUY_ITEM', item: 6, qty: 1 },
    ]);
    expect(sc.player(1).items[6]).toBe(1);
  });

  it('shop：卡预算 = 点券 >> 1，按价格降序每种买一张；乖宝宝先卖掉 f7 == 2 的卡', () => {
    const { sc, run } = shopDecision(200);
    const trades = run();
    const bought = trades.filter((t) => t.type === 'SHOP_BUY_CARD');
    expect(bought.length).toBeGreaterThan(0);
    // 预算 100：第一张是牌堆里价格 ≤ 100 的最贵卡（冬眠 100，f7=2 对个性 1 仍可买）
    expect(sc.log.find((e) => e.type === 'SHOP_TRADE' && e.op === 'buyCard')).toMatchObject({ card: 15, points: 100 });

    // 乖宝宝（个性 0）：均贫、怪兽 f7=2 → 先卖；之后也不会再买 f7=2 的卡
    const gentle = shopDecision(150, { hand: [2, 11, 3], personality: 0 });
    const t2 = gentle.run();
    expect(t2.slice(0, 2)).toEqual([
      { type: 'SHOP_SELL_CARD', slot: 0 },
      { type: 'SHOP_SELL_CARD', slot: 0 },
    ]);
    const hand = gentle.sc.player(1).cards;
    expect(hand).toContain(3);
    expect(hand.some((c) => c === 2 || c === 11)).toBe(false);
  });

  it('shop：进店点券 < 100 时卖掉最便宜的一张卡、多余道具卖到剩 1 件（只做一次，不循环）', () => {
    const { sc, run } = shopDecision(10, { hand: [3, 7, 9], items: [{ item: 2, qty: 2 }] });
    const trades = run();
    const sells = trades.filter((t) => t.type === 'SHOP_SELL_CARD' || t.type === 'SHOP_SELL_ITEM');
    expect(sells).toContainEqual({ type: 'SHOP_SELL_CARD', slot: 1 });
    expect(sells).toContainEqual({ type: 'SHOP_SELL_ITEM', item: 2, qty: 2 });
    expect(trades.filter((t) => t.type === 'SHOP_SELL_CARD')).toHaveLength(1);
    expect(trades.length).toBeLessThan(20);
    expect((sc.state.pending[0]?.options as ShopOptions | undefined)?.visit).toBeUndefined();
  });
});

describe('lottery / subscribe / construction', () => {
  it('lottery：现金 > 1000 才买，号码从未售号码里随机挑；1000 整不买', () => {
    const sold = new Array(36).fill(null).map((_, i) => (i < 30 ? 0 : null));
    const buy = (cash: number) => {
      const s = base({ cash });
      const o = { cash, price: 1000, sold, pool: 0 };
      return OriginalAiPolicy.decide(view(s), decision('LOTTERY', 1, o as never), ctxFor(s, 1));
    };
    const r = buy(1001);
    expect(r.type).toBe('LOTTERY_BUY');
    expect((r as { number: number }).number).toBeGreaterThanOrEqual(30);
    expect(buy(1000)).toEqual({ type: 'SKIP' });
  });

  it('subscribe：n = min(max, trunc((现金 − trunc(开局资金×30%)×PI) / 单价))，n ≤ 0 不买', () => {
    const sub = (cash: number, pi: number) => {
      const s = base({ cash, pi });
      const o = { company: 'C3', stock: 1, unitPrice: 50, max: 1000, cash, reserved: 4000 } as const;
      return OriginalAiPolicy.decide(view(s), decision('SUBSCRIBE_SHARES', 1, o), ctxFor(s, 1));
    };
    expect(sub(70000, 1)).toEqual({ type: 'SUBSCRIBE', shares: 200 });
    expect(sub(200000, 1)).toEqual({ type: 'SUBSCRIBE', shares: 1000 });
    expect(sub(120000, 2)).toEqual({ type: 'SKIP' });
  });

  it('construction：住宅里当前租金最高的；没有住宅取地价最高的设施', () => {
    const s = base();
    const o = {
      company: 'C3',
      chairman: false,
      levels: 1,
      canSkip: false,
      lots: [
        { lot: 'L4', level: 2, cost: 1200, rent: 1500 },
        { lot: 'L1', level: 1, cost: 2000, rent: 1000 },
        { lot: 'F1', level: 1, cost: 4000, rent: 0 },
      ],
    } as const;
    const d = decision('CONSTRUCTION_PICK', 1, o as never, { type: 'PICK_LOT', lot: 'L1' });
    expect(OriginalAiPolicy.decide(view(s), d, ctxFor(s, 1))).toEqual({ type: 'PICK_LOT', lot: 'L4' });
    const f = decision('CONSTRUCTION_PICK', 1, { ...o, lots: [o.lots[2]] } as never, { type: 'PICK_LOT', lot: 'F1' });
    expect(OriginalAiPolicy.decide(view(s), f, ctxFor(s, 1))).toEqual({ type: 'PICK_LOT', lot: 'F1' });
  });

  it('bail：M6 之前委托 BasicAiPolicy（不理会）', () => {
    const s = base();
    const o = { where: 'jail', points: 500, inmates: [], villains: [], costs: { bail: 30, hire: 300 } } as const;
    expect(OriginalAiPolicy.decide(view(s), decision('BAIL', 1, o as never), ctxFor(s, 1))).toEqual({ type: 'SKIP' });
  });
});

describe('TURN_MENU：股票与骰子颗数', () => {
  it('buyGate 通过、有预算时买打分最高的一支（按 options 的可买量封顶）；有还款压力时连续卖股票', () => {
    let bought = 0;
    for (let seed = 0; seed < 60; seed++) {
      const g = newGame({ players: ['ai', 'ai'], seed: (0x5000 + seed).toString(16) });
      const s = editState(g.state, (x) => {
        // 无企业股票 5：现价 < 初始价 × 0.6 且近 6 日均价 > 近 24 日均价 → +4
        x.stocks[5]!.priceCents = 2000;
        x.stocks[5]!.prevCents = 2000;
        x.stocks[5]!.history = [1000, 1000, 1000, 1000, 1000, 1000, 2000, 2000, 2000, 2000, 2000, 2000];
        x.players[0]!.aiTraits.stockRatio = 50;
      });
      // 改过行情后按新状态重建 TURN_MENU 的 options（引擎在下一次发 TURN_MENU 时也会这样算）
      const d = { ...s.pending[0]!, options: buildTurnMenu(s, engineMap(map), 0) };
      const intent = OriginalAiPolicy.decide(view(s), decisionForSeat(d) as DecisionForYou, ctxFor(s, 0, d.id));
      if (intent.type === 'STOCK_BUY') {
        bought++;
        expect(intent.shares).toBeGreaterThan(0);
        const row = (d.options as DecisionOptionsMap['TURN_MENU']).stock.rows[intent.stock]!;
        expect(intent.shares).toBeLessThanOrEqual(row.maxBuy);
        const next = g.engine.applyAction(s, { ...intent, seat: 0, decisionId: d.id } as GameAction).state;
        expect(next.players[0]!.holdings[intent.stock]!.shares).toBe(intent.shares);
      } else expect(intent.type).toBe('ROLL');
    }
    // 买入闸门 rand%3==0，大约三分之一的回合会买
    expect(bought).toBeGreaterThan(5);
    expect(bought).toBeLessThan(40);
  });

  it('骰子颗数：汽车默认 3；身背炸弹引信 < 15 → 1；步行不指定', () => {
    const g = newGame({ players: ['ai', 'ai'], config: { vehicle: 'car' } });
    const d = g.state.pending[0]!;
    const walk = newGame({ players: ['ai', 'ai'] });
    const dw = walk.state.pending[0]!;
    expect(
      OriginalAiPolicy.decide(
        view(walk.state),
        decisionForSeat(dw) as DecisionForYou,
        ctxFor(walk.state, 0, dw.id, { stockRatio: 0 }),
      ),
    ).toEqual({
      type: 'ROLL',
    });
    const car = OriginalAiPolicy.decide(
      view(g.state),
      decisionForSeat(d) as DecisionForYou,
      ctxFor(g.state, 0, d.id, { stockRatio: 0 }),
    );
    expect(car.type).toBe('ROLL');
    const bomb = editState(g.state, (x) => {
      x.players[0]!.bomb = { fuse: 14 };
      x.pools.items[4] = x.pools.items[4]! - 1;
    });
    expect(
      OriginalAiPolicy.decide(
        view(bomb),
        decisionForSeat(d) as DecisionForYou,
        ctxFor(bomb, 0, d.id, { stockRatio: 0 }),
      ),
    ).toEqual({
      type: 'ROLL',
      dice: 1,
    });
  });
});

describe('OriginalAiPolicy 自对弈：合法率 100%', () => {
  it('四个电脑在两张 fixture 上各跑一段：每个 intent 都通过 schema / ALLOWED_INTENTS，引擎全部接受', {
    timeout: 120_000,
  }, () => {
    for (const mapId of ['test', 'test-allkinds']) {
      for (const seed of ['a1', 'b2']) {
        const g = newGame({ map: mapId, seed, players: ['ai', 'ai', 'ai', 'ai'], config: { timeLimitDays: 91 } });
        let s = g.state;
        const kinds = new Set<DecisionKind>();
        for (let n = 0; n < 6000 && s.status === 'playing'; n++) {
          const d = s.pending[0]!;
          const intent = OriginalAiPolicy.decide(
            view(s),
            decisionForSeat(d) as DecisionForYou,
            ctxFor(s, d.seat, d.id),
          );
          expect(PlayerIntentSchema.safeParse(intent).success).toBe(true);
          expect(isIntentAllowed(d.kind, intent.type)).toBe(true);
          kinds.add(d.kind);
          s = g.engine.applyAction(s, { ...intent, seat: d.seat, decisionId: d.id } as GameAction).state;
        }
        expect(s.status).toBe('over');
        for (const k of ['TURN_MENU', 'BANK_ATM', 'SHOP'] as const) expect(kinds.has(k)).toBe(true);
      }
    }
  });
});
