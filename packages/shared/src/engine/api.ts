/**
 * EngineApi 契约与实现（architecture §5.2；design/engine.md §13）。
 *
 * 约束：
 * - 全部同步执行；入参 state 不会被修改（devChecks 下 deepFreeze 入参，误写立即抛 TypeError）。
 * - 非法 action 抛 EngineRuleError{rule}；内部缺陷抛 EngineInvariantError。
 * - 每个座位同一时刻至多 1 个 pending；决策 id 确定且单调递增，时光机回滚也不回退。
 * - applyAction p50 < 5ms（structuredClone 草稿 + 帧栈解释器）。
 *
 * 用法：
 *   const engine = createEngine(fixtureRegistry);
 *   let state = engine.createGame(defaultGameConfig('test', 20260927), players, 'c0ffee');
 *   const [d] = engine.getPendingDecisions(state);                       // TURN_MENU
 *   ({ state, events } = engine.applyAction(state, { type: 'ROLL', seat: d.seat, decisionId: d.id }));
 */
import type { DataRegistry } from '../data/maps/registry';
import { cloneState, deepFreeze } from './core/clone';
import { Ctx, snapshotBaseline } from './core/ctx';
import { executeAction, run } from './core/flow';
import { engineMap } from './core/mapCache';
import { publicWorld } from './core/postPatch';
import { createInitialState } from './core/setup';
import { migrateState } from './migrate/index';
import type { GameConfig, PlayerSetup } from './types/config';
import type { PendingDecision } from './types/decision';
import type { GameEvent } from './types/events';
import type { GameAction } from './types/intent';
import type { GameResult, GameState } from './types/state';
import { checkInvariants, explainState, validateStateWith } from './validate/index';
import { ENGINE_VERSION, STATE_SCHEMA_VERSION } from './version';

export interface ApplyResult {
  state: GameState;
  events: GameEvent[];
}

export interface EngineApi {
  readonly ENGINE_VERSION: string;
  readonly STATE_SCHEMA_VERSION: number;
  /** seedHex：服务器生成的 hex 种子（randomBytes(16)）；运行到第一个待决策为止 */
  createGame(config: GameConfig, players: PlayerSetup[], seedHex: string): GameState;
  /** 非法时抛 EngineRuleError{rule} */
  applyAction(state: GameState, action: GameAction): ApplyResult;
  /** 数组，可以多人并发（拍卖）；游戏结束时为 [] */
  getPendingDecisions(state: GameState): PendingDecision[];
  getResult(state: GameState): GameResult | null;
  /** zod 结构校验 + 不变量（design/engine.md §15） */
  validateState(state: unknown): state is GameState;
  migrateState(state: unknown, fromVersion: number): GameState;
}

/** 只给 scripts/simulate、bench 与 fuzz 用的扩展 */
export interface EngineInternalApi extends EngineApi {
  /** 原地执行、不克隆（入参被修改；抛错时入参可能处于中间状态，调用方应丢弃它） */
  applyInPlace(state: GameState, action: GameAction): GameEvent[];
  /** createGame 并返回开局到第一个决策之间的事件（GAME_STARTED、TURN_STARTED、PARACHUTE…） */
  createGameWithEvents(config: GameConfig, players: PlayerSetup[], seedHex: string): ApplyResult;
  /** validateState 的详细版：列出结构错误与不变量违反项（空数组表示合法） */
  explainState(state: unknown): string[];
  /** 只查不变量、不做 zod 结构校验（模拟脚本逐步检查用，约为 explainState 一半的开销） */
  checkInvariants(state: GameState): string[];
}

export interface EngineOptions {
  /**
   * 开发 / 测试模式：deepFreeze applyAction 的入参；出现 SYNC（未经事件公布的公开变化）时抛
   * EngineInvariantError('UNANNOUNCED_CHANGE')。默认 false（生产路径）。
   */
  devChecks?: boolean;
}

function build(reg: DataRegistry, opts: EngineOptions): EngineInternalApi {
  const dev = opts.devChecks === true;
  const ctxOpts = { strictSync: dev };
  const mapOf = (s: GameState) => engineMap(reg.getMap(s.dataRef.mapId, s.dataRef.mapHash));

  function createGameWithEvents(config: GameConfig, players: PlayerSetup[], seedHex: string): ApplyResult {
    const { s, em } = createInitialState(reg, config, players, seedHex);
    const ctx = new Ctx(s, em, snapshotBaseline(s), ctxOpts);
    ctx.emit('GAME_STARTED', { seats: s.players.map((p) => p.seat), date: s.clock.date });
    run(ctx);
    ctx.flushSync();
    return { state: s, events: ctx.events };
  }

  return {
    ENGINE_VERSION,
    STATE_SCHEMA_VERSION,
    createGame(config, players, seedHex) {
      return createGameWithEvents(config, players, seedHex).state;
    },
    createGameWithEvents,
    applyAction(state, action) {
      if (dev) deepFreeze(state);
      const s = cloneState(state);
      // 基线直接引用入参里的公开实体：它们不会被修改（草稿是克隆），emit 时只替换引用
      const ctx = new Ctx(s, mapOf(state), publicWorld(state), ctxOpts);
      executeAction(ctx, action);
      return { state: s, events: ctx.events };
    },
    applyInPlace(state, action) {
      const ctx = new Ctx(state, mapOf(state), snapshotBaseline(state), ctxOpts);
      executeAction(ctx, action);
      return ctx.events;
    },
    getPendingDecisions(state) {
      return state.status === 'playing' ? state.pending.slice() : [];
    },
    getResult(state) {
      return state.result;
    },
    validateState(state: unknown): state is GameState {
      return validateStateWith(reg, state);
    },
    explainState(state) {
      return explainState(reg, state);
    },
    checkInvariants(state) {
      return checkInvariants(state, mapOf(state));
    },
    migrateState(state, fromVersion) {
      return migrateState(state, fromVersion);
    },
  };
}

/** 服务器正式路径：createEngine(registry).applyAction */
export function createEngine(reg: DataRegistry, opts: EngineOptions = {}): EngineApi {
  const e = build(reg, opts);
  return {
    ENGINE_VERSION: e.ENGINE_VERSION,
    STATE_SCHEMA_VERSION: e.STATE_SCHEMA_VERSION,
    createGame: e.createGame,
    applyAction: e.applyAction,
    getPendingDecisions: e.getPendingDecisions,
    getResult: e.getResult,
    validateState: e.validateState,
    migrateState: e.migrateState,
  };
}

/** internal.createEngine 只给 simulate、bench 与 fuzz 使用；服务器正式路径必须用 createEngine().applyAction */
export const internal = Object.freeze({
  createEngine(reg: DataRegistry, opts: EngineOptions = {}): EngineInternalApi {
    return build(reg, opts);
  },
});
