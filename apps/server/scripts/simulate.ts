/**
 * 引擎自对弈模拟（architecture §8「夜间 npm run sim」；design/engine.md §16.5）。不依赖服务器代码。
 *
 *   npx tsx apps/server/scripts/simulate.ts --engine-only --map test --games 200 --policy random --time-limit 730
 *
 * 选项：
 *   --engine-only          只跑引擎（M1 唯一支持的模式；不加时同样按 engine-only 运行并提示）
 *   --map <id>             test | test-allkinds（fixture，默认 test）
 *   --games <n>            局数（默认 20）
 *   --policy <p>           random（从 options 均匀抽合法 intent）| basic（BasicAiPolicy，默认）
 *   --time-limit <days>    0 | 730 | 365 | 182 | 91 | 30（默认 730；0 = 无限，封顶 --max-actions）
 *   --players <n>          2..4（默认 4）
 *   --humans <n>           前 n 个座位 controller='human'（仍由策略代打，默认 0）
 *   --seed <hex>           基础种子（默认 5eed）
 *   --check-every <k>      每 k 个 action 检查一次不变量（默认 1；每 50 步与终局另做结构校验；0 = 只在终局检查）
 *   --check-fold           每个 action 额外检查 fold(applyPostPatch) == publicWorld(next) 且无 SYNC
 *   --max-actions <n>      单局 action 上限（默认 200000，超过记为 unfinished）
 *   --json                 输出 JSON 汇总
 * 输出一行汇总：finished=… invariantErrors=… errors=…；finished=games 且没有错误时退出码为 0。
 */

import type { AiContext, AiRng } from '@rich4/shared/ai';
import { BasicAiPolicy } from '@rich4/shared/ai';
import { fixtureRegistry } from '@rich4/shared/data';
import {
  foldPosts,
  type GameAction,
  type GameConfig,
  type GameState,
  internal,
  type PlayerSetup,
  publicWorld,
  type SeatIndex,
  TIME_LIMIT_OPTIONS,
  type TimeLimitDays,
} from '@rich4/shared/engine';
import {
  DEFAULT_CHARACTERS,
  decisionForSeat,
  intentRng,
  makeConfig,
  randomAction,
  simpleView,
  stateHash,
} from '@rich4/shared/engine-testing';
import { fnv1a32, fnv1a64, mix32, WatcomRng } from '@rich4/shared/util';
import type { DecisionForYou, GameView } from '@rich4/shared/view';

interface Options {
  engineOnly: boolean;
  map: string;
  games: number;
  policy: 'random' | 'basic';
  timeLimit: TimeLimitDays;
  players: number;
  humans: number;
  seed: string;
  checkEvery: number;
  checkFold: boolean;
  maxActions: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const o: Options = {
    engineOnly: false,
    map: 'test',
    games: 20,
    policy: 'basic',
    timeLimit: 730,
    players: 4,
    humans: 0,
    seed: '5eed',
    checkEvery: 1,
    checkFold: false,
    maxActions: 200_000,
    json: false,
  };
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const int = (s: string, flag: string, min: number, max: number): number => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be an integer in ${min}..${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--engine-only':
        o.engineOnly = true;
        break;
      case '--map':
        o.map = need(i++, a);
        break;
      case '--games':
        o.games = int(need(i++, a), a, 1, 1_000_000);
        break;
      case '--policy': {
        const p = need(i++, a);
        if (p !== 'random' && p !== 'basic') throw new Error('--policy must be random or basic');
        o.policy = p;
        break;
      }
      case '--time-limit': {
        const d = int(need(i++, a), a, 0, 730);
        if (!(TIME_LIMIT_OPTIONS as readonly number[]).includes(d)) {
          throw new Error(`--time-limit must be one of ${TIME_LIMIT_OPTIONS.join('|')}`);
        }
        o.timeLimit = d as TimeLimitDays;
        break;
      }
      case '--players':
        o.players = int(need(i++, a), a, 2, 4);
        break;
      case '--humans':
        o.humans = int(need(i++, a), a, 0, 4);
        break;
      case '--seed':
        o.seed = need(i++, a);
        break;
      case '--check-every':
        o.checkEvery = int(need(i++, a), a, 0, 1_000_000);
        break;
      case '--check-fold':
        o.checkFold = true;
        break;
      case '--max-actions':
        o.maxActions = int(need(i++, a), a, 1, 100_000_000);
        break;
      case '--json':
        o.json = true;
        break;
      default:
        throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

function aiRng(seed: number): AiRng {
  const w = WatcomRng.fromSeed(seed);
  return {
    next15: () => w.rand15(),
    mod: (n) => w.int(n),
    bit: () => (w.rand15() & 1) as 0 | 1,
    scale: (n) => w.scale(n),
  };
}

/** 与 AiDriver 相同的派生方式：(aiSeed, seat, decisionId | turnNo+salt) */
function aiContext(s: GameState, view: GameView, seat: SeatIndex, decisionId: string): AiContext {
  const p = s.players.find((x) => x.seat === seat)!;
  const aiSeed = s.secret.aiSeed;
  return {
    seat,
    traits: p.aiTraits,
    rng: aiRng(mix32(aiSeed, seat, fnv1a32(decisionId))),
    turnRng: (salt) => aiRng(mix32(aiSeed, seat, view.clock.turnNo, fnv1a32(salt))),
    map: fixtureRegistry.getMap(s.dataRef.mapId),
    handVisibility: 'public',
  };
}

interface GameOutcome {
  finished: boolean;
  actions: number;
  days: number;
  reason: string;
  invariantErrors: string[];
  error: string | null;
  hash: string;
}

function playGame(o: Options, gameIdx: number): GameOutcome {
  const engine = internal.createEngine(fixtureRegistry);
  const seedHex = mix32(fnv1a32(o.seed), gameIdx).toString(16);
  const config: GameConfig = makeConfig({ map: o.map, config: { timeLimitDays: o.timeLimit }, debug: false });
  const setups: PlayerSetup[] = Array.from({ length: o.players }, (_, i) => ({
    seat: i as SeatIndex,
    character: DEFAULT_CHARACTERS[i]!,
    controller: i < o.humans ? 'human' : 'ai',
  }));
  const rng = intentRng(mix32(fnv1a32(o.seed), gameIdx, 0x1f).toString(16));
  const out: GameOutcome = {
    finished: false,
    actions: 0,
    days: 0,
    reason: 'unfinished',
    invariantErrors: [],
    error: null,
    hash: '',
  };
  let s: GameState;
  try {
    s = engine.createGame(config, setups, seedHex);
  } catch (e) {
    out.error = `createGame: ${String(e)}`;
    return out;
  }
  try {
    while (s.status === 'playing' && out.actions < o.maxActions) {
      let action: GameAction;
      if (o.policy === 'random') action = randomAction(s, rng)!;
      else {
        const d = s.pending[0]!;
        const view = simpleView(s) as GameView;
        const intent = BasicAiPolicy.decide(
          view,
          decisionForSeat(d) as DecisionForYou,
          aiContext(s, view, d.seat, d.id),
        );
        action = { ...intent, seat: d.seat, decisionId: d.id } as GameAction;
      }
      const before = o.checkFold ? (JSON.parse(JSON.stringify(publicWorld(s))) as GameState) : null;
      const events = engine.applyInPlace(s, action);
      out.actions++;
      if (before) {
        if (events.some((e) => e.type === 'SYNC')) out.invariantErrors.push(`action ${out.actions}: SYNC emitted`);
        const folded = JSON.stringify(foldPosts(before, events));
        if (folded !== JSON.stringify(publicWorld(s))) out.invariantErrors.push(`action ${out.actions}: fold mismatch`);
      }
      if (o.checkEvery > 0 && out.actions % o.checkEvery === 0) {
        // 逐步只查不变量；每 50 步与终局再加 zod 结构校验
        const bad = out.actions % 50 === 0 ? engine.explainState(s) : engine.checkInvariants(s);
        if (bad.length > 0) {
          out.invariantErrors.push(`action ${out.actions}: ${bad.slice(0, 3).join('; ')}`);
          break;
        }
      }
    }
    const bad = engine.explainState(s);
    if (bad.length > 0) out.invariantErrors.push(`end: ${bad.slice(0, 3).join('; ')}`);
  } catch (e) {
    out.error = `action ${out.actions}: ${e instanceof Error ? e.message : String(e)}`;
    return out;
  }
  out.finished = s.status === 'over';
  out.days = s.clock.elapsedDays;
  out.reason = s.result?.reason ?? 'unfinished';
  out.hash = stateHash(s);
  return out;
}

function main(): void {
  let o: Options;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`simulate: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  if (!o.engineOnly) console.error('simulate: M1 只支持 --engine-only 模式，按 engine-only 运行');
  fixtureRegistry.getMap(o.map);
  const t0 = process.hrtime.bigint();
  let finished = 0;
  let actions = 0;
  let days = 0;
  let invariantErrors = 0;
  let errors = 0;
  const reasons: Record<string, number> = {};
  const hashes: string[] = [];
  const samples: string[] = [];
  for (let g = 0; g < o.games; g++) {
    const r = playGame(o, g);
    if (r.finished) finished++;
    actions += r.actions;
    days += r.days;
    invariantErrors += r.invariantErrors.length;
    if (r.error) errors++;
    reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    hashes.push(r.hash);
    if ((r.error || r.invariantErrors.length > 0) && samples.length < 5) {
      samples.push(`game ${g}: ${r.error ?? r.invariantErrors[0]}`);
    }
  }
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const summary = {
    games: o.games,
    finished,
    invariantErrors,
    errors,
    actions,
    avgDays: Math.trunc((days / o.games) * 10) / 10,
    reasons,
    map: o.map,
    policy: o.policy,
    timeLimit: o.timeLimit,
    finalHash: fnv1a64(hashes.join(',')),
    seconds: Math.trunc(seconds * 100) / 100,
  };
  if (o.json) console.log(JSON.stringify(summary));
  else {
    console.log(
      `finished=${finished} invariantErrors=${invariantErrors} errors=${errors} games=${o.games} actions=${actions} ` +
        `avgDays=${summary.avgDays} reasons=${JSON.stringify(reasons)} finalHash=${summary.finalHash} ` +
        `seconds=${summary.seconds}`,
    );
  }
  for (const line of samples) console.error(line);
  process.exit(finished === o.games && invariantErrors === 0 && errors === 0 ? 0 : 1);
}

main();
