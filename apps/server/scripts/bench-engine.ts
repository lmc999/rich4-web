/**
 * 引擎性能基准（architecture §5.2「applyAction p50 < 5ms」；M1 验证 3：p50 < 5ms、p99 < 15ms）。
 * 走服务器正式路径 createEngine(registry).applyAction（每次 structuredClone 草稿），不开 devChecks。
 *
 *   npx tsx apps/server/scripts/bench-engine.ts --map test-allkinds
 *
 * 选项：
 *   --map <id>          test | test-allkinds（默认 test-allkinds）
 *   --actions <n>       计时的 action 数（默认 20000；对局结束就换一局继续）
 *   --warmup <n>        预热 action 数（默认 2000，不计时）
 *   --policy <p>        random | default（defaultIntent，默认 random）
 *   --players <n>       2..4（默认 4）
 *   --seed <hex>        基础种子（默认 be0c4）
 *   --no-assert         只报告，不因超出阈值而返回非 0
 *   --json              输出 JSON
 */
import { performance } from 'node:perf_hooks';
import { fixtureRegistry } from '@rich4/shared/data';
import { createEngine, type GameAction, type GameState, type SeatIndex } from '@rich4/shared/engine';
import { DEFAULT_CHARACTERS, intentRng, makeConfig, randomAction } from '@rich4/shared/engine-testing';

interface Options {
  map: string;
  actions: number;
  warmup: number;
  policy: 'random' | 'default';
  players: number;
  seed: string;
  assert: boolean;
  json: boolean;
}

const P50_LIMIT_MS = 5;
const P99_LIMIT_MS = 15;

function parseArgs(argv: readonly string[]): Options {
  const o: Options = {
    map: 'test-allkinds',
    actions: 20000,
    warmup: 2000,
    policy: 'random',
    players: 4,
    seed: 'be0c4',
    assert: true,
    json: false,
  };
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const int = (s: string, flag: string, min: number): number => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be an integer ≥ ${min}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--map':
        o.map = need(i++, a);
        break;
      case '--actions':
        o.actions = int(need(i++, a), a, 1);
        break;
      case '--warmup':
        o.warmup = int(need(i++, a), a, 0);
        break;
      case '--policy': {
        const p = need(i++, a);
        if (p !== 'random' && p !== 'default') throw new Error('--policy must be random or default');
        o.policy = p;
        break;
      }
      case '--players':
        o.players = Math.min(4, Math.max(2, int(need(i++, a), a, 2)));
        break;
      case '--seed':
        o.seed = need(i++, a);
        break;
      case '--no-assert':
        o.assert = false;
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

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

function main(): void {
  let o: Options;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`bench-engine: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const engine = createEngine(fixtureRegistry);
  const setups = Array.from({ length: o.players }, (_, i) => ({
    seat: i as SeatIndex,
    character: DEFAULT_CHARACTERS[i]!,
    controller: 'ai' as const,
  }));
  let gameNo = 0;
  const newState = (): GameState => {
    gameNo++;
    return engine.createGame(
      makeConfig({ map: o.map, config: { timeLimitDays: 0 }, debug: false }),
      setups,
      `${o.seed}${gameNo.toString(16)}`,
    );
  };
  const rng = intentRng(o.seed);
  let s = newState();
  const next = (): GameAction => {
    if (o.policy === 'random') return randomAction(s, rng)!;
    const d = s.pending[0]!;
    return { ...d.defaultIntent, seat: d.seat, decisionId: d.id } as GameAction;
  };

  const times: number[] = [];
  let events = 0;
  let cloneMs = 0;
  let stateBytes = 0;
  const total = o.warmup + o.actions;
  for (let i = 0; i < total; i++) {
    if (s.status !== 'playing') s = newState();
    const a = next();
    const t0 = performance.now();
    const r = engine.applyAction(s, a);
    const dt = performance.now() - t0;
    if (i >= o.warmup) {
      times.push(dt);
      events += r.events.length;
      if (i % 500 === 0) {
        const c0 = performance.now();
        structuredClone(r.state);
        cloneMs += performance.now() - c0;
        stateBytes = Math.max(stateBytes, JSON.stringify(r.state).length);
      }
    }
    s = r.state;
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const report = {
    map: o.map,
    actions: times.length,
    games: gameNo,
    eventsPerAction: round(events / times.length),
    p50: round(percentile(sorted, 0.5)),
    p90: round(percentile(sorted, 0.9)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(mean),
    cloneMs: round(cloneMs / Math.max(1, Math.floor(o.actions / 500))),
    stateBytes,
  };
  const ok = report.p50 < P50_LIMIT_MS && report.p99 < P99_LIMIT_MS;
  if (o.json) console.log(JSON.stringify({ ...report, ok }));
  else {
    console.log(
      `applyAction p50=${report.p50}ms p90=${report.p90}ms p99=${report.p99}ms max=${report.max}ms mean=${report.mean}ms ` +
        `(${report.actions} actions, ${report.games} games, ${report.eventsPerAction} events/action, ` +
        `clone≈${report.cloneMs}ms, state≈${Math.round(report.stateBytes / 1024)}KB, map=${report.map})`,
    );
    console.log(ok ? `OK: p50 < ${P50_LIMIT_MS}ms, p99 < ${P99_LIMIT_MS}ms` : 'SLOW: 超出阈值');
  }
  process.exit(ok || !o.assert ? 0 : 1);
}

main();
