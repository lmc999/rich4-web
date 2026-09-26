/**
 * createApp(deps)：组装 Fastify + Socket.IO + 房间管理（design/net.md §11.1）。
 * 引擎、AI 策略、时钟、调度器、日志都可以注入：集成测试注入 stubEngine / ManualScheduler / 缩短的计时。
 * 本里程碑持久化为内存实现（persistence 目录留到 M5）。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { type AiPolicy, BasicAiPolicy } from '@rich4/shared/ai';
import { createEngine, type EngineApi } from '@rich4/shared/engine';
import { type RoomSettings, SAVE_IMPORT_MAX_BYTES } from '@rich4/shared/net';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import type { AppConfig } from './config';
import type { MapCatalog } from './data/DataRegistry';
import { AiDriver } from './game/AiDriver';
import { DEFAULT_TIMING, type TimingOptions } from './game/Deadlines';
import { registerHealth } from './http/health';
import { registerMaps } from './http/maps';
import { registerStatic } from './http/static';
import { type Clock, RealScheduler, realClock, type Scheduler } from './infra/clock';
import { createLogger, type Logger } from './infra/logger';
import { type AppServer, attachIo, createIo, ioEmitter, isTrustedProxy } from './net/io';
import { RateLimiter } from './net/rateLimit';
import { SessionRegistry } from './net/sessions';
import { DEFAULT_ROOM_TTLS, type RoomTtls } from './rooms/Room';
import { RoomBroadcaster } from './rooms/RoomBroadcaster';
import { RoomManager } from './rooms/RoomManager';
import { RoomCodeAllocator } from './rooms/roomCode';

export interface AppDeps {
  config: AppConfig;
  catalog: MapCatalog;
  /** null：引擎不可用（room:start 返回 INTERNAL） */
  engine: EngineApi | null;
  aiPolicy?: AiPolicy;
  log?: Logger;
  clock?: Clock;
  scheduler?: Scheduler;
  timing?: Partial<TimingOptions>;
  /** 覆盖 AI 思考延迟区间（测试用 [0,0]） */
  aiThinkMs?: readonly [number, number];
  /** 限流额度倍率；0 关闭 */
  rateLimitScale?: number;
  roomTtls?: Partial<RoomTtls>;
  /** 新房间默认设置的覆盖（测试用：缩短断线宽限等） */
  roomDefaults?: Partial<Omit<RoomSettings, 'game'>>;
  seedHex?: () => string;
}

export interface App {
  readonly fastify: FastifyInstance;
  readonly io: AppServer;
  readonly rooms: RoomManager;
  readonly sessions: SessionRegistry;
  readonly catalog: MapCatalog;
  readonly log: Logger;
  readonly clock: Clock;
  listen(port?: number, host?: string): Promise<{ port: number; url: string }>;
  isReady(): boolean;
  /** 停机：readyz 转 503、通知客户端、暂停对局、关闭连接 */
  shutdown(reason: string): Promise<void>;
  close(): Promise<void>;
}

/** 按配置选择引擎与配套的 AI 策略：real = createEngine + BasicAiPolicy；stub = 测试用 stubEngine + 本地策略 */
export async function resolveEngine(
  kind: 'stub' | 'real',
  catalog: MapCatalog,
  log: Logger,
  devChecks = false,
): Promise<{ engine: EngineApi | null; policy: AiPolicy }> {
  if (kind === 'stub') {
    const [{ createStubEngine }, { localPolicy }] = await Promise.all([
      import('../test/helpers/stubEngine'),
      import('../test/helpers/localPolicy'),
    ]);
    log.warn('RICH4_TEST_ENGINE=stub：使用 12 格 stubEngine（仅供联调与测试）');
    return { engine: createStubEngine({ registry: catalog.registry }), policy: localPolicy };
  }
  try {
    return { engine: createEngine(catalog.registry, { devChecks }), policy: BasicAiPolicy };
  } catch (err) {
    log.error({ err }, '真实引擎不可用：room:start 将返回 INTERNAL（可设 RICH4_TEST_ENGINE=stub 联调）');
    return { engine: null, policy: BasicAiPolicy };
  }
}

function heapBusy(): boolean {
  const h = getHeapStatistics();
  return h.used_heap_size / h.heap_size_limit > 0.8;
}

export async function createApp(deps: AppDeps): Promise<App> {
  const { config, catalog } = deps;
  const log = deps.log ?? createLogger({ level: config.logLevel, pretty: config.logPretty });
  const clock = deps.clock ?? realClock;
  const scheduler =
    deps.scheduler ?? new RealScheduler((err) => log.error({ err }, 'timer callback threw (caught by scheduler)'));
  const startedAt = Date.now();
  let ready = false;

  const fastify = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    // 与 Socket.IO 相同口径：只信任本机或私有网段的代理（design/net.md §10.3）
    trustProxy: config.trustProxy ? (address: string) => isTrustedProxy(address) : false,
    bodyLimit: SAVE_IMPORT_MAX_BYTES,
  });
  registerHealth(fastify, { isReady: () => ready, startedAt });
  registerMaps(fastify, catalog);
  await registerStatic(fastify, { staticDir: config.staticDir, publicUrl: config.publicUrl });

  const io = createIo(fastify.server, { trustProxy: config.trustProxy, devCorsOrigin: config.devCorsOrigin });
  const sessions = new SessionRegistry();
  const broadcaster = new RoomBroadcaster(ioEmitter(io));
  const think = deps.aiThinkMs;
  const ai = new AiDriver({
    policy: deps.aiPolicy ?? BasicAiPolicy,
    log: log.child({ mod: 'ai' }),
    ...(think ? { thinkMs: { normal: think, fast: think } } : {}),
  });
  const timing: TimingOptions = { ...DEFAULT_TIMING, ...deps.timing };
  const rooms = new RoomManager({
    clock,
    scheduler,
    log,
    out: broadcaster,
    engine: deps.engine,
    maps: catalog,
    ai,
    timing,
    publicUrl: config.publicUrl,
    testMode: config.testMode,
    ttl: { ...DEFAULT_ROOM_TTLS, abandonMs: config.roomAbandonTtlMin * 60_000, ...deps.roomTtls },
    seedHex: deps.seedHex ?? (() => randomBytes(16).toString('hex')),
    randomInt: (n) => randomInt(n),
    newId: () => randomBytes(6).toString('base64url'),
    codes: new RoomCodeAllocator({ clock }),
    maxRooms: config.maxRooms,
    ...(deps.roomDefaults ? { settingsOverrides: deps.roomDefaults } : {}),
    onMemberRemoved: (tokenHash, code) => sessions.clearRoom(tokenHash, code),
    busy: heapBusy,
  });
  const limiter = new RateLimiter({ scale: deps.rateLimitScale ?? 1 });
  attachIo(
    io,
    { rooms, sessions, limiter, log, clock, testMode: config.testMode },
    { trustProxy: config.trustProxy, devCorsOrigin: config.devCorsOrigin },
  );

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    ready = false;
    rooms.closeAll('server');
    io.disconnectSockets(true);
    await new Promise<void>((r) => io.close(() => r()));
    await fastify.close().catch(() => {});
  };

  return {
    fastify,
    io,
    rooms,
    sessions,
    catalog,
    log,
    clock,
    async listen(port = config.port, host = config.host) {
      const addr = await fastify.listen({ port, host });
      ready = true;
      const a = fastify.server.address();
      const p = typeof a === 'object' && a ? a.port : port;
      log.info(
        { addr, maps: catalog.list().map((m) => `${m.id}${m.playable ? '' : '(pending)'}`) },
        'rich4 server listening',
      );
      return { port: p, url: `http://127.0.0.1:${p}` };
    },
    isReady: () => ready,
    async shutdown(reason) {
      ready = false;
      io.emit('server:notice', { kind: 'shutdown', message: '服务器即将重启，请稍后自动重连', reconnectInMs: 5000 });
      log.info({ reason, rooms: rooms.size }, 'shutdown: notifying clients');
      // M5：暂停所有对局、写快照与自动存档后再关闭
      await new Promise((r) => setTimeout(r, 200));
      await close();
    },
    close,
  };
}
