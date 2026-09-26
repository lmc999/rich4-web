/**
 * GameRunner 单测夹具：stubEngine + ManualScheduler + 记录所有 hooks。
 */
import type { AiPolicy } from '@rich4/shared/ai';
import { fixtureRegistry } from '@rich4/shared/data';
import {
  defaultGameConfig,
  type EngineApi,
  type GameConfig,
  type PendingDecision,
  type PlayerSetup,
  type SeatIndex,
} from '@rich4/shared/engine';
import type { GameOverMsg } from '@rich4/shared/net';
import type { SeatControl } from '@rich4/shared/view';
import { AiDriver } from '../../src/game/AiDriver';
import { DEFAULT_TIMING, type TimingOptions } from '../../src/game/Deadlines';
import { GameRunner, type RawBatch, type RunnerSettings, type SeatInit } from '../../src/game/GameRunner';
import { silentLogger } from '../../src/infra/logger';
import { localPolicy } from './localPolicy';
import { ManualScheduler } from './manualScheduler';
import { createStubEngine } from './stubEngine';

export const TEST_SEED = '00112233445566778899aabbccddeeff';

export interface HarnessOptions {
  players?: PlayerSetup[];
  settings?: Partial<RunnerSettings>;
  config?: Partial<GameConfig>;
  policy?: AiPolicy;
  timing?: Partial<TimingOptions>;
  thinkMs?: readonly [number, number];
  seats?: SeatInit[];
  /** 包装引擎（故障注入）：createGame 仍用原引擎，runner 使用包装后的 */
  wrapEngine?: (e: EngineApi) => EngineApi;
  /** 让 hooks.batch 在记录之后抛出（模拟投影 / 广播故障）；返回 true 时抛 */
  batchThrows?: (raw: RawBatch) => boolean;
}

export interface HarnessRecord {
  batches: RawBatch[];
  pendingChanged: number;
  controls: { seat: SeatIndex; control: SeatControl; prev: SeatControl }[];
  over: GameOverMsg[];
  stuck: SeatIndex[];
  timedOut: { seat: SeatIndex; by: 'default' | 'ai' }[];
  dayEnds: number;
  faults: (SeatIndex | null)[];
}

export function fourHumans(): PlayerSetup[] {
  return ([0, 1, 2, 3] as const).map((seat) => ({ seat, character: seat, controller: 'human' as const }));
}

export function makeRunner(o: HarnessOptions = {}) {
  const sched = new ManualScheduler();
  const engine = createStubEngine();
  const config: GameConfig = { ...defaultGameConfig('test', 20260927), initialFund: 30000, debug: true, ...o.config };
  const players = o.players ?? fourHumans();
  const state = engine.createGame(config, players, TEST_SEED);
  const settings: RunnerSettings = {
    handVisibility: 'public',
    timerPreset: 'normal',
    timeoutPolicy: 'default',
    aiPace: 'normal',
    allowMinigameDecline: true,
    reconnectGraceSec: 15,
    ...o.settings,
  };
  const rec: HarnessRecord = {
    batches: [],
    pendingChanged: 0,
    controls: [],
    over: [],
    stuck: [],
    timedOut: [],
    dayEnds: 0,
    faults: [],
  };
  const think = o.thinkMs ?? [0, 0];
  const ai = new AiDriver({
    policy: o.policy ?? localPolicy,
    log: silentLogger,
    random: () => 0,
    thinkMs: { normal: think, fast: think },
  });
  const timing: TimingOptions = { ...DEFAULT_TIMING, ...o.timing };
  const runner = new GameRunner(
    {
      engine: o.wrapEngine ? o.wrapEngine(engine) : engine,
      data: fixtureRegistry,
      clock: sched,
      scheduler: sched,
      log: silentLogger,
      ai,
      timing,
      settings: () => settings,
      hooks: {
        batch: (raw) => {
          rec.batches.push(raw);
          if (o.batchThrows?.(raw)) throw new Error('injected broadcast failure');
        },
        pendingChanged: () => {
          rec.pendingChanged++;
        },
        controlChanged: (seat, control, prev) => rec.controls.push({ seat, control, prev }),
        gameOver: (msg) => rec.over.push(msg),
        dayEnd: () => {
          rec.dayEnds++;
        },
        timedOut: (seat, by) => rec.timedOut.push({ seat, by }),
        aiStuck: (seat) => rec.stuck.push(seat),
        fault: (seat) => {
          rec.faults.push(seat);
          runner.pause();
        },
      },
    },
    {
      epoch: 1,
      state,
      seats:
        o.seats ??
        players.map((p) => ({ seat: p.seat, control: p.controller === 'ai' ? 'ai' : 'human', connected: true })),
    },
  );
  runner.begin();

  const pendingOf = (seat: SeatIndex): PendingDecision | undefined =>
    runner.pendingDecisions().find((d) => d.seat === seat);

  /** 让 seat 的下一次掷骰为 face */
  const forceDice = (...faces: number[]) => {
    const r = runner.submitSystem({ type: 'SYS_DEBUG', op: { op: 'forceNext', purpose: 'dice', values: faces } });
    if (!r.ok) throw new Error(`forceDice failed: ${r.error.code}`);
  };

  /** seat 当前决策提交 intent（自动取 decisionId） */
  const act = (
    seat: SeatIndex,
    intent: Parameters<GameRunner['submitPlayer']>[2],
    clientActionId: string | null = null,
  ) => {
    const d = pendingOf(seat);
    if (!d) throw new Error(`seat ${seat} has no pending decision`);
    return runner.submitPlayer(seat, d.id, intent, clientActionId);
  };

  return { runner, sched, engine, rec, settings, config, players, pendingOf, forceDice, act, timing };
}
