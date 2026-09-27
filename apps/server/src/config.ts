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
 *
 * 原版皮肤素材包与访问门禁（docs/design/original-skin.md U4、§3 修正 3；design-draft §5.1）：
 * - RICH4_ASSETS_DIR：只读素材包目录，**只认显式设置**（不自动探测仓库里的 rich4-assets/）；目录里有 manifest.json
 *   即视为「启用素材包」参与下面的启动守卫，是否真正提供由 assets/PackRegistry 校验 manifest 后决定。
 *   RICH4_ASSETS_VERIFY=quick（结构、存在、字节数）| full（另外逐文件复算 sha256）。
 * - ACCESS_MODE=off|passcode|invite；passcode 需要 ACCESS_PASSCODE_HASH（scripts/access.ts hash 生成，不存明文）；
 *   非 off 时需要 ACCESS_SECRET（≥32 字节，cookie 签名；更换即让全部会话失效）。ACCESS_TTL_DAYS=30、ACCESS_GRANTS=1。
 * - **启动守卫**：启用素材包且 ACCESS_MODE=off 时拒绝启动（ConfigError），唯一例外是同时满足
 *   NODE_ENV!==production、PUBLIC_URL 为 localhost、TRUST_PROXY=0、监听地址 HOST 为回环地址（不设 HOST 时此例外下
 *   默认 127.0.0.1），并显式设置 RICH4_ASSETS_ALLOW_UNGATED=1；此时启动日志高亮告警。回环 HOST 只是**附加的**必要条件，
 *   不是充分条件（同机反代到公网时 HOST 也是回环地址，所以其余条件缺一不可）。
 * - 生产环境（NODE_ENV=production）开启门禁时必须显式设置 PUBLIC_URL（cookie 的 Secure 取决于它是否 https；
 *   缺省的 http://localhost 在生产里必然是漏填）；为 http 时启动日志以 error 级提示 cookie 不带 Secure。
 * - ADMIN_TOKEN 能签发邀请码与吊销会话：门禁开启时至少 32 字节（建议 npx tsx scripts/access.ts secret 生成）。
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCESS_MODES, type AccessMode } from '@rich4/shared/net';
import { z } from 'zod';
import { type PasscodeHash, parsePasscodeHash } from './access/passcode';
import type { LogLevel } from './infra/logger';

const Flag = z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true');
/** 空字符串视为未设置（.env 里留空的 `ACCESS_SECRET=` 之类，报「需要 X」而不是「长度不足」） */
const OptionalText = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /** 缺省 0.0.0.0；未设门禁的素材包本机例外下缺省 127.0.0.1 */
  HOST: z.string().min(1).optional(),
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
  RICH4_ASSETS_DIR: OptionalText,
  RICH4_ASSETS_VERIFY: z.enum(['quick', 'full']).default('quick'),
  RICH4_ASSETS_ALLOW_UNGATED: Flag.default(false),
  ACCESS_MODE: z.enum(ACCESS_MODES).default('off'),
  ACCESS_PASSCODE_HASH: OptionalText,
  ACCESS_SECRET: OptionalText,
  ACCESS_TTL_DAYS: z.coerce
    .number()
    .min(1 / 24)
    .max(365)
    .default(30),
  ACCESS_GRANTS: Flag.default(true),
});

/** 素材包配置 */
export interface AssetsConfig {
  /** 只读素材包目录（未设置为 null） */
  dir: string | null;
  /** 目录里有 manifest.json（参与启动守卫；是否合法由 PackRegistry 判定） */
  present: boolean;
  verify: 'quick' | 'full';
  /** 素材包存在但未设门禁（仅本机开发的显式例外；启动日志高亮告警） */
  ungated: boolean;
}

/** 访问门禁配置（与 access/AccessControl 的 AccessConfig 同形） */
export interface AccessEnvConfig {
  mode: AccessMode;
  passcodeHash: PasscodeHash | null;
  secret: string | null;
  ttlDays: number;
  grants: boolean;
  /** PUBLIC_URL 为 https 时 cookie 带 Secure */
  secure: boolean;
}

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
  assets: AssetsConfig;
  access: AccessEnvConfig;
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

/** PUBLIC_URL 的主机是否为本机（localhost、*.localhost、127.0.0.0/8、::1） */
export function isLocalhostUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** 监听地址是否为回环地址（localhost、127.0.0.0/8、::1） */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** ACCESS_SECRET 至少 32 字节（按 UTF-8 计） */
export const ACCESS_SECRET_MIN_BYTES = 32;
/** 门禁开启时 ADMIN_TOKEN 至少 32 字节 */
export const ADMIN_TOKEN_MIN_BYTES = 32;

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
  const publicUrl = e.PUBLIC_URL ?? `http://localhost:${e.PORT}`;

  // ───────────── 访问门禁 ─────────────
  let passcodeHash: PasscodeHash | null = null;
  if (e.ACCESS_PASSCODE_HASH !== undefined) {
    const h = parsePasscodeHash(e.ACCESS_PASSCODE_HASH);
    if (!h.ok) throw new ConfigError(`环境变量无效：ACCESS_PASSCODE_HASH ${h.reason}`);
    passcodeHash = h.value;
  }
  if (e.ACCESS_MODE === 'passcode' && !passcodeHash) {
    throw new ConfigError(
      '环境变量无效：ACCESS_MODE=passcode 需要 ACCESS_PASSCODE_HASH（npx tsx scripts/access.ts hash 生成）',
    );
  }
  const secret = e.ACCESS_SECRET ?? null;
  if (secret !== null && Buffer.byteLength(secret, 'utf8') < ACCESS_SECRET_MIN_BYTES) {
    throw new ConfigError(
      `环境变量无效：ACCESS_SECRET 至少 ${ACCESS_SECRET_MIN_BYTES} 字节（建议 openssl rand -base64 48）`,
    );
  }
  if (e.ACCESS_MODE !== 'off' && secret === null) {
    throw new ConfigError(`环境变量无效：ACCESS_MODE=${e.ACCESS_MODE} 需要 ACCESS_SECRET（≥32 字节随机串）`);
  }
  if (
    e.ACCESS_MODE !== 'off' &&
    e.ADMIN_TOKEN !== undefined &&
    Buffer.byteLength(e.ADMIN_TOKEN, 'utf8') < ADMIN_TOKEN_MIN_BYTES
  ) {
    throw new ConfigError(
      `环境变量无效：访问门禁开启时 ADMIN_TOKEN 至少 ${ADMIN_TOKEN_MIN_BYTES} 字节（它能签发邀请码、吊销会话；` +
        '用 npx tsx scripts/access.ts secret 生成）',
    );
  }
  if (production && e.ACCESS_MODE !== 'off' && e.PUBLIC_URL === undefined) {
    throw new ConfigError(
      `环境变量无效：生产环境开启访问门禁（ACCESS_MODE=${e.ACCESS_MODE}）时必须设置 PUBLIC_URL` +
        '（对外的 https 地址；cookie 的 Secure 属性取决于它）',
    );
  }

  // ───────────── 素材包与启动守卫 ─────────────
  const assetsDir = e.RICH4_ASSETS_DIR ? abs(e.RICH4_ASSETS_DIR) : null;
  const present = assetsDir !== null && existsSync(join(assetsDir, 'manifest.json'));
  let ungated = false;
  let host = e.HOST ?? '0.0.0.0';
  if (present && e.ACCESS_MODE === 'off') {
    // 本机例外下不设 HOST 时只监听回环地址
    if (e.HOST === undefined) host = '127.0.0.1';
    const unmet: string[] = [];
    if (production) unmet.push('NODE_ENV=production');
    if (!isLocalhostUrl(publicUrl)) unmet.push(`PUBLIC_URL=${publicUrl} 不是 localhost`);
    if (e.TRUST_PROXY) unmet.push('TRUST_PROXY=1');
    if (!isLoopbackHost(host)) unmet.push(`HOST=${host} 不是回环地址`);
    if (!e.RICH4_ASSETS_ALLOW_UNGATED) unmet.push('未设置 RICH4_ASSETS_ALLOW_UNGATED=1');
    if (unmet.length > 0) {
      throw new ConfigError(
        `启用原版素材包（RICH4_ASSETS_DIR=${assetsDir}）时必须设置访问门禁：ACCESS_MODE=passcode 或 invite（见 deploy/.env.example）。` +
          `只有本机开发（NODE_ENV 非 production、PUBLIC_URL 为 localhost、TRUST_PROXY=0、HOST 为回环地址或不设，` +
          `并显式设置 RICH4_ASSETS_ALLOW_UNGATED=1）才允许不设门禁；当前不满足：${unmet.join('；')}`,
      );
    }
    ungated = true;
  }

  return {
    port: e.PORT,
    host,
    publicUrl,
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
    assets: { dir: assetsDir, present, verify: e.RICH4_ASSETS_VERIFY, ungated },
    access: {
      mode: e.ACCESS_MODE,
      passcodeHash,
      secret,
      ttlDays: e.ACCESS_TTL_DAYS,
      grants: e.ACCESS_GRANTS,
      secure: publicUrl.toLowerCase().startsWith('https:'),
    },
  };
}
