/**
 * 压测（architecture M11 验证 5；design/net.md §10）：按爬坡节奏逐个建房开局，每房 --humans 个真人 bot（其余座位电脑补位）
 * 与 --spectators 个观战 bot，真人 bot 按 pickIntent 自动决策；爬坡完成后稳态运行 --duration 秒，读 /admin/stats 的
 * 事件循环延迟，p99 ≤ --p99-max（默认 50ms）且没有功能性错误为 PASS（判定规则见 loadtestVerdict.ts）。
 *
 * 用法：npm run loadtest -- --url https://localhost --rooms 200 [--humans 1] [--spectators 0] [--duration 120]
 *        [--ramp 20] [--map taiwan] [--days 0] [--admin-token <token>] [--delay 500] [--p99-max 50]
 *        [--ai-pace normal|fast] [--pacing original|compact] [--passcode <口令>] [--cookie <r4_access=…>] [--insecure] [--json]
 *   --json 时进度写 stderr、结果 JSON 写 stdout；要拿干净的 stdout 用 npm run -s loadtest（不带 -s 时 npm 会先打印命令行）。
 * - --humans 1（默认）的房间只有一名真人，按有效计时档位不限时（design/net.md §5.4）：没有决策截止定时器、不会超时代决；
 *   要把截止定时器与超时代决也算进负载，用 --humans 2 以上。判定规则不变。
 * - 全部连接来自同一个 IP：生产额度（同 IP 30 个并发连接、每分钟建房 5 次）只在服务器 RICH4_TEST_MODE=1 时放宽
 *   （app.ts 的 TEST_MODE_IP_RELAX）；目标服务器不在测试模式时会报 SERVER_BUSY / RATE_LIMITED 并给出提示。
 * - https 且主机是 localhost（或加 --insecure）时接受自签证书：只作用于本脚本自己的连接与请求，不改 NODE_TLS_REJECT_UNAUTHORIZED。
 * - 访问门禁开启时用 --passcode（或环境变量 ACCESS_PASSCODE）登录一次，全部 bot 共用这枚 r4_access cookie；也可直接给 --cookie。
 * - ADMIN_TOKEN 用 --admin-token 或环境变量 ADMIN_TOKEN（不回显）；没有时只跑压测、不判定，退出码 2。
 * - 事件循环延迟的口径（http/admin.ts 的 EventLoopMonitor）：服务器每 60 秒滚动一个窗口，/admin/stats 报「上一个完整窗口与
 *   当前未满窗口中 p99 较差的一个」。--duration 是爬坡完成之后的稳态时长：≥ 2 个窗口（120 秒）时，结束时读到的两个窗口都完全
 *   落在稳态期内；更短时最近的完整窗口可能含爬坡或压测前的空闲时段（读数偏乐观），报告里会注明，判定以 ≥ 120 秒的结果为准。
 *   不改服务器接口：没有加 reset 之类有副作用的参数（会打断运维侧的监控读数）。每 10 秒另外采样一次，序列放在 --json 输出里。
 *   注意 monitorEventLoopDelay 的读数包含采样间隔本身（resolution 20ms，空闲时 p50 约 21ms），所以 p99 ≤ 50ms 相当于
 *   实际迟到约 30ms 以内。
 * - 客户端侧统计：game:act 的 ack 往返 p50/p99、ack 错误码、ack 超时、app:error、seq 缺口、意外断线、意外 room:closed；
 *   另报本进程自己的事件循环延迟（它偏高时 ack 往返会被高估）。
 * - 结束（或 Ctrl-C）时先停自动决策，房主 room:dissolve 解散房间（服务器会写 auto:<code> 自动存档），再断开全部 bot，
 *   不留房间给下次测试；之后再读一次 /admin/stats 核对房间数回到压测前。
 * 退出码：0 PASS；1 FAIL（p99 超阈值，或任何功能性错误：建房或再来一局失败、seq 缺口、意外断线或 room:closed、ack 超时、
 * app:error、game:act 的非预期错误码、其余请求出错、Ctrl-C 提前结束——结束时读不到 /admin/stats 也照样判 FAIL，
 * 压测中服务器崩溃不会被当成「无法判定」）；2 无法判定（参数或预检失败；或者功能上一切正常、只是 /admin/stats 读取失败
 * 或没有 ADMIN_TOKEN，缺 p99 读数）。
 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import type { CharacterId, SeatIndex, TimeLimitDays } from '@rich4/shared/engine';
import {
  ACCESS_COOKIE,
  type AiPace,
  type C2SEventName,
  MAX_SPECTATORS_LIMIT,
  PACING_PROFILES,
  type PacingProfile,
  type Result,
  type RoomSettingsPatch,
} from '@rich4/shared/net';
import { BotClient } from '../test/helpers/botClient';
import { exitCodeOf, judge } from './loadtestVerdict';

const USAGE = `用法：npm run loadtest -- --url <http(s)://host[:port]> --rooms <N> [--humans 1] [--spectators 0]
  [--duration 120] [--ramp <秒>] [--map taiwan] [--days 0|30|91|182|365|730] [--admin-token <token>] [--delay 500]
  [--p99-max 50] [--ai-pace normal|fast] [--pacing original|compact] [--passcode <口令>] [--cookie <r4_access=…>]
  [--insecure] [--json]`;

const ARG_OPTIONS = {
  url: { type: 'string', default: 'http://localhost:3000' },
  rooms: { type: 'string', default: '10' },
  humans: { type: 'string', default: '1' },
  spectators: { type: 'string', default: '0' },
  duration: { type: 'string', default: '120' },
  ramp: { type: 'string' },
  map: { type: 'string' },
  days: { type: 'string' },
  'admin-token': { type: 'string' },
  delay: { type: 'string', default: '500' },
  'p99-max': { type: 'string', default: '50' },
  'ai-pace': { type: 'string' },
  pacing: { type: 'string' },
  passcode: { type: 'string' },
  cookie: { type: 'string' },
  insecure: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/** 参数或预检问题：退出码 2 */
class SetupError extends Error {
  override name = 'SetupError';
}

/** 命令行参数错误（另外打印用法） */
class ArgError extends SetupError {
  override name = 'ArgError';
}

/** 解析命令行（未知选项等错误转成 ArgError） */
function readArgs() {
  try {
    return parseArgs({ options: ARG_OPTIONS }).values;
  } catch (err) {
    throw new ArgError(err instanceof Error ? err.message : String(err));
  }
}

type ArgValues = ReturnType<typeof readArgs>;

const DAYS = new Set<number>([0, 730, 365, 182, 91, 30]);
const PROGRESS_MS = 10_000;
/** http/admin.ts EventLoopMonitor 的缺省窗口（/admin/stats 会带 windowMs，以它为准） */
const DEFAULT_WINDOW_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function intArg(name: string, raw: string | undefined, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ArgError(`--${name} 必须是 ${min}..${max} 的整数`);
  return n;
}

function numArg(name: string, raw: string | undefined, min: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new ArgError(`--${name} 必须是 ≥ ${min} 的数`);
  return n;
}

interface Options {
  url: URL;
  insecure: boolean;
  rooms: number;
  humans: number;
  spectators: number;
  durationMs: number;
  rampMs: number;
  map: string | null;
  days: TimeLimitDays | null;
  adminToken: string | null;
  delayMs: number;
  p99MaxMs: number;
  aiPace: AiPace | null;
  pacing: PacingProfile | null;
  passcode: string | null;
  cookie: string | null;
  json: boolean;
}

function isLocalHostname(h: string): boolean {
  const host = h.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function parseOptions(values: ArgValues): Options {
  let url: URL;
  try {
    url = new URL(values.url!);
  } catch {
    throw new ArgError(`--url 无效：${values.url}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ArgError('--url 只支持 http:// 或 https://');
  const rooms = intArg('rooms', values.rooms, 1, 1000);
  const humans = intArg('humans', values.humans, 1, 4);
  const spectators = intArg('spectators', values.spectators, 0, MAX_SPECTATORS_LIMIT);
  const days = values.days === undefined ? null : Number(values.days);
  if (days !== null && !DAYS.has(days)) throw new ArgError('--days 必须是 0/730/365/182/91/30 之一');
  const aiPace = values['ai-pace'] ?? null;
  if (aiPace !== null && aiPace !== 'normal' && aiPace !== 'fast')
    throw new ArgError('--ai-pace 只能是 normal 或 fast');
  const pacing = values.pacing ?? null;
  if (pacing !== null && !(PACING_PROFILES as readonly string[]).includes(pacing)) {
    throw new ArgError(`--pacing 只能是 ${PACING_PROFILES.join(' / ')}`);
  }
  return {
    url,
    insecure: values.insecure === true || (url.protocol === 'https:' && isLocalHostname(url.hostname)),
    rooms,
    humans,
    spectators,
    durationMs: numArg('duration', values.duration, 1) * 1000,
    // 缺省每秒建 10 个房间，至少 5 秒
    rampMs: (values.ramp === undefined ? Math.max(5, Math.ceil(rooms / 10)) : numArg('ramp', values.ramp, 0)) * 1000,
    map: values.map ?? null,
    days: days as TimeLimitDays | null,
    adminToken: values['admin-token'] || process.env.ADMIN_TOKEN || null,
    delayMs: numArg('delay', values.delay, 0),
    p99MaxMs: numArg('p99-max', values['p99-max'], 0),
    aiPace,
    pacing: pacing as PacingProfile | null,
    passcode: values.passcode || process.env.ACCESS_PASSCODE || null,
    cookie: values.cookie || null,
    json: values.json === true,
  };
}

// ───────────────────────── 输出 ─────────────────────────

let jsonMode = false;
/** 进度与说明：--json 时写 stderr，stdout 只留最终 JSON */
function say(line: string): void {
  if (jsonMode) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

// ───────────────────────── HTTP ─────────────────────────

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function http(
  o: Options,
  method: 'GET' | 'POST',
  path: string,
  extra: { headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<HttpResult> {
  const u = new URL(path, o.url);
  const headers: Record<string, string> = { accept: 'application/json', ...extra.headers };
  if (o.cookie) headers.cookie = o.cookie;
  if (extra.body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(extra.body));
  }
  return new Promise((resolve, reject) => {
    const opts = { method, headers, timeout: extra.timeoutMs ?? 10_000 };
    const req =
      u.protocol === 'https:' ? httpsRequest(u, { ...opts, rejectUnauthorized: !o.insecure }) : httpRequest(u, opts);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${u.pathname} 超时`)));
    req.on('error', reject);
    if (extra.body !== undefined) req.write(extra.body);
    req.end();
  });
}

interface ServerStats {
  uptimeMs: number;
  rooms: { rooms: number; playing: number; members: number };
  connections: number;
  sessions: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  eventLoopDelayMs: { p50: number; p99: number; max: number; windowMs: number };
}

async function adminStats(o: Options): Promise<ServerStats> {
  const r = await http(o, 'GET', '/admin/stats', { headers: { authorization: `Bearer ${o.adminToken}` } });
  if (r.status === 404) throw new SetupError('/admin/stats 返回 404：服务器没有配置 ADMIN_TOKEN');
  if (r.status === 401) throw new SetupError('/admin/stats 返回 401：ADMIN_TOKEN 不对');
  if (r.status !== 200) throw new SetupError(`/admin/stats 返回 ${r.status}`);
  return JSON.parse(r.body) as ServerStats;
}

/** 口令登录一次，取回 r4_access cookie（只保留 name=value） */
async function login(o: Options, passcode: string): Promise<string> {
  const r = await http(o, 'POST', '/api/access', { body: JSON.stringify({ passcode }) });
  if (r.status !== 200) throw new SetupError(`POST /api/access 返回 ${r.status}：口令不对或被限流`);
  const set = r.headers['set-cookie'] ?? [];
  const hit = set.map((c) => c.split(';')[0]!.trim()).find((c) => c.startsWith(`${ACCESS_COOKIE}=`));
  if (!hit) throw new SetupError('POST /api/access 没有返回 r4_access cookie');
  return hit;
}

async function pickMap(o: Options): Promise<string> {
  const r = await http(o, 'GET', '/api/maps');
  if (r.status === 401) {
    throw new SetupError(
      '/api/maps 返回 401（访问门禁已开启）：用 --passcode（或 ACCESS_PASSCODE）或 --cookie 提供访问凭据',
    );
  }
  if (r.status !== 200) throw new SetupError(`/api/maps 返回 ${r.status}`);
  const maps = (JSON.parse(r.body) as { maps: { id: string; playable: boolean }[] }).maps;
  const playable = (id: string) => maps.some((m) => m.id === id && m.playable);
  if (o.map !== null) {
    if (!playable(o.map))
      throw new SetupError(`地图 ${o.map} 不存在或不可开局（可用：${maps.map((m) => m.id).join(', ')}）`);
    return o.map;
  }
  if (playable('taiwan')) return 'taiwan';
  if (playable('test')) {
    say('注意：服务器没有可开局的 taiwan 地图，改用 fixture 地图 test');
    return 'test';
  }
  throw new SetupError('服务器既没有 taiwan 也没有 test 地图');
}

// ───────────────────────── 统计 ─────────────────────────

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

function summarize(xs: readonly number[]): { count: number; p50: number; p99: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { count: s.length, p50: r2(percentile(s, 0.5)), p99: r2(percentile(s, 0.99)), max: r2(s.at(-1) ?? 0) };
}

const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

class Stats {
  /** game:act 的 ack 往返（毫秒） */
  readonly actMs: number[] = [];
  /** 其余请求（建房、入座、开局、解散……）的 ack 往返 */
  readonly otherMs: number[] = [];
  readonly actErrors = new Map<string, number>();
  readonly otherErrors = new Map<string, number>();
  ackTimeouts = 0;
  disconnects = 0;
  readonly disconnectReasons = new Map<string, number>();
  closedUnexpected = 0;
  readonly setupFailures = new Map<string, number>();
  gamesOver = 0;
  rematches = 0;
  /** 收尾开始后不再计数（解散、断开时挂起的 ack 会以错误结束，不算压测结果） */
  frozen = false;

  onReq(event: C2SEventName, ms: number, r: Result<unknown> | null): void {
    if (this.frozen) return;
    const isAct = event === 'game:act';
    if (r === null) {
      this.ackTimeouts++;
      return;
    }
    (isAct ? this.actMs : this.otherMs).push(ms);
    if (!r.ok) bump(isAct ? this.actErrors : this.otherErrors, `${event}:${r.error.code}`);
  }
}

// ───────────────────────── 房间 ─────────────────────────

type RoomPhase = 'pending' | 'setup' | 'playing' | 'ended' | 'failed' | 'closed';

interface ConnectError extends Error {
  data?: { code?: string };
}

/** 失败原因的归类键（统计用；不含房间号等可变部分） */
function failureKey(err: unknown): string {
  const e = err as ConnectError;
  if (e?.data?.code) return `connect:${e.data.code}`;
  const msg = e?.message ?? String(err);
  const t = /^([\w:]+) ack timeout$/.exec(msg);
  if (t) return `${t[1]}:ACK_TIMEOUT`;
  const m = /^(room:\w+|connect_error): (\w+)/.exec(msg);
  return m ? `${m[1]}:${m[2]}` : msg.slice(0, 80);
}

class LoadRoom {
  phase: RoomPhase = 'pending';
  code: string | null = null;
  readonly humans: BotClient[] = [];
  readonly spectators: BotClient[] = [];
  private stoppers: (() => void)[] = [];
  private closing = false;

  constructor(
    readonly index: number,
    private readonly o: Options,
    private readonly map: string,
    private readonly stats: Stats,
  ) {}

  get host(): BotClient | undefined {
    return this.humans[0];
  }

  get bots(): BotClient[] {
    return [...this.humans, ...this.spectators];
  }

  private newBot(nickname: string, seed: number): BotClient {
    const b = new BotClient(this.o.url.origin, {
      nickname,
      seed,
      history: false,
      ...(this.o.insecure ? { rejectUnauthorized: false } : {}),
      ...(this.o.cookie ? { extraHeaders: { cookie: this.o.cookie } } : {}),
      onReq: (event, ms, r) => this.stats.onReq(event, ms, r),
    });
    return b;
  }

  private watch(b: BotClient): void {
    b.socket.on('disconnect', (reason: string) => {
      if (this.closing) return;
      this.stats.disconnects++;
      bump(this.stats.disconnectReasons, reason);
    });
    b.socket.on('room:closed', ({ reason }: { reason: string }) => {
      if (this.closing) return;
      this.stats.closedUnexpected++;
      bump(this.stats.disconnectReasons, `room:closed:${reason}`);
      this.phase = 'closed';
    });
  }

  private async must<T>(what: string, p: Promise<Result<T>>): Promise<T> {
    const r = await p;
    if (!r.ok) throw new Error(`${what}: ${r.error.code}`);
    return r.data;
  }

  /** 连接 → 建房 → 入座 / 观战 → 选角、准备 → 电脑补位 → 开局 → 自动决策 */
  async setup(): Promise<void> {
    this.phase = 'setup';
    const i = this.index;
    for (let k = 0; k < this.o.humans; k++) this.humans.push(this.newBot(`lt${i}p${k}`, i * 8 + k + 1));
    for (let k = 0; k < this.o.spectators; k++) this.spectators.push(this.newBot(`lt${i}w${k}`, i * 8 + 5 + k));
    await Promise.all(this.bots.map((b) => b.connect()));
    for (const b of this.bots) this.watch(b);
    const host = this.host!;
    const settings: RoomSettingsPatch = {
      visibility: 'private',
      ...(this.o.spectators > 0 ? { allowSpectators: true, maxSpectators: this.o.spectators } : {}),
      ...(this.o.aiPace ? { aiPace: this.o.aiPace } : {}),
      ...(this.o.pacing ? { pacing: this.o.pacing } : {}),
      game: { mapId: this.map, ...(this.o.days !== null ? { timeLimitDays: this.o.days } : {}) },
    };
    const created = await this.must('room:create', host.req('room:create', { settings }));
    const code = created.code;
    this.code = code;
    for (const b of this.humans.slice(1)) await this.must('room:join', b.req('room:join', { code, role: 'player' }));
    await Promise.all(
      this.spectators.map((b) => this.must('room:join', b.req('room:join', { code, role: 'spectator' }))),
    );
    for (const [k, b] of this.humans.entries()) {
      await this.must('room:selectCharacter', b.req('room:selectCharacter', { characterId: k as CharacterId }));
      if (k > 0) await this.must('room:setReady', b.req('room:setReady', { ready: true }));
    }
    for (let seat = this.o.humans; seat < 4; seat++) {
      await this.must(
        'room:setSeatAi',
        host.req('room:setSeatAi', { seat: seat as SeatIndex, ai: { preset: 'character' } }),
      );
    }
    host.socket.on('game:over', () => {
      this.stats.gamesOver++;
      this.phase = 'ended';
      void this.rematch();
    });
    await this.must('room:start', host.req('room:start', {}));
    this.stoppers = this.humans.map((b) => b.autoPlay(undefined, { delayMs: this.o.delayMs }));
    this.phase = 'playing';
  }

  /** 对局提前结束（破产、限时）：房主再来一局，保持负载 */
  private async rematch(): Promise<void> {
    if (this.closing) return;
    const host = this.host!;
    try {
      await sleep(1000);
      if (this.closing) return;
      await this.must('room:rematch', host.req('room:rematch', {}));
      for (const b of this.humans.slice(1)) await this.must('room:setReady', b.req('room:setReady', { ready: true }));
      await this.must('room:start', host.req('room:start', {}));
      for (const b of this.humans) b.over = undefined;
      this.stats.rematches++;
      this.phase = 'playing';
    } catch (err) {
      bump(this.stats.setupFailures, `rematch:${failureKey(err)}`);
    }
  }

  /** 停自动决策、房主解散（房主已断线时先用同一 token 恢复再解散）、断开全部 bot */
  async teardown(): Promise<void> {
    this.closing = true;
    for (const stop of this.stoppers) stop();
    const host = this.host;
    if (this.code && host?.socket && this.phase !== 'closed') {
      try {
        if (!host.socket.connected) {
          const r = await host.reconnect(this.code);
          if (!r.ok) throw new Error(r.error.code);
        }
        await host.req('room:dissolve', {}, 10_000);
      } catch {
        // 恢复或解散失败：房间按断线与空房规则由服务器回收（收尾统计会显示残留房间数）
      }
    }
    for (const b of this.bots) b.close();
  }
}

// ───────────────────────── 主流程 ─────────────────────────

interface Sample {
  t: number;
  p99: number;
  max: number;
  rssMB: number;
  connections: number;
  rooms: number;
}

const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;

async function main(): Promise<number> {
  const values = readArgs();
  if (values.help) {
    say(USAGE);
    return 0;
  }
  const o = parseOptions(values);
  jsonMode = o.json;
  const stats = new Stats();
  const clientLoop = monitorEventLoopDelay({ resolution: 20 });
  clientLoop.enable();

  // ── 预检：/readyz、访问凭据、地图、/admin/stats ──
  const ready = await http(o, 'GET', '/readyz').catch((err: unknown) => {
    throw new SetupError(`连不上 ${o.url.origin}：${err instanceof Error ? err.message : String(err)}`);
  });
  if (ready.status !== 200) throw new SetupError(`/readyz 返回 ${ready.status}`);
  if (!o.cookie && o.passcode) o.cookie = await login(o, o.passcode);
  const map = await pickMap(o);
  let before: ServerStats | null = null;
  if (o.adminToken) before = await adminStats(o);
  else say('注意：没有 ADMIN_TOKEN（--admin-token 或环境变量），只跑压测、不判定事件循环延迟（退出码 2）');
  say(
    `压测 ${o.url.origin}：${o.rooms} 房 × ${o.humans} 真人 + ${4 - o.humans} 电脑 + ${o.spectators} 观战，地图 ${map}，` +
      `爬坡 ${o.rampMs / 1000}s，稳态 ${o.durationMs / 1000}s，决策延迟 ${o.delayMs}ms${o.insecure && o.url.protocol === 'https:' ? '，接受自签证书' : ''}`,
  );
  if (before) {
    say(
      `压测前：房间 ${before.rooms.rooms}，连接 ${before.connections}，rss ${mb(before.memory.rss)}MB，` +
        `事件循环 p99 ${before.eventLoopDelayMs.p99}ms`,
    );
  }

  const rooms = Array.from({ length: o.rooms }, (_, i) => new LoadRoom(i, o, map, stats));
  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 1000);
  let stopping = false;
  let busyHint = false;

  // ── 爬坡：均匀地逐个建房 ──
  const setups = rooms.map(async (room, i) => {
    await sleep((o.rampMs * i) / o.rooms);
    if (stopping) return;
    try {
      await room.setup();
    } catch (err) {
      room.phase = 'failed';
      const key = failureKey(err);
      bump(stats.setupFailures, key);
      if (!busyHint && /SERVER_BUSY|RATE_LIMITED/.test(key)) {
        busyHint = true;
        say(
          `建房失败 ${key}：同一 IP 的生产额度是 30 个并发连接、每分钟建房 5 次，压测需要服务器以 RICH4_TEST_MODE=1 启动；` +
            '若已是测试模式，可能是 MAX_ROOMS 或内存上限',
        );
      }
    }
  });

  // ── 进度：每 10 秒一行 ──
  const samples: Sample[] = [];
  let rssPeak = before?.memory.rss ?? 0;
  let last = { t: Date.now(), batches: 0, msgs: 0, acts: 0 };
  const totals = () => {
    let batches = 0;
    let msgs = 0;
    let gaps = 0;
    let appErrors = 0;
    for (const r of rooms) {
      batches += r.host?.batchCount ?? 0;
      for (const b of r.bots) {
        msgs += b.receivedCount;
        gaps += b.gaps.length;
        appErrors += b.errors.length;
      }
    }
    return { batches, msgs, gaps, appErrors };
  };
  const progress = async () => {
    const now = Date.now();
    const tt = totals();
    const dt = (now - last.t) / 1000;
    const acts = stats.actMs.length;
    const recent = summarize(stats.actMs.slice(last.acts));
    const count = (p: RoomPhase) => rooms.filter((r) => r.phase === p).length;
    let server = '';
    if (o.adminToken) {
      try {
        const s = await adminStats(o);
        rssPeak = Math.max(rssPeak, s.memory.rss);
        samples.push({
          t: elapsed(),
          p99: s.eventLoopDelayMs.p99,
          max: s.eventLoopDelayMs.max,
          rssMB: mb(s.memory.rss),
          connections: s.connections,
          rooms: s.rooms.rooms,
        });
        server = ` | 服务器环路 p99 ${s.eventLoopDelayMs.p99}ms rss ${mb(s.memory.rss)}MB 连接 ${s.connections}`;
      } catch (err) {
        server = ` | /admin/stats 失败：${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const loop = Math.round(clientLoop.percentile(99) / 1e4) / 100;
    say(
      `[${String(elapsed()).padStart(4)}s] 房间 在线 ${count('playing')}/${o.rooms}（建房中 ${count('setup') + count('pending')}，` +
        `失败 ${count('failed')}，结束 ${count('ended')}，关闭 ${count('closed')}） batch/s ${((tt.batches - last.batches) / dt).toFixed(1)} ` +
        `消息/s ${((tt.msgs - last.msgs) / dt).toFixed(0)} act/s ${((acts - last.acts) / dt).toFixed(1)} ` +
        `ack p99 ${recent.p99}ms | 错误 ${[...stats.actErrors.values()].reduce((a, b) => a + b, 0) + tt.appErrors} ` +
        `超时 ${stats.ackTimeouts} 断线 ${stats.disconnects} 缺口 ${tt.gaps}${server} | 本机环路 p99 ${loop}ms`,
    );
    last = { t: now, batches: tt.batches, msgs: tt.msgs, acts };
  };
  let ticking = Promise.resolve();
  const ticker = setInterval(() => {
    ticking = ticking.then(progress).catch((err: unknown) => say(`进度输出失败：${String(err)}`));
  }, PROGRESS_MS);

  // Ctrl-C：提前结束，照常收尾（解散房间）
  let interrupted = false;
  let wake: () => void = () => {};
  const onSigint = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    say('收到 Ctrl-C：提前结束，正在解散房间……（再按一次强制退出）');
    wake();
  };
  process.on('SIGINT', onSigint);
  const wait = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });

  await Promise.race([Promise.all(setups), new Promise<void>((r) => (wake = r))]);
  const tSteady = Date.now();
  const started = rooms.filter((r) => r.phase === 'playing' || r.phase === 'ended').length;
  if (!interrupted) {
    say(
      `爬坡完成（${((tSteady - t0) / 1000).toFixed(1)}s）：${started}/${o.rooms} 房开局，稳态运行 ${o.durationMs / 1000}s`,
    );
    await wait(o.durationMs);
    // setTimeout 按 Date.now 计可能早到 1ms：补足，保证「稳态 ≥ 2 个窗口」的判断不因计时误差落空
    while (!interrupted && Date.now() - tSteady < o.durationMs) await sleep(5);
  }
  const tEnd = Date.now();
  stopping = true;
  clearInterval(ticker);
  await ticking;

  // ── 读数（收尾之前） ──
  let after: ServerStats | null = null;
  let statsError: string | null = null;
  if (o.adminToken) {
    try {
      after = await adminStats(o);
      rssPeak = Math.max(rssPeak, after.memory.rss);
    } catch (err) {
      statsError = err instanceof Error ? err.message : String(err);
    }
  }
  const tt = totals();
  const steadyS = (tEnd - tSteady) / 1000;
  const windowMs = after?.eventLoopDelayMs.windowMs ?? DEFAULT_WINDOW_MS;
  const fullWindows = tEnd - tSteady >= 2 * windowMs;
  const windowNote = fullWindows
    ? `稳态期内最近一个完整 ${windowMs / 1000}s 窗口与当前未满窗口中 p99 较差者（两段都完全落在稳态期内）`
    : `稳态期 ${steadyS.toFixed(0)}s 不足 ${(2 * windowMs) / 1000}s：最近一个完整窗口可能含爬坡或压测前的空闲时段，读数偏乐观，仅供冒烟参考`;
  const resolutionNote = '读数含 monitorEventLoopDelay 的 20ms 采样间隔（空闲 p50 约 21ms）';
  const clientLoopMs = {
    p50: Math.round(clientLoop.percentile(50) / 1e4) / 100,
    p99: Math.round(clientLoop.percentile(99) / 1e4) / 100,
    max: Math.round(clientLoop.max / 1e4) / 100,
  };

  // ── 收尾：等进行中的建房结束，停决策、解散、断开（20 路并发） ──
  stats.frozen = true;
  say('收尾：房主解散房间并断开全部 bot……');
  await Promise.allSettled(setups);
  const queue = [...rooms];
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      for (let r = queue.shift(); r; r = queue.shift()) await r.teardown();
    }),
  );
  process.off('SIGINT', onSigint);
  let cleanup: { roomsBefore: number; roomsAfter: number; connectionsAfter: number } | null = null;
  if (o.adminToken && before) {
    await sleep(1500);
    try {
      const s = await adminStats(o);
      cleanup = { roomsBefore: before.rooms.rooms, roomsAfter: s.rooms.rooms, connectionsAfter: s.connections };
    } catch {
      cleanup = null;
    }
  }
  clientLoop.disable();

  // ── 判定 ──
  const act = summarize(stats.actMs);
  const other = summarize(stats.otherMs);
  const failedRooms = rooms.filter((r) => r.phase === 'failed').length;
  const { verdict, reasons } = judge({
    p99MaxMs: o.p99MaxMs,
    serverP99: after ? after.eventLoopDelayMs.p99 : null,
    statsError,
    failedRooms,
    seqGaps: tt.gaps,
    disconnects: stats.disconnects,
    closedUnexpected: stats.closedUnexpected,
    ackTimeouts: stats.ackTimeouts,
    appErrors: tt.appErrors,
    actErrors: stats.actErrors,
    otherErrors: stats.otherErrors,
    setupFailures: stats.setupFailures,
    interrupted,
  });

  const result = {
    verdict,
    reasons,
    config: {
      url: o.url.origin,
      rooms: o.rooms,
      humans: o.humans,
      ais: 4 - o.humans,
      spectators: o.spectators,
      map,
      rampS: o.rampMs / 1000,
      durationS: o.durationMs / 1000,
      delayMs: o.delayMs,
      p99MaxMs: o.p99MaxMs,
      aiPace: o.aiPace,
      pacing: o.pacing,
      days: o.days,
    },
    timing: {
      rampActualS: Math.round((tSteady - t0) / 100) / 10,
      steadyS: Math.round(steadyS * 10) / 10,
      totalS: Math.round((tEnd - t0) / 100) / 10,
    },
    rooms: {
      requested: o.rooms,
      started,
      failed: failedRooms,
      gamesOver: stats.gamesOver,
      rematches: stats.rematches,
      setupFailures: Object.fromEntries(stats.setupFailures),
    },
    bots: o.rooms * (o.humans + o.spectators),
    acks: {
      act: { ...act, errors: Object.fromEntries(stats.actErrors) },
      other: { ...other, errors: Object.fromEntries(stats.otherErrors) },
      timeouts: stats.ackTimeouts,
    },
    appErrors: tt.appErrors,
    seqGaps: tt.gaps,
    disconnects: stats.disconnects,
    disconnectReasons: Object.fromEntries(stats.disconnectReasons),
    roomClosedUnexpected: stats.closedUnexpected,
    batches: { total: tt.batches, perSec: Math.round((tt.batches / Math.max(1, (tEnd - t0) / 1000)) * 10) / 10 },
    messages: { total: tt.msgs, perSec: Math.round(tt.msgs / Math.max(1, (tEnd - t0) / 1000)) },
    server: after
      ? {
          eventLoopDelayMs: after.eventLoopDelayMs,
          window: windowNote,
          windowsInSteadyState: fullWindows,
          note: resolutionNote,
          rssMB: mb(after.memory.rss),
          rssPeakMB: mb(rssPeak),
          heapUsedMB: mb(after.memory.heapUsed),
          connections: after.connections,
          rooms: after.rooms,
          before: before
            ? {
                rooms: before.rooms.rooms,
                connections: before.connections,
                rssMB: mb(before.memory.rss),
                eventLoopDelayMs: before.eventLoopDelayMs,
              }
            : null,
          samples,
        }
      : null,
    client: { eventLoopDelayMs: clientLoopMs },
    cleanup,
  };

  if (o.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    say('');
    say(`── 结果：${verdict}${reasons.length > 0 ? `（${reasons.join('；')}）` : ''}`);
    say(
      `房间：开局 ${started}/${o.rooms}，失败 ${failedRooms}，对局结束 ${stats.gamesOver}，再来一局 ${stats.rematches}` +
        (stats.setupFailures.size > 0 ? `，失败原因 ${JSON.stringify(Object.fromEntries(stats.setupFailures))}` : ''),
    );
    say(
      `时长：爬坡 ${result.timing.rampActualS}s，稳态 ${result.timing.steadyS}s；batch ${tt.batches}（${result.batches.perSec}/s），` +
        `消息 ${tt.msgs}（${result.messages.perSec}/s）`,
    );
    say(
      `game:act ack：${act.count} 次，p50 ${act.p50}ms，p99 ${act.p99}ms，max ${act.max}ms；错误 ${JSON.stringify(Object.fromEntries(stats.actErrors))}；` +
        `其余请求 ${other.count} 次 p99 ${other.p99}ms；超时 ${stats.ackTimeouts}`,
    );
    say(
      `app:error ${tt.appErrors}，seq 缺口 ${tt.gaps}，意外断线 ${stats.disconnects}` +
        (stats.disconnectReasons.size > 0 ? ` ${JSON.stringify(Object.fromEntries(stats.disconnectReasons))}` : '') +
        `，意外 room:closed ${stats.closedUnexpected}`,
    );
    if (after) {
      const e = after.eventLoopDelayMs;
      say(`服务器事件循环：p50 ${e.p50}ms，p99 ${e.p99}ms，max ${e.max}ms（阈值 p99 ≤ ${o.p99MaxMs}ms）`);
      say(`  口径：${windowNote}；${resolutionNote}`);
      say(
        `服务器内存：rss ${mb(after.memory.rss)}MB（峰值 ${mb(rssPeak)}MB），heapUsed ${mb(after.memory.heapUsed)}MB；` +
          `连接 ${after.connections}，房间 ${after.rooms.rooms}（对局中 ${after.rooms.playing}）`,
      );
    }
    say(`本机（压测进程）事件循环：p50 ${clientLoopMs.p50}ms，p99 ${clientLoopMs.p99}ms，max ${clientLoopMs.max}ms`);
    if (cleanup) {
      say(`收尾：房间 ${cleanup.roomsAfter}（压测前 ${cleanup.roomsBefore}），连接 ${cleanup.connectionsAfter}`);
    }
  }
  return exitCodeOf(verdict);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${err instanceof SetupError ? '' : 'fatal: '}${msg}\n`);
    if (err instanceof ArgError) process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  });
