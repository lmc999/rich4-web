/**
 * 测试与脚本用的构造器（@rich4/shared/engine-testing；只能在测试、scripts 中使用）。
 *
 *   const { engine, state } = newGame({ players: ['human', 'ai'], config: { timeLimitDays: 30 } });
 *   const next = act(engine, state, 0, { type: 'ROLL' });
 */
import type { DataRegistry } from '../../data/maps/registry';
import { fixtureRegistry } from '../../data/maps/registry';
import { canonicalJson } from '../../util/canonicalJson';
import { fnv1a64 } from '../../util/hash';
import { type ApplyResult, type EngineInternalApi, internal } from '../api';
import { EngineRuleError } from '../errors';
import { defaultGameConfig, type GameConfig, type PlayerSetup, type RuleConfig } from '../types/config';
import type { PendingDecision } from '../types/decision';
import type { CharacterId, Controller, DateNum, SeatIndex } from '../types/ids';
import type { GameAction, PlayerIntent } from '../types/intent';
import type { GameState } from '../types/state';

export const TEST_SEED = 'c0ffee';
export const TEST_START_DATE: DateNum = 20050505;
/** 默认角色：孙小美、阿土伯、约翰乔、钱夫人 */
export const DEFAULT_CHARACTERS: readonly CharacterId[] = Object.freeze([9, 4, 0, 3]);

export interface TestEngineOptions {
  registry?: DataRegistry;
  /** 默认 true：deepFreeze 入参 + 出现 SYNC 即抛错 */
  devChecks?: boolean;
}

export function testEngine(o: TestEngineOptions = {}): EngineInternalApi {
  return internal.createEngine(o.registry ?? fixtureRegistry, { devChecks: o.devChecks ?? true });
}

/** 按顺序给出 seat 0..n-1 的座位（角色取 DEFAULT_CHARACTERS） */
export function makeSetups(controllers: readonly Controller[]): PlayerSetup[] {
  return controllers.map((controller, i) => ({
    seat: i as SeatIndex,
    character: DEFAULT_CHARACTERS[i] ?? (i as CharacterId),
    controller,
  }));
}

export interface NewGameOptions extends TestEngineOptions {
  map?: string;
  /** 控制方列表（seat 按顺序）或完整的 PlayerSetup；默认 ['human', 'ai'] */
  players?: readonly Controller[] | readonly PlayerSetup[];
  seed?: string;
  config?: Partial<Omit<GameConfig, 'rules'>>;
  rules?: Partial<RuleConfig>;
  /** 默认 true（允许 SYS_DEBUG） */
  debug?: boolean;
}

export function makeConfig(o: NewGameOptions = {}): GameConfig {
  const c = defaultGameConfig(o.map ?? 'test', TEST_START_DATE);
  Object.assign(c, o.config ?? {});
  c.rules = { ...c.rules, ...(o.rules ?? {}) };
  c.debug = o.debug ?? true;
  return c;
}

function toSetups(p: NewGameOptions['players']): PlayerSetup[] {
  if (!p) return makeSetups(['human', 'ai']);
  if (p.length > 0 && typeof p[0] === 'object') return (p as readonly PlayerSetup[]).map((x) => ({ ...x }));
  return makeSetups(p as readonly Controller[]);
}

export interface NewGame extends ApplyResult {
  engine: EngineInternalApi;
}

export function newGame(o: NewGameOptions = {}): NewGame {
  const engine = testEngine(o);
  const r = engine.createGameWithEvents(makeConfig(o), toSetups(o.players), o.seed ?? TEST_SEED);
  return { engine, ...r };
}

/** 深拷贝后就地修改（用于布置 SYS_DEBUG 覆盖不到的局面，例如关押计数） */
export function editState(state: GameState, fn: (draft: GameState) => void): GameState {
  const draft = structuredClone(state);
  fn(draft);
  return draft;
}

export function pendingOf(state: GameState, seat: SeatIndex): PendingDecision | null {
  return state.pending.find((d) => d.seat === seat) ?? null;
}

/** 以 seat 回答它当前的决策 */
export function act(engine: EngineInternalApi, state: GameState, seat: SeatIndex, intent: PlayerIntent): ApplyResult {
  const d = pendingOf(state, seat);
  if (!d) throw new EngineRuleError('STALE_DECISION', `seat ${seat} has no pending decision`);
  return engine.applyAction(state, { ...intent, seat, decisionId: d.id } as GameAction);
}

/** 规范化 JSON 的 FNV-1a 64（确定性比较用） */
export function stateHash(state: unknown): string {
  return fnv1a64(canonicalJson(state));
}
