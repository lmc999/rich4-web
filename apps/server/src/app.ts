/**
 * createApp(deps)：组装 Fastify + Socket.IO + 房间管理 + 持久化（design/net.md §8、§11.1）。
 * 引擎、AI 策略、时钟、调度器、日志、持久化都可以注入：集成测试注入 stubEngine / ManualScheduler / 缩短的计时 /
 * 内存 SQLite。启动时从快照 + journal 恢复房间（restoreReport）；close() 默认刷快照与自动存档（优雅停机），
 * close({flush:false}) 模拟崩溃（只剩逐条写入的 journal）。
 * 原版皮肤（docs/design/original-skin.md）：/pack/* 素材包（assets/PackRegistry + http/pack）与访问门禁
 * （access/AccessControl + http/access + io.use 握手守卫）。
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Duplex } from 'node:stream';
import { getHeapStatistics } from 'node:v8';
import { type AiPolicy, BasicAiPolicy, OriginalAiPolicy } from '@rich4/shared/ai';
import { createEngine, type EngineApi } from '@rich4/shared/engine';
import { MAX_CONNECTIONS_PER_IP, type RoomSettings, SAVE_IMPORT_MAX_BYTES } from '@rich4/shared/net';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { AccessControl, type AccessControlDeps, GRANTS_PER_IP_PER_HOUR } from './access/AccessControl';
import { type AccessStore, accessDbPath, openAccessStore, SqliteAccessStore } from './access/AccessStore';
import { AccessLimiter } from './access/limiter';
import { belowRecommendedScrypt, RECOMMENDED_SCRYPT } from './access/passcode';
import { loadPackRegistry, type PackRegistry } from './assets/PackRegistry';
import { type AppConfig, ConfigError, isLocalhostUrl } from './config';
import type { MapCatalog } from './data/DataRegistry';
import { AiDriver } from './game/AiDriver';
import { DEFAULT_TIMING, type TimingOptions } from './game/Deadlines';
import { registerAccess } from './http/access';
import { AdminAuth, EventLoopMonitor, registerAdmin } from './http/admin';
import { registerHealth } from './http/health';
import { registerMaps } from './http/maps';
import { registerPack } from './http/pack';
import { registerSavesHttp } from './http/saves';
import { registerStatic } from './http/static';
import { type Clock, RealScheduler, realClock, type Scheduler } from './infra/clock';
import { createLogger, type Logger } from './infra/logger';
import { type AppServer, attachIo, createIo, ioEmitter, isTrustedProxy } from './net/io';
import { RateLimiter } from './net/rateLimit';
import { SessionRegistry } from './net/sessions';
import { BackupScheduler } from './persistence/backup';
import { Signer } from './persistence/codec';
import { MEMORY_DB, openPersistence, type Persistence, resolveHmacSecret } from './persistence/index';
import { RoomPersister } from './persistence/RoomPersister';
import { SaveService } from './persistence/SaveService';
import { createBadWordFilter, loadBadWordFilter } from './rooms/chatFilter';
import { DEFAULT_ROOM_TTLS, type RoomTtls } from './rooms/Room';
import { RoomBroadcaster } from './rooms/RoomBroadcaster';
import { type RestoreReport, RoomManager } from './rooms/RoomManager';
import { RoomCodeAllocator } from './rooms/roomCode';

/** 启动时恢复这么久之内更新过的房间（design/net.md §8.5 listActive(24h)） */
export const RESTORE_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * 测试模式（RICH4_TEST_MODE=1）放宽的按 IP 额度倍率：E2E 与压测（npm run loadtest，200 个房间）的连接全部来自同一个 IP，
 * 生产额度（同 IP 并发连接 30、每分钟建房 5 次）容不下。只放宽这两项；join / resume 失败额度（防扫房间号）、
 * 按会话的令牌桶都不变。非测试模式不经过这里，生产行为不变。
 */
export const TEST_MODE_IP_RELAX = Object.freeze({ connections: 100, create: 100 });

/**
 * 停机时留给在途 HTTP 请求与 WebSocket 关闭握手的宽限，期满强制断开剩余连接（此前房间已刷快照、自动存档）。
 * - 反代（Caddy）到 app 的 keep-alive 连接：server.close() 只断开当时空闲的连接，停机瞬间有请求在途的连接处理完后
 *   仍按 keepAliveTimeout（Fastify 缺省 72s）挂着，客户端的重连请求还会经它进来（engine.io 关闭后照样受理新握手），
 *   close 回调迟迟不来，一直拖到 shutdown.ts 的 25s 强制退出（M11 实机重启时出现过）。
 * - 已升级为 WebSocket 的连接不在 http.Server 的连接跟踪里（closeAllConnections 断不开），server.close() 却要等它断开；
 *   engine.io 关 ws 走正常关闭握手，对端不回关闭帧（手机浏览器被挂起、移动网络断了而 TCP 还挂着）时 ws 缺省等 30s。
 *   这类连接在 'upgrade' 时单独登记，期满一并销毁（M11 审查：修复前实测停机卡满 25s）。
 */
export const SHUTDOWN_HTTP_GRACE_MS = 3000;
/** 宽限期内断开「刚变空闲」的连接的间隔 */
const SHUTDOWN_IDLE_SWEEP_MS = 100;

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
  /** 注入持久化（测试用；调用方负责关闭）；缺省按 config.store / storePath 打开，close() 时关闭 */
  persistence?: Persistence;
  /** 聊天敏感词（覆盖 DATA_DIR/badwords.txt） */
  badWords?: readonly string[];
  /** 重启恢复的时间窗（默认 24 小时） */
  restoreMaxAgeMs?: number;
  /** 注入素材包注册表（测试用）；缺省按 config.assets 加载 */
  pack?: PackRegistry;
  /** 门禁的时钟、限流器等（测试用） */
  accessOptions?: Partial<Pick<AccessControlDeps, 'now' | 'sleep' | 'limiter' | 'redeemLimiter' | 'epochCacheMs'>>;
  /** 管理接口鉴权失败的退避（测试用；缺省新建） */
  adminLimiter?: AccessLimiter;
}

export interface App {
  readonly fastify: FastifyInstance;
  readonly io: AppServer;
  readonly rooms: RoomManager;
  readonly sessions: SessionRegistry;
  readonly catalog: MapCatalog;
  readonly log: Logger;
  readonly clock: Clock;
  readonly persistence: Persistence;
  readonly saves: SaveService;
  /** 启动时恢复的房间 */
  readonly restoreReport: readonly RestoreReport[];
  /** 原版皮肤素材包（未启用时 enabled=false） */
  readonly pack: PackRegistry;
  /** 访问门禁（ACCESS_MODE=off 时 enabled=false） */
  readonly access: AccessControl;
  listen(port?: number, host?: string): Promise<{ port: number; url: string }>;
  isReady(): boolean;
  /** 优雅停机：readyz 转 503、server:notice{shutdown}、刷快照与自动存档、关闭连接与数据库 */
  shutdown(reason: string): Promise<void>;
  /**
   * 关闭：flush（默认 true）时给所有房间写快照并自动存档；flush=false 模拟崩溃，只保留逐条写入的 journal。
   * 房间不会收到 room:closed（重启后恢复）。
   */
  close(o?: { flush?: boolean }): Promise<void>;
}

/** 真实引擎配套的电脑策略（architecture §5.11：SeatAiConfig.preset 经 resolveTraits 写入 aiTraits，策略按 traits 决策） */
export function aiPolicyOf(kind: 'original' | 'basic' = 'original'): AiPolicy {
  return kind === 'basic' ? BasicAiPolicy : OriginalAiPolicy;
}

/**
 * 按配置选择引擎与配套的 AI 策略：real = createEngine + OriginalAiPolicy（RICH4_AI_POLICY=basic 时 BasicAiPolicy）；
 * stub = 测试用 stubEngine + 本地策略。
 * stub 只在源码模式（tsx / vitest）可用：build.mjs 把 ../test/* 标为 external，生产包不含任何测试代码，
 * 在构建产物里选 stub 会得到明确的错误。
 */
export async function resolveEngine(
  kind: 'stub' | 'real',
  catalog: MapCatalog,
  log: Logger,
  devChecks = false,
  aiPolicy: 'original' | 'basic' = 'original',
): Promise<{ engine: EngineApi | null; policy: AiPolicy }> {
  if (kind === 'stub') {
    let mods: [typeof import('../test/helpers/stubEngine'), typeof import('../test/helpers/localPolicy')];
    try {
      mods = await Promise.all([import('../test/helpers/stubEngine'), import('../test/helpers/localPolicy')]);
    } catch (err) {
      throw new Error(`RICH4_TEST_ENGINE=stub 只能在源码模式（tsx）下使用：${String(err)}`);
    }
    const [{ createStubEngine }, { localPolicy }] = mods;
    log.warn('RICH4_TEST_ENGINE=stub：使用 12 格 stubEngine（仅供联调与测试）');
    return { engine: createStubEngine({ registry: catalog.registry }), policy: localPolicy };
  }
  try {
    return { engine: createEngine(catalog.registry, { devChecks }), policy: aiPolicyOf(aiPolicy) };
  } catch (err) {
    log.error({ err }, '真实引擎不可用：room:start 将返回 INTERNAL（可设 RICH4_TEST_ENGINE=stub 联调）');
    return { engine: null, policy: aiPolicyOf(aiPolicy) };
  }
}

/**
 * 纵深防御：素材包已启用而门禁关闭时，只有配置里显式的本机例外（config.assets.ungated，由 loadConfig 的启动守卫判定）
 * 才允许继续；否则（manifest 在 loadConfig 之后才出现、调用方自行构造的 config 与实际不符等）拒绝启动。
 */
export function assertPackGated(
  config: Pick<AppConfig, 'access' | 'assets'>,
  pack: Pick<PackRegistry, 'enabled' | 'dir'>,
): void {
  if (pack.enabled && config.access.mode === 'off' && !config.assets.ungated) {
    throw new ConfigError(
      `原版素材包已启用（${pack.dir}）而访问门禁关闭：拒绝启动。请设置 ACCESS_MODE=passcode 或 invite（见 deploy/.env.example）`,
    );
  }
}

/**
 * 启动时的门禁态势提示：未设门禁的素材包（本机显式例外）高亮告警；门禁开启但没有 TRUST_PROXY 时提醒限流按直连 IP 计；
 * 生产环境门禁开启而 PUBLIC_URL 不是 https（cookie 不带 Secure）记 error；口令哈希参数低于建议值、
 * invite 模式没有 ADMIN_TOKEN（容器里无法签发邀请码）时提醒。
 */
export function warnAccessPosture(
  log: Logger,
  config: Pick<AppConfig, 'access' | 'trustProxy' | 'publicUrl' | 'host' | 'assets'> &
    Partial<Pick<AppConfig, 'production' | 'adminToken'>>,
  pack: Pick<PackRegistry, 'enabled' | 'dir'>,
): void {
  if (pack.enabled && config.access.mode === 'off' && config.assets.ungated) {
    const bar = '!'.repeat(72);
    log.warn(bar);
    log.warn(
      { publicUrl: config.publicUrl, host: config.host, dir: pack.dir },
      '!!! 原版素材包未设访问门禁（RICH4_ASSETS_ALLOW_UNGATED=1，仅限本机开发）：能访问本端口的人都能下载素材 !!!',
    );
    log.warn(bar);
  }
  if (config.access.mode === 'off') return;
  if (!config.trustProxy && !isLocalhostUrl(config.publicUrl)) {
    log.warn(
      { publicUrl: config.publicUrl },
      'access: TRUST_PROXY=0，登录限流按直连 IP 计算；若服务器在反向代理之后，请设置 TRUST_PROXY=1',
    );
  }
  if (
    config.production === true &&
    !config.publicUrl.toLowerCase().startsWith('https:') &&
    !isLocalhostUrl(config.publicUrl)
  ) {
    log.error(
      { publicUrl: config.publicUrl },
      'access: 生产环境开启了访问门禁但 PUBLIC_URL 不是 https：访问 cookie 不带 Secure，会以明文发送；请改为 https 地址',
    );
  }
  const h = config.access.passcodeHash;
  if (h && belowRecommendedScrypt(h)) {
    log.warn(
      { N: h.N, r: h.r, p: h.p, recommended: RECOMMENDED_SCRYPT },
      'access: ACCESS_PASSCODE_HASH 的 scrypt 参数低于建议值，建议用 npx tsx scripts/access.ts hash 重新生成',
    );
  }
  if (config.access.mode === 'invite' && config.production === true && !config.adminToken) {
    log.warn(
      'access: ACCESS_MODE=invite 但没有设置 ADMIN_TOKEN：容器部署里无法签发邀请码（POST /admin/access/invites 需要它）',
    );
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

  // 持久化：房间快照与 journal、存档（design/net.md §8）
  let roomsRef: RoomManager | null = null;
  const ownsPersistence = deps.persistence === undefined;
  const persistence = deps.persistence ?? openPersistence({ kind: config.store, location: config.storePath });
  const signer = new Signer(resolveHmacSecret(config.saveHmacSecret, persistence, log));
  const saves = new SaveService({
    repo: persistence.saves,
    signer,
    engine: deps.engine,
    catalog,
    clock,
    log: log.child({ mod: 'saves' }),
    newId: () => `s_${randomBytes(9).toString('base64url')}`,
    // rooms 在下面创建；闭包里延迟取用
    inPlay: (id, code) => roomsRef?.isSaveInPlay(id, code) ?? false,
  });
  const persister = new RoomPersister({ store: persistence.rooms, scheduler, log: log.child({ mod: 'persist' }) });
  const chatFilter = deps.badWords
    ? createBadWordFilter(deps.badWords)
    : (() => {
        const f = loadBadWordFilter(config.badWordsPath);
        if (f.count > 0) log.info({ words: f.count }, 'chat bad-word list loaded');
        if (f.skipped.length > 0) log.warn({ skipped: f.skipped }, 'chat bad-word entries skipped');
        return f.filter;
      })();
  const eventLoop = new EventLoopMonitor();

  const fastify = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    // 与 Socket.IO 相同口径：只信任本机或私有网段的代理（design/net.md §10.3）
    trustProxy: config.trustProxy ? (address: string) => isTrustedProxy(address) : false,
    bodyLimit: SAVE_IMPORT_MAX_BYTES,
  });
  // 素材包与访问门禁（门禁钩子先于其他路由注册；/pack/* 无论是否启用都注册）
  const pack =
    deps.pack ??
    (await loadPackRegistry({ dir: config.assets.dir, verify: config.assets.verify, log: log.child({ mod: 'pack' }) }));
  let accessDb: DatabaseSync | null = null;
  let accessStore: AccessStore | null = null;
  if (config.access.mode !== 'off') {
    if (persistence.db) accessStore = new SqliteAccessStore(persistence.db);
    else {
      const opened = openAccessStore(accessDbPath(config));
      accessDb = opened.db;
      accessStore = opened.store;
    }
  }
  const access = new AccessControl({
    config: config.access,
    store: accessStore,
    log: log.child({ mod: 'access' }),
    roomExists: (code) => roomsRef?.get(code) !== undefined,
    packId: pack.enabled ? pack.packId : null,
    // 测试模式（E2E 全部页面来自 127.0.0.1，每个进房的页面都会自动生成授权）放宽每 IP 的授权数
    ...(config.testMode ? { grantsPerHour: GRANTS_PER_IP_PER_HOUR * 100 } : {}),
    ...deps.accessOptions,
  });
  try {
    assertPackGated(config, pack);
  } catch (err) {
    if (ownsPersistence) persistence.close();
    throw err;
  }
  warnAccessPosture(log, config, pack);
  const adminAuth = new AdminAuth({
    token: config.adminToken,
    log: log.child({ mod: 'admin' }),
    limiter: deps.adminLimiter ?? new AccessLimiter(deps.accessOptions?.now ? { now: deps.accessOptions.now } : {}),
  });
  await registerAccess(fastify, { access, log, admin: adminAuth });
  registerPack(fastify, { registry: pack });
  registerHealth(fastify, { isReady: () => ready && persistence.healthy(), startedAt });
  registerMaps(fastify, catalog);
  const limiter = new RateLimiter({
    scale: deps.rateLimitScale ?? 1,
    ...(config.testMode ? { ipScale: { create: TEST_MODE_IP_RELAX.create } } : {}),
  });
  await registerSavesHttp(fastify, { saves, limiter, log });
  await registerStatic(fastify, { staticDir: config.staticDir, publicUrl: config.publicUrl });

  const io = createIo(fastify.server, { trustProxy: config.trustProxy, devCorsOrigin: config.devCorsOrigin });
  // 已升级的连接（WebSocket）：停机宽限期满时要自己销毁（见 SHUTDOWN_HTTP_GRACE_MS）
  const upgraded = new Set<Duplex>();
  fastify.server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
  });
  const sessions = new SessionRegistry();
  const broadcaster = new RoomBroadcaster(ioEmitter(io));
  const think = deps.aiThinkMs;
  const ai = new AiDriver({
    policy: deps.aiPolicy ?? aiPolicyOf(config.aiPolicy),
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
    persist: persister,
    saves,
    chatFilter,
  });
  roomsRef = rooms;
  attachIo(
    io,
    { rooms, sessions, limiter, log, clock, testMode: config.testMode, saves },
    {
      trustProxy: config.trustProxy,
      devCorsOrigin: config.devCorsOrigin,
      access,
      // 生产环境经反代时，客户端 IP 塌缩成网关 / 代理地址要让运维看得见（io.ts privateClientIpWarner）
      warnPrivateClientIp: config.production,
      ...(config.testMode ? { maxConnectionsPerIp: MAX_CONNECTIONS_PER_IP * TEST_MODE_IP_RELAX.connections } : {}),
    },
  );

  // 启动恢复：快照 + journal 尾部重放（epoch+1，全员断线，暂停）
  const restoreReport = rooms.restore({
    store: persistence.rooms,
    maxAgeMs: deps.restoreMaxAgeMs ?? RESTORE_MAX_AGE_MS,
    openSave: (id) => saves.open(null, id),
    storeSave: (file, code, owners, verified) => saves.store(file, { kind: 'auto', roomCode: code, owners, verified }),
  });

  registerAdmin(fastify, {
    auth: adminAuth,
    stats: () => ({
      uptimeMs: Date.now() - startedAt,
      ready: ready && persistence.healthy(),
      rooms: rooms.stats(),
      connections: io.engine.clientsCount,
      sessions: sessions.size,
      memory: process.memoryUsage(),
      eventLoopDelayMs: eventLoop.snapshot(),
      persistence: { kind: persistence.kind, ...persister.stats, saves: persistence.saves.count() },
    }),
  });

  const backups =
    config.backupEnabled && persistence.db && persistence.location !== MEMORY_DB
      ? new BackupScheduler({ db: persistence.db, dir: config.backupDir, keep: config.backupKeep, log })
      : null;
  backups?.start();
  eventLoop.start();

  let closed = false;
  const close = async (o: { flush?: boolean } = {}): Promise<void> => {
    if (closed) return;
    closed = true;
    ready = false;
    rooms.draining = true;
    const flush = o.flush !== false;
    // 同步挂起全部房间（此后不再有 action）：刷快照、自动存档；不发 room:closed，客户端重连后由重启恢复接上
    const before = rooms.stats();
    const t0 = Date.now();
    rooms.suspendAll({ flush, autosave: flush });
    // 运维核对优雅停机是否走完刷盘（M11：docker compose logs app）
    log.info(
      { rooms: before.rooms, playing: before.playing, snapshot: flush, autosave: flush, ms: Date.now() - t0 },
      'shutdown: rooms suspended',
    );
    persister.dispose();
    eventLoop.stop();
    io.disconnectSockets(true);
    // HTTP 服务器关闭（见 SHUTDOWN_HTTP_GRACE_MS）：在途请求处理完就断开它的连接，宽限期满强制断开其余连接，
    // 连同还没完成关闭握手的 WebSocket
    const http = fastify.server;
    const sweep = setInterval(() => http.closeIdleConnections(), SHUTDOWN_IDLE_SWEEP_MS);
    const force = setTimeout(() => {
      // 运维与排查用：宽限期满时还挂着几条连接、其中几条是 WebSocket（getConnections 取的是此刻的计数）
      const websockets = upgraded.size;
      http.getConnections((_err, connections) =>
        log.info({ connections, websockets }, 'shutdown: grace period over, forcing connections closed'),
      );
      http.closeAllConnections();
      for (const socket of upgraded) socket.destroy();
    }, SHUTDOWN_HTTP_GRACE_MS);
    try {
      await new Promise<void>((r) => io.close(() => r()));
    } finally {
      clearInterval(sweep);
      clearTimeout(force);
    }
    await fastify.close().catch(() => {});
    await backups?.stop();
    if (ownsPersistence) persistence.close();
    accessDb?.close();
  };

  return {
    fastify,
    io,
    rooms,
    sessions,
    catalog,
    log,
    clock,
    persistence,
    saves,
    restoreReport,
    pack,
    access,
    async listen(port = config.port, host = config.host) {
      const addr = await fastify.listen({ port, host });
      ready = true;
      const a = fastify.server.address();
      const p = typeof a === 'object' && a ? a.port : port;
      log.info(
        {
          addr,
          maps: catalog.list().map((m) => `${m.id}${m.playable ? '' : '(pending)'}`),
          store: `${persistence.kind}:${persistence.location}`,
          restored: restoreReport.length,
          pack: pack.enabled ? pack.packId : null,
          access: access.mode,
        },
        'rich4 server listening',
      );
      return { port: p, url: `http://127.0.0.1:${p}` };
    },
    isReady: () => ready,
    async shutdown(reason) {
      if (closed) return;
      ready = false;
      rooms.draining = true;
      io.emit('server:notice', { kind: 'shutdown', message: '服务器即将重启，请稍后自动重连', reconnectInMs: 5000 });
      log.info({ reason, rooms: rooms.size }, 'shutdown: notifying clients');
      // 给 server:notice 一点时间送达，然后刷快照、自动存档、关库
      await new Promise((r) => setTimeout(r, 200));
      await close({ flush: true });
      log.info({ reason }, 'shutdown complete');
    },
    close,
  };
}
