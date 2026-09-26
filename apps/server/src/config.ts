/**
 * 环境变量（architecture §9.2；design/net.md §10.1），用 zod 解析。
 *
 * RICH4_DATA_DIR 未设置时依次尝试 <cwd>/rich4-data 与仓库根目录下的 rich4-data（本机开发方便）；
 * 都没有 manifest.json 时只提供 fixture 地图。
 * RICH4_TEST_ENGINE=stub 时使用 test/helpers/stubEngine（只在源码模式 tsx / vitest 下可用，构建产物不含测试代码）。
 *
 * 持久化（M5）：DATA_DIR 下的 rich4.db（STORE=sqlite，默认）或 store/ 目录（STORE=json，备用）；
 * DATA_DIR/badwords.txt 为聊天敏感词表；DATA_DIR/backup 为每日备份（BACKUP_ENABLED=0 关闭，BACKUP_KEEP 份数）。
 * 生产环境（NODE_ENV=production）必须设置 SAVE_HMAC_SECRET（≥32 字节）。
 * RICH4_AI_POLICY=original|basic 选择电脑策略（默认 original）；RICH4_TIMER_SCALE 只在测试模式下缩放决策计时。
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { LogLevel } from './infra/logger';

const Flag = z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  PUBLIC_URL: z.url().optional(),
  /** 开发默认放在 .cache/data（仓库 .gitignore 已忽略 .cache/）；生产由 compose 设为 /data */
  DATA_DIR: z.string().min(1).default('.cache/data'),
  RICH4_DATA_DIR: z.string().min(1).optional(),
  DEFAULT_MAP: z.string().min(1).default('taiwan'),
  SAVE_HMAC_SECRET: z.string().min(32).optional(),
  TRUST_PROXY: Flag.default(false),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_PRETTY: Flag.optional(),
  MAX_ROOMS: z.coerce.number().int().min(1).default(500),
  ROOM_ABANDON_TTL_MIN: z.coerce.number().min(0).default(30),
  ADMIN_TOKEN: z.string().min(1).optional(),
  DEV_CORS_ORIGIN: z.string().min(1).optional(),
  RICH4_TEST_MODE: Flag.default(false),
  RICH4_TEST_ENGINE: z.enum(['stub', 'real']).default('real'),
  /** 电脑策略：original = 原版 AI（OriginalAiPolicy，默认）；basic = BasicAiPolicy（排查问题时对照用） */
  RICH4_AI_POLICY: z.enum(['original', 'basic']).default('original'),
  /** 计时倍率（只在 RICH4_TEST_MODE=1 时生效，E2E 用来缩短超时等待）；生产恒为 1 */
  RICH4_TIMER_SCALE: z.coerce.number().positive().max(1).optional(),
  STATIC_DIR: z.string().min(1).optional(),
  NODE_ENV: z.string().optional(),
  STORE: z.enum(['sqlite', 'json']).default('sqlite'),
  BACKUP_ENABLED: Flag.default(true),
  BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(7),
});

export interface AppConfig {
  port: number;
  host: string;
  publicUrl: string;
  /** 可读写目录：sqlite、备份、敏感词表 */
  dataDir: string;
  /** 存储实现 */
  store: 'sqlite' | 'json';
  /** sqlite 文件（或 ':memory:'）；json 存储时为目录 */
  storePath: string;
  backupEnabled: boolean;
  backupDir: string;
  backupKeep: number;
  /** 聊天敏感词表（不存在时不过滤） */
  badWordsPath: string;
  /** 只读数据目录；null 表示只提供 fixture 地图 */
  rich4DataDir: string | null;
  defaultMap: string;
  saveHmacSecret: string | null;
  trustProxy: boolean;
  logLevel: LogLevel;
  logPretty: boolean;
  maxRooms: number;
  roomAbandonTtlMin: number;
  adminToken: string | null;
  devCorsOrigin: string | null;
  testMode: boolean;
  testEngine: 'stub' | 'real';
  aiPolicy: 'original' | 'basic';
  /** Deadlines.timerScale；非测试模式恒为 1 */
  timerScale: number;
  staticDir: string | null;
  production: boolean;
}

/** apps/server/src → 仓库根目录 */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function firstExisting(cands: string[], marker: string): string | null {
  for (const c of cands) if (existsSync(resolve(c, marker))) return resolve(c);
  return null;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): AppConfig {
  const r = EnvSchema.safeParse(env);
  if (!r.success) {
    const where = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`环境变量无效：${where}`);
  }
  const e = r.data;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
  const production = e.NODE_ENV === 'production';
  if (production && !e.SAVE_HMAC_SECRET) {
    throw new ConfigError('环境变量无效：SAVE_HMAC_SECRET 在生产环境必填（≥32 字节随机串）');
  }
  const dataDir = abs(e.DATA_DIR);
  const rich4DataDir = e.RICH4_DATA_DIR
    ? abs(e.RICH4_DATA_DIR)
    : firstExisting([resolve(cwd, 'rich4-data'), resolve(REPO_ROOT, 'rich4-data')], 'manifest.json');
  const staticDir = e.STATIC_DIR
    ? abs(e.STATIC_DIR)
    : firstExisting([resolve(REPO_ROOT, 'apps/client/dist')], 'index.html');
  return {
    port: e.PORT,
    host: e.HOST,
    publicUrl: e.PUBLIC_URL ?? `http://localhost:${e.PORT}`,
    dataDir,
    store: e.STORE,
    storePath: e.STORE === 'json' ? join(dataDir, 'store') : join(dataDir, 'rich4.db'),
    backupEnabled: e.BACKUP_ENABLED,
    backupDir: join(dataDir, 'backup'),
    backupKeep: e.BACKUP_KEEP,
    badWordsPath: join(dataDir, 'badwords.txt'),
    rich4DataDir,
    defaultMap: e.DEFAULT_MAP,
    saveHmacSecret: e.SAVE_HMAC_SECRET ?? null,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    logPretty: e.LOG_PRETTY ?? !production,
    maxRooms: e.MAX_ROOMS,
    roomAbandonTtlMin: e.ROOM_ABANDON_TTL_MIN,
    adminToken: e.ADMIN_TOKEN ?? null,
    devCorsOrigin: e.DEV_CORS_ORIGIN ?? null,
    testMode: e.RICH4_TEST_MODE,
    testEngine: e.RICH4_TEST_ENGINE,
    aiPolicy: e.RICH4_AI_POLICY,
    timerScale: e.RICH4_TEST_MODE ? (e.RICH4_TIMER_SCALE ?? 1) : 1,
    staticDir,
    production,
  };
}
