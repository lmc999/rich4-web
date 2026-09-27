/**
 * 场景 DSL（design/engine.md §16.3）：固定种子 + SYS_DEBUG 强制结果，链式、立即执行。
 *
 *   scenario({ players: ['human', 'human'] })
 *     .untilMenu(0)
 *     .teleport(0, 4, 3).force('dice', 1)
 *     .roll(0)
 *     .expectAsk(0, 'BUY_LAND').confirm(0)
 *     .expect((s) => expect(s.lands[0].owner).toBe(0))
 *     .expectEvents(['DICE_ROLLED', 'MOVE_SEGMENT', 'LANDED']);
 *
 * 每个动作后可选跑 validateState（默认开启），不变量不成立立即抛错。
 */

import type { DataRegistry } from '../../data/maps/registry';
import { fixtureRegistry } from '../../data/maps/registry';
import { GODS } from '../../data/tables/gods';
import type { EngineInternalApi } from '../api';
import type { DecisionKind, PendingDecision } from '../types/decision';
import type { GameEvent, GameEventType } from '../types/events';
import type { CardId, GodKind, ItemId, RandPurpose, SeatIndex, TileId } from '../types/ids';
import type { DebugOp, GameAction, PlayerIntent, UseTarget } from '../types/intent';
import type { GameState, PlayerState, RoadObjectKind } from '../types/state';
import { type NewGameOptions, newGame, pendingOf } from './builders';
import { dbg, sysDebug } from './debug';

export interface ScenarioOptions extends NewGameOptions {
  /** 每步之后做 explainState（默认 true） */
  checkInvariants?: boolean;
}

/** 场景默认用干净的棋盘（board: 'clear'）：路上的神明、礼物、宝箱不会干扰强制结果；需要物件时用 edit 摆放 */

export class ScenarioError extends Error {
  override name = 'ScenarioError';
}

export class Scenario {
  readonly engine: EngineInternalApi;
  state: GameState;
  /** 最近一个 action 的事件 */
  events: GameEvent[];
  /** 从开局起的全部事件 */
  readonly log: GameEvent[] = [];
  private readonly check: boolean;

  private readonly registry: DataRegistry;

  constructor(o: ScenarioOptions = {}) {
    const g = newGame({ board: 'clear', ...o });
    this.registry = o.registry ?? fixtureRegistry;
    this.engine = g.engine;
    this.state = g.state;
    this.events = g.events;
    this.log.push(...g.events);
    this.check = o.checkInvariants ?? true;
    this.verify('createGame');
  }

  private verify(what: string): void {
    if (!this.check) return;
    const bad = this.engine.explainState(this.state);
    if (bad.length > 0) throw new ScenarioError(`invariants broken after ${what}:\n  ${bad.join('\n  ')}`);
  }

  /** 提交任意 action */
  apply(action: GameAction): this {
    const r = this.engine.applyAction(this.state, action);
    this.state = r.state;
    this.events = r.events;
    this.log.push(...r.events);
    this.verify(action.type);
    return this;
  }

  debug(op: DebugOp): this {
    return this.apply(sysDebug(op));
  }

  force(purpose: RandPurpose, ...values: number[]): this {
    return this.apply(dbg.forceNext(purpose, ...values));
  }

  setCash(seat: SeatIndex, cash: number, deposit: number | null = null): this {
    return this.apply(dbg.setCash(seat, cash, deposit));
  }

  setPoints(seat: SeatIndex, points: number): this {
    return this.apply(dbg.setPoints(seat, points));
  }

  teleport(seat: SeatIndex, node: TileId, prev?: TileId): this {
    return this.apply(dbg.teleport(seat, node, prev));
  }

  give(seat: SeatIndex, g: { cards?: CardId[]; items?: { item: ItemId; qty: number }[] }): this {
    return this.apply(dbg.give(seat, g.cards ?? [], g.items ?? []));
  }

  /** 直接改 state（布置 SYS_DEBUG 覆盖不到的局面）；之后照常校验不变量 */
  edit(fn: (draft: GameState) => void): this {
    const draft = structuredClone(this.state);
    fn(draft);
    this.state = draft;
    this.verify('edit');
    return this;
  }

  // ───────────────────────── M6：路面物件、神明、用卡用道具 ─────────────────────────

  /** 把某种神放到路上（搭档一并收走，保持「每对至多一个在场」） */
  placeGod(kind: GodKind, node: TileId): this {
    return this.edit((s) => {
      const def = GODS[kind];
      for (const g of s.gods) {
        if (g.kind === def.partner && g.where.t === 'road') g.where = { t: 'absent' };
      }
      const slot = s.gods.find((g) => g.kind === kind && g.where.t !== 'attached');
      if (!slot) throw new ScenarioError(`no free slot for god ${kind}`);
      slot.where = { t: 'road', node };
    });
  }

  /** 让 seat 直接附身某种神（不发威；搭档一并收走） */
  attachGod(seat: SeatIndex, kind: GodKind, days?: number): this {
    return this.edit((s) => {
      const def = GODS[kind];
      for (const g of s.gods) {
        if ((g.kind === def.partner || g.kind === kind) && g.where.t === 'road') g.where = { t: 'absent' };
      }
      const slot = s.gods.find((g) => g.kind === kind && g.where.t === 'absent');
      if (!slot) throw new ScenarioError(`no free slot for god ${kind}`);
      const p = s.players.find((x) => x.seat === seat)!;
      slot.where = { t: 'attached', seat };
      p.god = { kind, days: days ?? def.days };
      p.luck = {
        bad: p.luck.bad + def.luck.bad,
        wealth: p.luck.wealth + def.luck.wealth,
        fortune: p.luck.fortune + def.luck.fortune,
      };
    });
  }

  /** 在格上放一个路面物件（路障、地雷、炸弹从共享库存扣）；返回物件 id 写进 lastObjectId */
  placeObject(kind: RoadObjectKind, node: TileId, placedBy: SeatIndex | null = null): this {
    return this.edit((s) => {
      s.counters.object += 1;
      const item = kind === 'roadblock' ? 2 : kind === 'mine' ? 3 : kind === 'bomb' ? 4 : null;
      if (item !== null) s.pools.items[item] = s.pools.items[item]! - 1;
      s.objects.push({ id: s.counters.object, kind, node, placedBy });
      this.lastObjectId = s.counters.object;
    });
  }

  /** 最近一次 placeObject 的物件 id */
  lastObjectId = 0;

  // ───────────────────────── M7：牌堆、闲置座位 ─────────────────────────

  /**
   * 让新闻 / 命运牌堆接下来依次抽到 ids（把它们换到游标处，牌序仍是 36 / 37 张的排列）。
   * 命运抽到后还会按座驾替换、不可行就跳过，与正式抽牌相同。
   */
  stackDeck(kind: 'news' | 'fate', ids: readonly number[]): this {
    return this.debug({ op: 'stackDeck', deck: kind, ids: ids.slice() });
  }

  /**
   * 把座位关进监狱 days 天（放在关押格），让它在后续回合里一直受阻、不走动也不触发格子事件：
   * 旧的经济场景用它排除其他座位的新闻、命运、魔法屋对断言的干扰。
   */
  bench(seat: SeatIndex, days = 100): this {
    const hold = this.engineMapHold();
    return this.edit((s) => {
      const p = s.players.find((x) => x.seat === seat)!;
      if (p.st.jail === 0) p.savedPrevNode = p.prevNode;
      p.st.jail = days;
      p.placed = true;
      p.node = hold;
      p.prevNode = hold;
    });
  }

  private engineMapHold(): TileId {
    return this.registry.getMap(this.state.dataRef.mapId).jailHold;
  }

  /** 以 seat 在 TURN_MENU 用手里的第一张 card */
  useCard(seat: SeatIndex, card: CardId, target: UseTarget = { t: 'none' }): this {
    const slot = this.player(seat).cards.indexOf(card);
    if (slot < 0) throw new ScenarioError(`seat ${seat} has no card ${card}`);
    return this.act(seat, { type: 'USE_CARD', slot, card, target });
  }

  useItem(seat: SeatIndex, item: ItemId, target: UseTarget = { t: 'none' }): this {
    return this.act(seat, { type: 'USE_ITEM', item, target });
  }

  pending(seat: SeatIndex): PendingDecision {
    const d = pendingOf(this.state, seat);
    if (!d) throw new ScenarioError(`seat ${seat} has no pending decision (pending: ${this.describePending()})`);
    return d;
  }

  private describePending(): string {
    return this.state.pending.map((d) => `${d.seat}:${d.kind}`).join(', ') || 'none';
  }

  expectAsk(seat: SeatIndex, kind: DecisionKind): this {
    const d = this.pending(seat);
    if (d.kind !== kind) throw new ScenarioError(`seat ${seat} is asked ${d.kind}, expected ${kind}`);
    return this;
  }

  expectNoAsk(seat: SeatIndex, kind?: DecisionKind): this {
    const d = pendingOf(this.state, seat);
    if (d && (kind === undefined || d.kind === kind))
      throw new ScenarioError(`seat ${seat} is unexpectedly asked ${d.kind}`);
    return this;
  }

  act(seat: SeatIndex, intent: PlayerIntent): this {
    const d = this.pending(seat);
    return this.apply({ ...intent, seat, decisionId: d.id } as GameAction);
  }

  roll(seat: SeatIndex, dice?: 1 | 2 | 3): this {
    return this.act(seat, dice === undefined ? { type: 'ROLL' } : { type: 'ROLL', dice });
  }

  confirm(seat: SeatIndex): this {
    return this.act(seat, { type: 'CONFIRM' });
  }

  decline(seat: SeatIndex): this {
    return this.act(seat, { type: 'DECLINE' });
  }

  /** 用 defaultIntent 回答当前的决策（一次） */
  pass(): this {
    const d = this.state.pending[0];
    if (!d) throw new ScenarioError('no pending decision');
    return this.apply({ ...d.defaultIntent, seat: d.seat, decisionId: d.id } as GameAction);
  }

  /** 一直用 defaultIntent 推进，直到 seat 出现 TURN_MENU（最多 maxSteps 步） */
  untilMenu(seat: SeatIndex, maxSteps = 500): this {
    for (let i = 0; i < maxSteps; i++) {
      if (this.state.status !== 'playing') throw new ScenarioError('game ended before the menu');
      const d = pendingOf(this.state, seat);
      if (d?.kind === 'TURN_MENU') return this;
      this.pass();
    }
    throw new ScenarioError(`seat ${seat} did not reach TURN_MENU within ${maxSteps} steps`);
  }

  /** 一直用 defaultIntent 推进，直到 pred 成立 */
  until(pred: (s: GameState) => boolean, maxSteps = 5000): this {
    for (let i = 0; i < maxSteps; i++) {
      if (pred(this.state)) return this;
      if (this.state.status !== 'playing') throw new ScenarioError('game ended before the condition held');
      this.pass();
    }
    throw new ScenarioError(`condition not met within ${maxSteps} steps`);
  }

  expect(fn: (s: GameState, sc: this) => void): this {
    fn(this.state, this);
    return this;
  }

  /** 最近一个 action 的事件类型：contains = 按顺序作为子序列出现；exact = 完全相同 */
  expectEvents(types: readonly GameEventType[], mode: 'contains' | 'exact' = 'contains'): this {
    const got = this.events.map((e) => e.type);
    if (mode === 'exact') {
      if (got.join(',') !== types.join(',')) throw new ScenarioError(`events ${got.join(',')} != ${types.join(',')}`);
      return this;
    }
    let j = 0;
    for (const t of got) if (t === types[j]) j++;
    if (j < types.length) throw new ScenarioError(`events ${got.join(',')} do not contain ${types.join(',')} in order`);
    return this;
  }

  /** 最近一个 action 里某类事件（第一个） */
  event<T extends GameEventType>(type: T): Extract<GameEvent, { type: T }> {
    const e = this.events.find((x) => x.type === type);
    if (!e) throw new ScenarioError(`no ${type} in ${this.events.map((x) => x.type).join(',')}`);
    return e as Extract<GameEvent, { type: T }>;
  }

  player(seat: SeatIndex): PlayerState {
    const p = this.state.players.find((x) => x.seat === seat);
    if (!p) throw new ScenarioError(`no player at seat ${seat}`);
    return p;
  }
}

export function scenario(o: ScenarioOptions = {}): Scenario {
  return new Scenario(o);
}
