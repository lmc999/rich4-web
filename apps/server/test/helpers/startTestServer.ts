/**
 * 集成测试用服务器（design/net.md §11.1）：真实 Fastify + Socket.IO，监听 127.0.0.1 随机端口。
 * 默认：fixture 地图、stubEngine（RICH4_TEST_ENGINE=real 时换真实引擎）、计时缩到 2%、不等动画、
 * AI 思考 0ms、断线宽限 0.3 秒、测试模式（debug:act 可用）。manual=true 时注入 ManualScheduler。
 * 持久化默认内存 SQLite；给 dataDir 时用该目录下的 rich4.db（重启恢复测试用同一目录再起一个 app）。不做定时备份。
 * 原版皮肤：assetsDir 加载素材包（不经 loadConfig 的启动守卫，但 createApp 的纵深防御仍要求门禁或 ungated=true）；
 * access 覆盖门禁配置（mode、passcodeHash 等）；staticDir 托管前端外壳。
 */
import { join } from 'node:path';
import type { AiPolicy } from '@rich4/shared/ai';
import { OriginalAiPolicy } from '@rich4/shared/ai';
import { createEngine, type EngineApi } from '@rich4/shared/engine';
import type { RoomSettings } from '@rich4/shared/net';
import { type App, type AppDeps, createApp } from '../../src/app';
import { type AccessEnvConfig, loadConfig } from '../../src/config';
import { fixtureCatalog, type MapCatalog } from '../../src/data/DataRegistry';
import type { TimingOptions } from '../../src/game/Deadlines';
import { createLogger, silentLogger } from '../../src/infra/logger';
import type { RoomTtls } from '../../src/rooms/Room';
import { localPolicy } from './localPolicy';
import { ManualScheduler } from './manualScheduler';
import { createStubEngine } from './stubEngine';

export type TestEngineKind = 'stub' | 'real';

export function testEngineKind(): TestEngineKind {
  return process.env.RICH4_TEST_ENGINE === 'real' ? 'real' : 'stub';
}

export interface TestServerOptions {
  engine?: TestEngineKind;
  manual?: boolean;
  timing?: Partial<TimingOptions>;
  aiThinkMs?: readonly [number, number];
  rateLimitScale?: number;
  roomDefaults?: Partial<Omit<RoomSettings, 'game'>>;
  roomTtls?: Partial<RoomTtls>;
  testMode?: boolean;
  policy?: AiPolicy;
  catalog?: MapCatalog;
  /** 打开日志（调试用） */
  verbose?: boolean;
  /** 数据目录：rich4.db（或 JSON 存储的 store/）放在这里；缺省为内存 SQLite */
  dataDir?: string;
  store?: 'sqlite' | 'json';
  /** 聊天敏感词 */
  badWords?: readonly string[];
  adminToken?: string;
  /** 固定的存档签名密钥（跨 app 实例验签） */
  hmacSecret?: string;
  /** 原版皮肤素材包目录 */
  assetsDir?: string;
  /** 素材包不设门禁的本机例外（loadConfig 判定的 assets.ungated）；缺省 false：门禁关闭时 createApp 拒绝启动 */
  ungated?: boolean;
  assetsVerify?: 'quick' | 'full';
  /** 覆盖访问门禁配置（缺省 mode=off） */
  access?: Partial<AccessEnvConfig>;
  accessOptions?: AppDeps['accessOptions'];
  /** 前端外壳目录（index.html） */
  staticDir?: string;
  publicUrl?: string;
}

export interface TestServer {
  url: string;
  app: App;
  sched: ManualScheduler | null;
  engine: EngineApi;
  engineKind: TestEngineKind;
  close(o?: { flush?: boolean }): Promise<void>;
}

/** 测试用固定 HMAC 密钥（≥32 字节） */
export const TEST_HMAC_SECRET = 'rich4-test-hmac-secret-0123456789abcdef';

export async function startTestServer(o: TestServerOptions = {}): Promise<TestServer> {
  const engineKind = o.engine ?? testEngineKind();
  const catalog = o.catalog ?? fixtureCatalog();
  const engine =
    engineKind === 'real'
      ? createEngine(catalog.registry, { devChecks: true })
      : createStubEngine({ registry: catalog.registry });
  const policy = o.policy ?? (engineKind === 'real' ? OriginalAiPolicy : localPolicy);
  const base = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    PUBLIC_URL: o.publicUrl ?? 'http://rich4.test',
    RICH4_TEST_MODE: o.testMode === false ? '0' : '1',
    LOG_LEVEL: 'silent',
  });
  const config = {
    ...base,
    rich4DataDir: null,
    staticDir: o.staticDir ?? null,
    assets: {
      dir: o.assetsDir ?? null,
      present: o.assetsDir !== undefined,
      verify: o.assetsVerify ?? 'quick',
      ungated: o.ungated ?? false,
    },
    access: { ...base.access, ...o.access },
    backupEnabled: false,
    saveHmacSecret: o.hmacSecret ?? TEST_HMAC_SECRET,
    adminToken: o.adminToken ?? null,
    ...(o.dataDir
      ? {
          dataDir: o.dataDir,
          store: o.store ?? 'sqlite',
          storePath: o.store === 'json' ? join(o.dataDir, 'store') : join(o.dataDir, 'rich4.db'),
          badWordsPath: join(o.dataDir, 'badwords.txt'),
        }
      : { store: 'sqlite' as const, storePath: ':memory:', badWordsPath: '/nonexistent/badwords.txt' }),
  };
  const sched = o.manual ? new ManualScheduler({ autoRunZero: true }) : null;
  const app = await createApp({
    config,
    catalog,
    engine,
    aiPolicy: policy,
    log: o.verbose ? createLogger({ level: 'debug', pretty: true }) : silentLogger,
    ...(sched ? { clock: sched, scheduler: sched } : {}),
    timing: { timerScale: 0.02, animScale: 0, ...o.timing },
    aiThinkMs: o.aiThinkMs ?? [0, 0],
    rateLimitScale: o.rateLimitScale ?? 1,
    roomDefaults: { reconnectGraceSec: 0.3, ...o.roomDefaults },
    ...(o.roomTtls ? { roomTtls: o.roomTtls } : {}),
    ...(o.badWords ? { badWords: o.badWords } : {}),
    ...(o.accessOptions ? { accessOptions: o.accessOptions } : {}),
  });
  const { url } = await app.listen(0, '127.0.0.1');
  return { url, app, sched, engine, engineKind, close: (c) => app.close(c) };
}
