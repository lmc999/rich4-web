/**
 * 引擎自对弈模拟（architecture §8「夜间 npm run sim」；design/engine.md §16.5）。不依赖服务器代码。
 *
 *   npx tsx apps/server/scripts/simulate.ts --engine-only --map test --games 200 --policy random --time-limit 730
 *
 * 选项：
 *   --engine-only          只跑引擎（目前唯一支持的模式；不加时同样按 engine-only 运行并提示）
 *   --map <id>             test | test-allkinds（fixture，默认 test）；原版四张图 taiwan | china | japan | usa
 *                          需要 RICH4_DATA_DIR（或 --data-dir）指向含该图的数据包
 *   --data-dir <dir>       本机数据包目录（manifest.json + maps/*.map.json），缺省读环境变量 RICH4_DATA_DIR
 *   --games <n>            局数（默认 20）
 *   --policy <p>           random（从 options 均匀抽合法 intent）| basic（BasicAiPolicy，默认）| original（OriginalAiPolicy）
 *   --time-limit <days>    0 | 730 | 365 | 182 | 91 | 30（默认 730；0 = 无限，封顶 --max-actions）
 *   --players <n>          2..4（默认 4）
 *   --humans <n>           前 n 个座位 controller='human'（仍由策略代打，默认 0）
 *   --seed <hex>           基础种子（默认 5eed）
 *   --check-every <k>      每 k 个 action 检查一次不变量（默认 1；每 50 步与终局另做结构校验；0 = 只在终局检查）
 *   --check-fold           每个 action 额外检查 fold(applyPostPatch) == publicWorld(next) 且无 SYNC
 *   --max-actions <n>      单局 action 上限（默认 200000，超过记为 unfinished）
 *   --max-years <n>        单局游戏内年数上限（默认：无限局 20 年，限时局不设；到达即记为 unfinished）
 *   --min-finish <pct>     结束率门槛（默认：限时局 100，无限局 95）；达到门槛且没有错误、没有 reject 时退出码为 0
 *   --workers <n>          worker_threads 并发数（默认 1；结果按局号汇总，finalHash 与并发数无关）
 *   --stats                另外统计事件与决策次数（不影响 finalHash / journalHash）：各事件类型、COMPANY_FEE 按行业码、
 *                          CONFINED 按「地点/起因」、各决策种类；文本模式多输出一行 stats=…，--json 时并入汇总
 *   --json                 输出 JSON 汇总
 * 输出一行汇总：finished=… rejects=… invariantErrors=… errors=… finishRate=… finalHash=… journalHash=…；
 * finalHash 为各局终局状态哈希，journalHash 为各局 action 序列哈希（同 seed 两次运行两者都应相同）。
 * rejects：AI 策略给出的 intent 未通过 PlayerIntentSchema / ALLOWED_INTENTS，或被引擎以 EngineRuleError 拒绝的次数
 * （此时改用 defaultIntent，与服务器 AiDriver 的兜底一致）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { AiContext, AiPolicy, AiRng } from '@rich4/shared/ai';
import { BasicAiPolicy, OriginalAiPolicy } from '@rich4/shared/ai';
import {
  buildFixtureMaps,
  createRegistry,
  type DataRegistry,
  fixtureRegistry,
  type MapDef,
  parseMapDef,
  TABLES,
} from '@rich4/shared/data';
import {
  EngineRuleError,
  foldPosts,
  type GameAction,
  type GameConfig,
  type GameEvent,
  type GameState,
  internal,
  isIntentAllowed,
  PlayerIntentSchema,
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

type PolicyName = 'random' | 'basic' | 'original';

interface Options {
  engineOnly: boolean;
  map: string;
  dataDir: string | null;
  games: number;
  policy: PolicyName;
  timeLimit: TimeLimitDays;
  players: number;
  humans: number;
  seed: string;
  checkEvery: number;
  checkFold: boolean;
  maxActions: number;
  /** 游戏内年数上限（null 表示不设） */
  maxYears: number | null;
  /** 结束率门槛（百分比） */
  minFinish: number | null;
  workers: number;
  stats: boolean;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const o: Options = {
    engineOnly: false,
    map: 'test',
    dataDir: process.env.RICH4_DATA_DIR ?? null,
    games: 20,
    policy: 'basic',
    timeLimit: 730,
    players: 4,
    humans: 0,
    seed: '5eed',
    checkEvery: 1,
    checkFold: false,
    maxActions: 200_000,
    maxYears: null,
    minFinish: null,
    workers: 1,
    stats: false,
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
      case '--data-dir':
        o.dataDir = need(i++, a);
        break;
      case '--games':
        o.games = int(need(i++, a), a, 1, 1_000_000);
        break;
      case '--policy': {
        const p = need(i++, a);
        if (p !== 'random' && p !== 'basic' && p !== 'original') {
          throw new Error('--policy must be random, basic or original');
        }
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
      case '--max-years':
        o.maxYears = int(need(i++, a), a, 1, 200);
        break;
      case '--min-finish':
        o.minFinish = int(need(i++, a), a, 0, 100);
        break;
      case '--workers':
        o.workers = int(need(i++, a), a, 1, 64);
        break;
      case '--stats':
        o.stats = true;
        break;
      case '--json':
        o.json = true;
        break;
      default:
        throw new Error(`unknown option ${a}`);
    }
  }
  // 无限局默认封顶 20 年（architecture §8「夜间」：无限局上限 20 年、结束率 ≥ 95%）
  if (o.maxYears === null && o.timeLimit === 0) o.maxYears = 20;
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
function aiContext(reg: DataRegistry, s: GameState, view: GameView, seat: SeatIndex, decisionId: string): AiContext {
  const p = s.players.find((x) => x.seat === seat)!;
  const aiSeed = s.secret.aiSeed;
  return {
    seat,
    traits: p.aiTraits,
    rng: aiRng(mix32(aiSeed, seat, fnv1a32(decisionId))),
    turnRng: (salt) => aiRng(mix32(aiSeed, seat, view.clock.turnNo, fnv1a32(salt))),
    map: reg.getMap(s.dataRef.mapId),
    handVisibility: 'public',
  };
}

/** fixture 地图 + 数据包目录（manifest.json 列出的地图）；目录不存在时只有 fixture */
function loadRegistry(dataDir: string | null): DataRegistry {
  if (dataDir === null) return fixtureRegistry;
  const dir = resolve(dataDir);
  const manifestPath = resolve(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath} not found`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { maps: { id: string; file: string }[] };
  const maps: MapDef[] = buildFixtureMaps();
  for (const m of manifest.maps) {
    const def = parseMapDef(JSON.parse(readFileSync(resolve(dir, m.file), 'utf8')));
    if (!maps.some((x) => x.id === def.id)) maps.push(def);
  }
  return createRegistry(maps, { tables: TABLES });
}

const POLICIES: Record<Exclude<PolicyName, 'random'>, AiPolicy> = {
  basic: BasicAiPolicy,
  original: OriginalAiPolicy,
};

/** --stats 的计数（按局统计，汇总时相加） */
interface GameStats {
  /** 各事件类型的次数 */
  events: Record<string, number>;
  /** COMPANY_FEE 按行业码（data/tables/facilities INDUSTRY） */
  companyFee: Record<string, number>;
  /** CONFINED 按「where/cause.k」（例如 away/fee 为航空出国） */
  confined: Record<string, number>;
  /** 各决策种类出现的次数（按 action 计：pending[0].kind） */
  decisions: Record<string, number>;
}

function bump(rec: Record<string, number>, key: string, n = 1): void {
  rec[key] = (rec[key] ?? 0) + n;
}

function countEvents(st: GameStats, events: readonly GameEvent[]): void {
  for (const e of events) {
    bump(st.events, e.type);
    if (e.type === 'COMPANY_FEE') bump(st.companyFee, String(e.industry));
    else if (e.type === 'CONFINED') bump(st.confined, `${e.where}/${e.cause.k}`);
  }
}

function mergeStats(into: GameStats, from: GameStats): void {
  for (const k of ['events', 'companyFee', 'confined', 'decisions'] as const) {
    for (const [key, n] of Object.entries(from[k])) bump(into[k], key, n);
  }
}

function sortedRecord(rec: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

interface GameOutcome {
  finished: boolean;
  actions: number;
  rejects: number;
  days: number;
  reason: string;
  invariantErrors: string[];
  error: string | null;
  hash: string;
  /** action 序列的 FNV-1a 64 */
  journal: string;
  /** --stats 时的计数，否则 null */
  stats: GameStats | null;
}

function playGame(o: Options, reg: DataRegistry, gameIdx: number): GameOutcome {
  const engine = internal.createEngine(reg);
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
    rejects: 0,
    days: 0,
    reason: 'unfinished',
    invariantErrors: [],
    error: null,
    hash: '',
    journal: '',
    stats: o.stats ? { events: {}, companyFee: {}, confined: {}, decisions: {} } : null,
  };
  const maxDays = o.maxYears === null ? Number.POSITIVE_INFINITY : o.maxYears * 365;
  let journal = '';
  let s: GameState;
  try {
    s = engine.createGame(config, setups, seedHex);
  } catch (e) {
    out.error = `createGame: ${String(e)}`;
    return out;
  }
  try {
    while (s.status === 'playing' && out.actions < o.maxActions && s.clock.elapsedDays < maxDays) {
      let action: GameAction;
      let fallback: GameAction | null = null;
      if (out.stats) bump(out.stats.decisions, s.pending[0]?.kind ?? 'none');
      if (o.policy === 'random') action = randomAction(s, rng)!;
      else {
        const d = s.pending[0]!;
        const view = simpleView(s) as GameView;
        const intent = POLICIES[o.policy].decide(
          view,
          decisionForSeat(d) as DecisionForYou,
          aiContext(reg, s, view, d.seat, d.id),
        );
        fallback = { ...d.defaultIntent, seat: d.seat, decisionId: d.id } as GameAction;
        if (!PlayerIntentSchema.safeParse(intent).success || !isIntentAllowed(d.kind, intent.type)) {
          out.rejects++;
          action = fallback;
          fallback = null;
        } else action = { ...intent, seat: d.seat, decisionId: d.id } as GameAction;
      }
      journal = fnv1a64(`${journal}|${JSON.stringify(action)}`);
      const before = o.checkFold ? (JSON.parse(JSON.stringify(publicWorld(s))) as GameState) : null;
      let events: ReturnType<typeof engine.applyInPlace>;
      if (fallback === null) events = engine.applyInPlace(s, action);
      else {
        // AI 的 intent 可能被引擎拒绝：先在副本上执行，失败则按 defaultIntent 兜底并计入 rejects
        try {
          const r = engine.applyAction(s, action);
          s = r.state;
          events = r.events;
        } catch (e) {
          if (!(e instanceof EngineRuleError)) throw e;
          out.rejects++;
          if (out.rejects <= 3) console.error(`reject: ${e.message} (${JSON.stringify(action)})`);
          events = engine.applyInPlace(s, fallback);
          journal = fnv1a64(`${journal}|${JSON.stringify(fallback)}`);
        }
      }
      out.actions++;
      if (out.stats) countEvents(out.stats, events);
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
  out.journal = journal;
  return out;
}

/** worker：跑分到的局号，逐局回传结果 */
interface WorkerJob {
  argv: string[];
  games: number[];
}

function workerMain(job: WorkerJob): void {
  const o = parseArgs(job.argv);
  const reg = loadRegistry(o.dataDir);
  for (const g of job.games) parentPort!.postMessage({ g, r: playGame(o, reg, g) });
  parentPort!.postMessage({ done: true });
}

/** 按局号跑完全部对局（workers > 1 时分给 worker_threads，结果按局号排序） */
async function runAll(o: Options, reg: DataRegistry, argv: string[]): Promise<GameOutcome[]> {
  const out: GameOutcome[] = new Array(o.games);
  if (o.workers <= 1) {
    for (let g = 0; g < o.games; g++) out[g] = playGame(o, reg, g);
    return out;
  }
  const n = Math.min(o.workers, o.games);
  // worker 里同样要能加载 .ts：用一段 data: URL 引导代码先注册 tsx 的 ESM loader，再导入本脚本
  // （主线程的 loader 由 npx tsx 注册，不会自动传给 worker）
  const self = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const api = import.meta.resolve('tsx/esm/api');
  const boot = `import { register } from ${JSON.stringify(api)}; register(); await import(${JSON.stringify(self)});`;
  const entry = new URL(`data:text/javascript,${encodeURIComponent(boot)}`);
  await Promise.all(
    Array.from({ length: n }, (_, w) => {
      const games: number[] = [];
      for (let g = w; g < o.games; g += n) games.push(g);
      return new Promise<void>((resolveDone, reject) => {
        const worker = new Worker(entry, { workerData: { argv, games } satisfies WorkerJob });
        worker.on('message', (m: { g: number; r: GameOutcome } | { done: true }) => {
          if ('done' in m) resolveDone();
          else out[m.g] = m.r;
        });
        worker.on('error', reject);
        worker.on('exit', (code) => (code === 0 ? resolveDone() : reject(new Error(`worker exited ${code}`))));
      });
    }),
  );
  return out;
}

async function main(): Promise<void> {
  let o: Options;
  const argv = process.argv.slice(2);
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(`simulate: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  if (!o.engineOnly) console.error('simulate: 目前只支持 --engine-only 模式，按 engine-only 运行');
  let reg: DataRegistry;
  try {
    reg = loadRegistry(o.dataDir);
    reg.getMap(o.map);
  } catch (e) {
    console.error(`simulate: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const t0 = process.hrtime.bigint();
  let finished = 0;
  let rejects = 0;
  let actions = 0;
  let days = 0;
  let invariantErrors = 0;
  let errors = 0;
  const reasons: Record<string, number> = {};
  const hashes: string[] = [];
  const journals: string[] = [];
  const samples: string[] = [];
  const stats: GameStats | null = o.stats ? { events: {}, companyFee: {}, confined: {}, decisions: {} } : null;
  const outcomes = await runAll(o, reg, argv);
  for (let g = 0; g < o.games; g++) {
    const r = outcomes[g]!;
    journals.push(r.journal);
    if (r.finished) finished++;
    rejects += r.rejects;
    actions += r.actions;
    days += r.days;
    invariantErrors += r.invariantErrors.length;
    if (r.error) errors++;
    reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    hashes.push(r.hash);
    if (stats && r.stats) mergeStats(stats, r.stats);
    if ((r.error || r.invariantErrors.length > 0) && samples.length < 30) {
      samples.push(`game ${g}: ${r.error ?? r.invariantErrors[0]}`);
    }
  }
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const summary = {
    games: o.games,
    finished,
    rejects,
    invariantErrors,
    errors,
    actions,
    avgDays: Math.trunc((days / o.games) * 10) / 10,
    reasons,
    map: o.map,
    policy: o.policy,
    timeLimit: o.timeLimit,
    finalHash: fnv1a64(hashes.join(',')),
    journalHash: fnv1a64(journals.join(',')),
    finishRate: Math.trunc((finished / o.games) * 1000) / 10,
    maxYears: o.maxYears,
    workers: o.workers,
    seconds: Math.trunc(seconds * 100) / 100,
    ...(stats
      ? {
          stats: {
            avgActions: Math.trunc((actions / o.games) * 10) / 10,
            events: sortedRecord(stats.events),
            companyFee: sortedRecord(stats.companyFee),
            confined: sortedRecord(stats.confined),
            decisions: sortedRecord(stats.decisions),
          },
        }
      : {}),
  };
  const minFinish = o.minFinish ?? (o.timeLimit === 0 ? 95 : 100);
  if (o.json) console.log(JSON.stringify(summary));
  else {
    console.log(
      `finished=${finished} rejects=${rejects} invariantErrors=${invariantErrors} errors=${errors} games=${o.games} ` +
        `actions=${actions} finishRate=${summary.finishRate}% ` +
        `avgDays=${summary.avgDays} reasons=${JSON.stringify(reasons)} finalHash=${summary.finalHash} ` +
        `journalHash=${summary.journalHash} seconds=${summary.seconds}`,
    );
    if (summary.stats) console.log(`stats=${JSON.stringify(summary.stats)}`);
  }
  for (const line of samples) console.error(line);
  const finishOk = finished * 100 >= minFinish * o.games;
  process.exit(finishOk && rejects === 0 && invariantErrors === 0 && errors === 0 ? 0 : 1);
}

if (isMainThread) void main();
else workerMain(workerData as WorkerJob);
