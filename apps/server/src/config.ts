/**
 * 环境变量（architecture §9.2；design/net.md §10.1），用 zod 解析。
 *
 * RICH4_DATA_DIR 未设置时依次尝试 <cwd>/rich4-data 与仓库根目录下的 rich4-data（本机开发方便）；
 * 都没有 manifest.json 时只提供 fixture 地图。
 * RICH4_TEST_ENGINE=stub 时使用 test/helpers/stubEngine（真实引擎完成前的联调与 botplay 用）。
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { LogLevel } from './infra/logger';

const Flag = z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  PUBLIC_URL: z.url().optional(),
  DATA_DIR: z.string().min(1).default('.data'),
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
  STATIC_DIR: z.string().min(1).optional(),
  NODE_ENV: z.string().optional(),
});

export interface AppConfig {
  port: number;
  host: string;
  publicUrl: string;
  /** 可读写目录（M5 起放 sqlite 与备份） */
  dataDir: string;
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
    dataDir: abs(e.DATA_DIR),
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
    staticDir,
    production,
  };
}
