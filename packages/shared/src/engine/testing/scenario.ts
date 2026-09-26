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

import type { EngineInternalApi } from '../api';
import type { DecisionKind, PendingDecision } from '../types/decision';
import type { GameEvent, GameEventType } from '../types/events';
import type { CardId, ItemId, RandPurpose, SeatIndex, TileId } from '../types/ids';
import type { DebugOp, GameAction, PlayerIntent } from '../types/intent';
import type { GameState, PlayerState } from '../types/state';
import { type NewGameOptions, newGame, pendingOf } from './builders';
import { dbg, sysDebug } from './debug';

export interface ScenarioOptions extends NewGameOptions {
  /** 每步之后做 explainState（默认 true） */
  checkInvariants?: boolean;
}

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

  constructor(o: ScenarioOptions = {}) {
    const g = newGame(o);
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
