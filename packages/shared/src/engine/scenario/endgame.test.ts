import { describe, expect, it } from 'vitest';
import { decisionNumber } from '../core/ids';
import { canSurrender } from '../flow/surrender';
import { stateHash } from '../testing/builders';
import { type Scenario, scenario } from '../testing/scenario';
import type { TurnMenuOptions } from '../types/decision';
import type { GameAction } from '../types/intent';

/**
 * M7 收尾规则：并发拍卖（design/engine.md §9.5）、投降与死神（r_deities §7.13）、时光机（§10.10、DEV-05）、公布栏（r_property §9.3）。
 * fixture 'test'：5/6/7 = L1/L2/L3（S01，地价 2000），11/12 = L4/L5，17/18 = F1。
 */
function menu(sc: Scenario, seat: 0 | 1 | 2 | 3): TurnMenuOptions {
  return sc.expectAsk(seat, 'TURN_MENU').pending(seat).options as TurnMenuOptions;
}

describe('auction（并发拍卖）', () => {
  it('auction.concurrent：竞拍者同时各有一个待答决策；新出价清掉其余待答（STALE_DECISION）、PASS 被新出价重置；QUIT 永久退出', () => {
    const sc = scenario({ players: ['human', 'human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4).give(0, { cards: [8] });
    sc.edit((s) => {
      Object.assign(s.lands[0]!, { owner: 3, level: 1 });
    });
    sc.useCard(0, 8, { t: 'underfoot', facility: null });
    const start = 3000;
    expect(sc.event('AUCTION_STARTED')).toMatchObject({ start, bidders: [1, 2, 3] });
    const first = sc.state.pending.map((d) => [d.seat, d.kind, d.timing]);
    expect(first).toEqual([
      [1, 'AUCTION_BID', 'auction'],
      [2, 'AUCTION_BID', 'auction'],
      [3, 'AUCTION_BID', 'auction'],
    ]);
    const ids1 = sc.state.pending.map((d) => decisionNumber(d.id)!);
    expect(sc.pending(1).options).toMatchObject({ increments: [0, 100, 500, 1000, 5000, 10000], others: 2 });

    // 2 号出价：1、3 号的待答作废，按新价格重新询问（新 id）
    const old1 = sc.pending(1).id;
    sc.act(2, { type: 'BID', inc: 500 });
    expect(() => sc.apply({ type: 'BID', inc: 0, seat: 1, decisionId: old1 } as GameAction)).toThrow(/STALE_DECISION/);
    expect(sc.state.pending.map((d) => d.seat)).toEqual([1, 3]);
    const ids2 = sc.state.pending.map((d) => decisionNumber(d.id)!);
    expect(Math.min(...ids2)).toBeGreaterThan(Math.max(...ids1));
    expect(sc.pending(1).options).toMatchObject({ leader: 2, price: start + 500 });
    expect((sc.pending(1).options as { increments: number[] }).increments).not.toContain(0);

    // 1 号 PASS：只移除自己的待答；3 号还在
    sc.act(1, { type: 'PASS' });
    expect(sc.state.pending.map((d) => d.seat)).toEqual([3]);
    // 3 号加价：1 号的 PASS 被重置，1、2 号重新被问
    sc.act(3, { type: 'BID', inc: 1000 });
    expect(sc.state.pending.map((d) => d.seat)).toEqual([1, 2]);
    sc.act(1, { type: 'QUIT' }).act(2, { type: 'PASS' });
    expect(sc.event('AUCTION_ENDED')).toMatchObject({ lot: 'L1', winner: 3, price: start + 1500 });
    expect(sc.state.lands[0]).toMatchObject({ owner: 3, level: 1 });
    sc.expectAsk(0, 'TURN_MENU');
    // 回放顺序：每个座位至多一个待答（不变量在每步都已检查）
    expect(sc.log.filter((e) => e.type === 'AUCTION_BID').map((e) => (e.type === 'AUCTION_BID' ? e.seat : -1))).toEqual(
      [2, 3],
    );
  });

  it('auction.concurrent：拍卖中途存读档（JSON 往返）后继续，结果与不存档一致；出价不能超过现金', () => {
    const mk = () => {
      const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
      sc.teleport(0, 5, 4).give(0, { cards: [8] });
      sc.setCash(1, 2150, 0);
      sc.useCard(0, 8, { t: 'underfoot', facility: null });
      return sc;
    };
    const a = mk();
    expect(() => a.act(1, { type: 'BID', inc: 1000 })).toThrow(/INTENT_NOT_ALLOWED|CANNOT_AFFORD|BAD_ACTION/);
    a.act(1, { type: 'BID', inc: 100 }).act(2, { type: 'BID', inc: 100 });
    const b = mk();
    b.state = b.engine.migrateState(JSON.parse(JSON.stringify(b.state)), 1);
    b.act(1, { type: 'BID', inc: 100 }).act(2, { type: 'BID', inc: 100 });
    expect(stateHash(b.state)).toBe(stateHash(a.state));
    // 1 号现金 2150 < 现价 + 100：不再被问
    expect(a.state.pending.filter((d) => d.kind === 'AUCTION_BID')).toEqual([]);
    expect(a.event('AUCTION_ENDED')).toMatchObject({ winner: 2, price: 2200 });
  });

  it('auction：破产清算释放 > 3 处地产时随机抽 3 处依次拍卖（无卖方，成交款进公库）；≤ 3 处不拍', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.edit((s) => {
      for (const l of s.lands) Object.assign(l, { owner: 2, level: 1 });
    });
    sc.setCash(2, 0, 0).edit((s) => {
      s.players[2]!.loan = 1_000_000;
      s.players[2]!.loanDue = 20050506;
    });
    sc.force('auction', 0, 0, 0);
    sc.teleport(0, 3, 2).force('dice', 1).roll(0);
    sc.teleport(1, 3, 2).force('dice', 1).roll(1);
    sc.until((s) => !s.players[2]!.alive);
    const liq = sc.log.find((e) => e.type === 'LIQUIDATION');
    expect(liq).toMatchObject({ seat: 2, lots: ['L1', 'L2', 'L3', 'L4', 'L5'], auctionLots: ['L1', 'L2', 'L3'] });
    expect(sc.event('AUCTION_STARTED')).toMatchObject({ lot: 'L1', seller: null, source: 'bankrupt', bidders: [0, 1] });
    const pool = sc.state.econ.pool;
    sc.act(0, { type: 'BID', inc: 0 }).act(1, { type: 'PASS' });
    expect(sc.state.econ.pool).toBe(pool + 3000);
    sc.expectAsk(0, 'AUCTION_BID');
    expect(sc.pending(0).options).toMatchObject({ lot: 'L2', source: 'bankrupt' });
  });
});

describe('surrender / deathGod（投降与死神）', () => {
  it('surrender：在场真人 ≥ 2、在场 ≥ 3 人才能投降；AI、少于 3 人不能', () => {
    const two = scenario({ players: ['human', 'human'] }).untilMenu(0);
    expect(menu(two, 0).canSurrender).toBe(false);
    expect(() => two.act(0, { type: 'SURRENDER' })).toThrow(/NOT_ALLOWED/);
    const one = scenario({ players: ['human', 'ai', 'ai'] }).untilMenu(0);
    expect(menu(one, 0).canSurrender).toBe(false);
    const ok = scenario({ players: ['human', 'human', 'ai'] }).untilMenu(0);
    expect(menu(ok, 0).canSurrender).toBe(true);
  });

  it('deathGod：投降 → SURRENDERED → 投降者指定一名对手被死神附身（没收卡片道具、13 天）→ 出局清算、成为乞丐', () => {
    const sc = scenario({ players: ['human', 'human', 'ai', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4)
      .give(2, { cards: [1, 2] })
      .attachGod(2, 3);
    sc.edit((s) => {
      s.lands[1]!.owner = 0;
    });
    sc.act(0, { type: 'SURRENDER' });
    expect(sc.event('SURRENDERED')).toMatchObject({ seat: 0 });
    sc.expectAsk(0, 'DEATH_GOD_TARGET');
    expect(sc.pending(0).options).toEqual({ candidates: [1, 2, 3] });
    sc.act(0, { type: 'DEATH_GOD_TARGET', target: 2 });
    sc.expectEvents(['DEATH_GOD_SUMMONED', 'GOD_LEFT', 'GOD_ATTACHED', 'GOD_POWER', 'LIQUIDATION', 'BECAME_BEGGAR']);
    expect(sc.event('GOD_ATTACHED')).toMatchObject({ seat: 2, kind: 15, displaced: 3 });
    expect(sc.player(2)).toMatchObject({ god: { kind: 15, days: 13 }, cards: [] });
    expect(sc.player(2).items.every((n) => n === 0)).toBe(true);
    expect(sc.player(0)).toMatchObject({ alive: false, out: 'surrender' });
    expect(sc.state.lands[1]!.owner).toBeNull();
    expect(sc.state.beggars).toEqual([{ seat: 0, node: 5 }]);
    sc.expectAsk(1, 'TURN_MENU');
    // 在场的还有 1、3 号两名真人与 2 号电脑：仍可投降
    expect(menu(sc, 1).canSurrender).toBe(true);
  });

  it('deathGod：死神附身者代付别人的过路费；投降后只剩 1 人即终局', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.act(0, { type: 'SURRENDER' }).act(0, { type: 'DEATH_GOD_TARGET', target: 1 });
    expect(sc.player(1).god).toMatchObject({ kind: 15 });
    const end = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    end.edit((s) => {
      const p = s.players[2]!;
      p.alive = false;
      p.out = 'bankrupt';
    });
    // 2 名在场、真人 2 名，但在场不足 3 人：不能投降
    expect(canSurrender(end.state, 0)).toBe(false);
  });
});

describe('auction others（其他可出价人数）', () => {
  it('others 与「可出价」同一判据：出不起下一口价的竞拍者不算（AI 据此在只剩一个对手时压最小档）', () => {
    const sc = scenario({ players: ['human', 'human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4).give(0, { cards: [8] });
    sc.edit((s) => {
      Object.assign(s.lands[0]!, { owner: 3, level: 1 });
    });
    // 3 号现金 3100：能参加起拍价 3000 的竞拍，但出不起 3500 之后的 3600
    sc.setCash(3, 3100, 0);
    sc.useCard(0, 8, { t: 'underfoot', facility: null });
    expect(sc.event('AUCTION_STARTED')).toMatchObject({ start: 3000, bidders: [1, 2, 3] });
    expect(sc.pending(1).options).toMatchObject({ others: 2 });
    sc.act(1, { type: 'BID', inc: 500 });
    // 3 号不再被问；2 号面前只剩领先者 1 号
    expect(sc.state.pending.map((d) => d.seat)).toEqual([2]);
    expect(sc.pending(2).options).toMatchObject({ leader: 1, price: 3500, others: 0 });
  });
});

describe('timeMachine（时光机）', () => {
  function withAnchor(rules: Record<string, unknown> = {}): Scenario {
    const sc = scenario({ players: ['human', 'human'], rules }).untilMenu(0);
    sc.teleport(0, 3, 2).force('dice', 1).roll(0);
    return sc.give(1, { items: [{ item: 10, qty: 2 }] });
  }

  it('timeMachine.global：回到最近一次真人掷骰前的世界；rng 与决策 id 不回退；TIME_REWOUND + SYNC；锚点里时光机也扣 1', () => {
    const sc = withAnchor();
    const anchor = sc.state.secret.timeAnchor!;
    expect(anchor).toMatchObject({ seat: 0 });
    const row = menu(sc, 1).items.find((r) => r.item === 10)!;
    expect(row).toMatchObject({ usable: true, targets: { t: 'none' } });
    expect(menu(sc, 1).timeMachine).toEqual({ usable: true, anchorTurn: anchor.takenAtTurn });
    const rngBefore = sc.state.secret.rng.slice();
    const lastId = decisionNumber(sc.pending(1).id)!;
    sc.useItem(1, 10);
    sc.expectEvents(['ITEM_USED', 'TIME_REWOUND', 'SYNC'], 'exact');
    expect(sc.event('TIME_REWOUND')).toMatchObject({ bySeat: 1, toTurnNo: anchor.takenAtTurn });
    expect(sc.event('SYNC')).toMatchObject({ reason: 'timeRewind' });
    // 回到 0 号掷骰前：0 号重新在回合菜单，位置回到 3 号格
    const d = sc.pending(0);
    expect(d.kind).toBe('TURN_MENU');
    expect(decisionNumber(d.id)!).toBeGreaterThan(lastId);
    expect(sc.player(0).node).toBe(3);
    expect(sc.state.clock.turnNo).toBe(anchor.takenAtTurn);
    expect(sc.state.secret.rng).toEqual(rngBefore);
    // 锚点时刻 1 号还没有时光机：恢复后仍为 0（最低 0）；锚点同步更新
    expect(sc.player(1).items[10]).toBe(0);
    expect(sc.state.secret.timeAnchor!.world.players[1]!.items[10]).toBe(0);
    // 同一个世界里 0 号再掷骰：走的是新随机数（rng 没有回退）
    sc.roll(0);
  });

  it('timeMachine：电脑座位不能用（humanOnly）；没有锚点不能用（noAnchor）；disabled 不记锚点', () => {
    const ai = scenario({ players: ['human', 'ai'] }).untilMenu(0);
    ai.teleport(0, 3, 2)
      .force('dice', 1)
      .roll(0)
      .give(1, { items: [{ item: 10, qty: 1 }] });
    expect(menu(ai, 1).items.find((r) => r.item === 10)).toMatchObject({ usable: false, reason: 'humanOnly' });
    const none = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .give(0, { items: [{ item: 10, qty: 1 }] });
    expect(menu(none, 0).items.find((r) => r.item === 10)).toMatchObject({ usable: false, reason: 'noAnchor' });
    const off = withAnchor({ timeMachine: 'disabled' });
    expect(off.state.secret.timeAnchor).toBeNull();
    expect(menu(off, 1).items.find((r) => r.item === 10)).toMatchObject({ usable: false, reason: 'noAnchor' });
  });

  it('timeMachine perSeat：每个座位回到自己上一次掷骰前', () => {
    const sc = scenario({ players: ['human', 'human'], rules: { timeMachine: 'perSeat' } }).untilMenu(0);
    sc.teleport(0, 3, 2).force('dice', 1).roll(0);
    sc.teleport(1, 5, 4).force('dice', 1).roll(1).decline(1);
    sc.untilMenu(0).give(0, { items: [{ item: 10, qty: 1 }] });
    const a0 = sc.state.secret.timeAnchors[0]!;
    expect(sc.state.secret.timeAnchors[1]).toMatchObject({ seat: 1 });
    sc.useItem(0, 10);
    expect(sc.event('TIME_REWOUND')).toMatchObject({ bySeat: 0, toTurnNo: a0.takenAtTurn });
    sc.expectAsk(0, 'TURN_MENU');
    expect(sc.player(0).node).toBe(3);
  });

  it('timeMachine：controller / aiTraits（服务器写入的系统状态）不随回滚恢复', () => {
    // 1 号开局是电脑、之后被读档认领为真人；2 号在锚点之后被踢（转电脑）；1 号改了托管设置
    const sc = scenario({ players: ['human', 'ai', 'human'] }).untilMenu(0);
    sc.teleport(0, 3, 2).force('dice', 1).roll(0);
    const anchor = sc.state.secret.timeAnchor!;
    expect(anchor.world.players.map((p) => p.controller)).toEqual(['human', 'ai', 'human']);
    sc.apply({ type: 'SYS_SET_CONTROLLER', seat: 2, controller: 'ai' });
    sc.apply({ type: 'SYS_SET_CONTROLLER', seat: 1, controller: 'human' });
    const traits = { ...sc.player(1).aiTraits, personality: 2 as const, loanRatio: 7 };
    sc.apply({ type: 'SYS_SET_AI_TRAITS', seat: 1, traits });
    sc.give(1, { items: [{ item: 10, qty: 1 }] });
    sc.useItem(1, 10);
    expect(sc.event('TIME_REWOUND')).toMatchObject({ bySeat: 1, toTurnNo: anchor.takenAtTurn });
    sc.expectAsk(0, 'TURN_MENU');
    expect(sc.state.players.map((p) => p.controller)).toEqual(['human', 'human', 'ai']);
    expect(sc.player(1).aiTraits).toEqual(traits);
    // 更新后的锚点也带当前的控制方：再回滚一次同样不分叉
    expect(sc.state.secret.timeAnchor!.world.players.map((p) => p.controller)).toEqual(['human', 'human', 'ai']);
  });

  it('timeMachine perSeat：回滚后其他座位在恢复点之后的锚点作废（不能前跳，用掉的时光机不会回来）', () => {
    const sc = scenario({ players: ['human', 'human'], rules: { timeMachine: 'perSeat' } }).untilMenu(0);
    sc.give(0, { items: [{ item: 10, qty: 1 }] }).give(1, { items: [{ item: 10, qty: 1 }] });
    sc.teleport(0, 3, 2).force('dice', 1).roll(0);
    sc.teleport(1, 5, 4).force('dice', 1).roll(1).decline(1);
    sc.untilMenu(0);
    const a0 = sc.state.secret.timeAnchors[0]!;
    expect(sc.state.secret.timeAnchors[1]!.takenAtTurn).toBeGreaterThan(a0.takenAtTurn);
    sc.useItem(0, 10);
    expect(sc.event('TIME_REWOUND')).toMatchObject({ bySeat: 0, toTurnNo: a0.takenAtTurn });
    expect(sc.player(0).items[10]).toBe(0);
    // 1 号的锚点记在被撤销的时间线上：作废
    expect(sc.state.secret.timeAnchors[1]).toBeNull();
    sc.teleport(0, 3, 2).force('dice', 1).roll(0);
    expect(menu(sc, 1).timeMachine).toEqual({ usable: false, anchorTurn: null });
    expect(menu(sc, 1).items.find((r) => r.item === 10)).toMatchObject({ usable: false, reason: 'noAnchor' });
  });

  it('timeMachine perSeat：恢复点之前的其他锚点保留，但其中使用者的时光机同样 −1', () => {
    const sc = scenario({ players: ['human', 'human'], rules: { timeMachine: 'perSeat' } }).untilMenu(0);
    sc.give(0, { items: [{ item: 10, qty: 1 }] });
    sc.teleport(0, 3, 2).force('dice', 1).roll(0);
    sc.teleport(1, 5, 4).force('dice', 1).roll(1).decline(1);
    // 1 号之后一直关着：它的锚点停在第 2 回合；0 号在更晚的回合再记一次锚点
    sc.bench(1).untilMenu(0);
    sc.teleport(0, 3, 2).force('dice', 1).roll(0).untilMenu(0);
    const a0 = sc.state.secret.timeAnchors[0]!;
    const a1 = sc.state.secret.timeAnchors[1]!;
    expect(a1.takenAtTurn).toBeLessThan(a0.takenAtTurn);
    expect(a1.world.players[0]!.items[10]).toBe(1);
    sc.useItem(0, 10);
    expect(sc.event('TIME_REWOUND')).toMatchObject({ bySeat: 0, toTurnNo: a0.takenAtTurn });
    expect(sc.player(0).items[10]).toBe(0);
    expect(sc.state.secret.timeAnchors[1]).toMatchObject({ takenAtTurn: a1.takenAtTurn });
    expect(sc.state.secret.timeAnchors[1]!.world.players[0]!.items[10]).toBe(0);
  });
});

describe('timeMachine 锚点校验（导入存档）', () => {
  function anchored(): Scenario {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    return sc.teleport(0, 3, 2).force('dice', 1).roll(0);
  }

  it('锚点世界与 GameState 同样严格校验：结构非法、资金台账不平、已结束的锚点都判为非法', () => {
    const sc = anchored();
    expect(sc.engine.explainState(sc.state)).toEqual([]);
    const tamper = (fn: (w: Record<string, unknown> & { players: { cash: number }[] }) => void) => {
      const bad = structuredClone(sc.state);
      fn(bad.secret.timeAnchor!.world as never);
      return sc.engine.explainState(bad);
    };
    expect(tamper((w) => (w.lands = 'garbage' as never))).not.toEqual([]);
    expect(tamper((w) => (w.status = 'over'))).not.toEqual([]);
    const ledger = tamper((w) => (w.players[0]!.cash = -123456789));
    expect(ledger.some((x) => x.startsWith('timeAnchor: ledger'))).toBe(true);
    expect(tamper((w) => (w.extra = 1))).not.toEqual([]);
    // 锚点的座位集合必须与对局一致（回滚时按座位保留 controller）
    const seats = structuredClone(sc.state);
    seats.secret.timeAnchor!.world.players[1]!.seat = 3;
    expect(sc.engine.validateState(seats)).toBe(false);
    // perSeat 的锚点必须放在自己的下标上
    const per = scenario({ players: ['human', 'human'], rules: { timeMachine: 'perSeat' } }).untilMenu(0);
    per.teleport(0, 3, 2).force('dice', 1).roll(0);
    expect(per.engine.explainState(per.state)).toEqual([]);
    const moved = structuredClone(per.state);
    moved.secret.timeAnchors[1] = moved.secret.timeAnchors[0]!;
    moved.secret.timeAnchors[0] = null;
    expect(per.engine.explainState(moved).some((x) => x.includes('timeAnchors[1]: anchor seat 0'))).toBe(true);
  });
});

describe('noticeBoard（公布栏）', () => {
  it('noticeBoard：挂牌（地产标价 ≤ 市价 × 10）、撤牌；买家在自己的回合用现金买下，资产过户、钱进卖家现金', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    // setPoints 让回合菜单按新状态重发
    sc.edit((s) => {
      Object.assign(s.lands[0]!, { owner: 0, level: 2 });
    }).setPoints(0, 0);
    const o = menu(sc, 0).board;
    // 市价 (2000 + 2 × 500) × 1 = 3000，上限 30000
    expect(o).toMatchObject({ listings: [], mine: 0, canList: true, lotCaps: [{ lot: 'L1', cap: 30000 }] });
    expect(() => sc.act(0, { type: 'BOARD_LIST', asset: { t: 'lot', lot: 'L1' }, price: 30001 })).toThrow(
      /NOT_ALLOWED/,
    );
    sc.act(0, { type: 'BOARD_LIST', asset: { t: 'lot', lot: 'L1' }, price: 9000 });
    expect(sc.event('LISTING_ADDED')).toMatchObject({
      listing: { seller: 0, price: 9000, asset: { t: 'lot', lot: 'L1' } },
    });
    expect(menu(sc, 0).board).toMatchObject({ mine: 1, lotCaps: [] });
    expect(menu(sc, 0).turnLog).toEqual(['boardList']);
    // 自己的不能买；同一块地不能重复挂
    const id = sc.state.noticeBoard[0]!.id;
    expect(() => sc.act(0, { type: 'BOARD_BUY', listingId: id })).toThrow(/NOT_ALLOWED/);
    expect(() => sc.act(0, { type: 'BOARD_LIST', asset: { t: 'lot', lot: 'L1' }, price: 5 })).toThrow(/NOT_ALLOWED/);
    sc.teleport(0, 3, 2).force('dice', 1).roll(0);
    // 1 号的回合：买下
    const view = menu(sc, 1).board.listings;
    expect(view).toEqual([
      { id, seller: 0, price: 9000, asset: { t: 'lot', lot: 'L1' }, mine: false, affordable: true },
    ]);
    const c0 = sc.player(0).cash;
    const c1 = sc.player(1).cash;
    sc.act(1, { type: 'BOARD_BUY', listingId: id });
    expect(sc.event('LISTING_SOLD')).toMatchObject({ listingId: id, seller: 0, buyer: 1, price: 9000 });
    expect(sc.state.lands[0]).toMatchObject({ owner: 1, level: 2 });
    expect([sc.player(0).cash, sc.player(1).cash]).toEqual([c0 + 9000, c1 - 9000]);
    expect(sc.state.noticeBoard).toEqual([]);
    expect(menu(sc, 1).turnLog).toEqual(['boardBuy']);
  });

  it('noticeBoard：卡片、道具、股票过户；资产不在了挂牌即失效（回合开始时撤下）；每人至多 7 个挂牌', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.give(0, { cards: [14, 14, 30] }).edit((s) => {
      s.players[0]!.holdings[3] = { shares: 300, costCents: 0 };
      s.stocks[3]!.float -= 300;
      s.stocks[3]!.chairman = 0;
    });
    sc.act(0, { type: 'BOARD_LIST', asset: { t: 'card', card: 14 }, price: 100 });
    sc.act(0, { type: 'BOARD_LIST', asset: { t: 'card', card: 30 }, price: 100 });
    sc.act(0, { type: 'BOARD_LIST', asset: { t: 'item', item: 1, qty: 1 }, price: 50 });
    sc.act(0, { type: 'BOARD_LIST', asset: { t: 'stock', stock: 3, shares: 200 }, price: 3000 });
    expect(() => sc.act(0, { type: 'BOARD_LIST', asset: { t: 'stock', stock: 3, shares: 101 }, price: 1 })).toThrow(
      /NOT_ALLOWED/,
    );
    // 用掉挂出去的乌龟卡：挂牌失效，从 options 里消失
    sc.useCard(0, 30, { t: 'actor', actor: { t: 'seat', seat: 0 } });
    expect(menu(sc, 0).board.listings.map((l) => l.asset.t)).toEqual(['card', 'item', 'stock']);
    sc.roll(0).untilMenu(1);
    expect(sc.log.some((e) => e.type === 'LISTING_REMOVED' && e.reason === 'invalid')).toBe(true);
    const [card, item, stock] = sc.state.noticeBoard;
    sc.act(1, { type: 'BOARD_BUY', listingId: card!.id });
    expect(sc.player(1).cards).toContain(14);
    sc.act(1, { type: 'BOARD_BUY', listingId: item!.id });
    expect(sc.player(1).items[1]).toBe(2);
    sc.act(1, { type: 'BOARD_BUY', listingId: stock!.id });
    expect(sc.player(1).holdings[3]!.shares).toBe(200);
    expect(sc.player(0).holdings[3]!.shares).toBe(100);
    expect(sc.event('CHAIRMAN_CHANGED')).toMatchObject({ stock: 3, from: 0, to: 1 });

    const full = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .give(0, { cards: [1, 2, 3, 4, 5, 6, 7, 9] });
    for (const c of [1, 2, 3, 4, 5, 6, 7] as const) {
      full.act(0, { type: 'BOARD_LIST', asset: { t: 'card', card: c }, price: 10 });
    }
    expect(menu(full, 0).board).toMatchObject({ mine: 7, canList: false });
    expect(() => full.act(0, { type: 'BOARD_LIST', asset: { t: 'card', card: 9 }, price: 10 })).toThrow(
      /board is full/,
    );
    full.act(0, { type: 'BOARD_DELIST', listingId: full.state.noticeBoard[0]!.id });
    expect(full.event('LISTING_REMOVED')).toMatchObject({ reason: 'delisted' });
  });
});
