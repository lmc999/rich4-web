/**
 * 门禁管理命令（scripts/access.ts 的实现；docs/design/original-skin.md U4、design-draft §5.3）。
 *
 *   npx tsx scripts/access.ts hash [--stdin] [--N 32768 --r 8 --p 1]   生成 ACCESS_PASSCODE_HASH（口令不回显、不落盘）
 *   npx tsx scripts/access.ts secret                                   生成 ACCESS_SECRET（48 字节随机）
 *   npx tsx scripts/access.ts invite [--uses 5] [--days 7|--no-expiry] [--note 文本]   生成邀请码（只显示一次）
 *   npx tsx scripts/access.ts list                                     列出邀请码与当前 epoch
 *   npx tsx scripts/access.ts revoke [--invite <id>]                   不带参数：epoch+1，全部 cookie 与授权立即失效
 *
 * 数据库：--db <path>；缺省与服务器相同（DATA_DIR 默认 .cache/data；STORE=sqlite 用 rich4.db，STORE=json 用 access.db）。
 * invite / list / revoke **只打开已存在的库**：路径不存在时报错退出（DATA_DIR 打错时不会新建空库、假装吊销成功）；
 * 服务器第一次启动之前就要预先生成邀请码时加 --create。输出里带数据库路径，revoke 输出旧 / 新 epoch。
 * 服务器运行时也可以执行（WAL + busy_timeout；服务器每秒至多缓存一次 epoch）。
 * docker compose 部署的生产镜像里没有这个 CLI（只有 server/main.mjs）：容器部署用 ADMIN_TOKEN 调管理接口
 * （POST /admin/access/invites、GET /admin/access/invites、POST /admin/access/revoke，见 deploy/.env.example）。
 */
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { AccessDbMissingError, accessDbPath, type InviteRecord, openAccessStore } from './AccessStore';
import { DEFAULT_SCRYPT, hashPasscode, PASSCODE_MIN_RECOMMENDED, type ScryptParams } from './passcode';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** 读取整个标准输入（非交互） */
  readStdin(): Promise<string>;
  /** 交互式读取口令（不回显）；没有终端时为 null */
  promptHidden: ((question: string) => Promise<string>) | null;
  env: Record<string, string | undefined>;
  cwd: string;
  now?: () => number;
}

const USAGE = `用法：npx tsx scripts/access.ts <命令> [选项]
  hash [--stdin] [--N <2^k>] [--r <n>] [--p <n>]   生成 ACCESS_PASSCODE_HASH（交互输入两次；--stdin 从标准输入读第一行）
  secret                                            生成 ACCESS_SECRET
  invite [--uses <n>] [--days <d> | --no-expiry] [--note <文本>] [--db <path>] [--create]   生成邀请码（默认 1 次、7 天）
  list [--db <path>]                                列出邀请码
  revoke [--invite <id>] [--db <path>]              吊销：不带 --invite 时 epoch+1，全部会话与授权立即失效
数据库缺省与服务器一致：DATA_DIR（默认 .cache/data）下的 rich4.db（STORE=json 时为 access.db）；
库不存在时报错（服务器首次启动前预先生成邀请码可加 --create）。
docker compose 部署的镜像里没有本命令：用 ADMIN_TOKEN 调 /admin/access/*（见 deploy/.env.example）`;

interface Args {
  cmd: string | null;
  flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string | true>();
  let cmd: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(a.slice(2), next);
          i++;
        } else flags.set(a.slice(2), true);
      }
    } else if (cmd === null) cmd = a;
    else throw new Error(`多余的参数：${a}`);
  }
  return { cmd, flags };
}

function num(flags: Map<string, string | true>, name: string, dflt: number): number {
  const v = flags.get(name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (v === true || !Number.isFinite(n)) throw new Error(`--${name} 需要数字`);
  return n;
}

function str(flags: Map<string, string | true>, name: string): string | null {
  const v = flags.get(name);
  if (v === undefined) return null;
  if (v === true) throw new Error(`--${name} 需要参数`);
  return v;
}

/** 与服务器相同的门禁库路径 */
export function defaultAccessDbPath(env: Record<string, string | undefined>, cwd: string): string {
  const dataDir = env.DATA_DIR
    ? isAbsolute(env.DATA_DIR)
      ? env.DATA_DIR
      : resolve(cwd, env.DATA_DIR)
    : resolve(cwd, '.cache/data');
  const store = env.STORE === 'json' ? 'json' : 'sqlite';
  return accessDbPath({ store, storePath: join(dataDir, 'rich4.db'), dataDir });
}

function fmtTime(ms: number | null): string {
  return ms === null ? '不过期' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function fmtInvite(i: InviteRecord, now: number): string {
  const state = i.revoked
    ? '已撤销'
    : i.usesLeft <= 0
      ? '已用完'
      : i.expiresAt !== null && i.expiresAt <= now
        ? '已过期'
        : '有效';
  return `${i.id}  ${state}  剩余 ${i.usesLeft} 次  到期 ${fmtTime(i.expiresAt)}  ${i.note}`.trimEnd();
}

async function readPasscode(io: CliIo, fromStdin: boolean): Promise<string> {
  if (fromStdin || !io.promptHidden) {
    const text = await io.readStdin();
    const line = text.split(/\r?\n/)[0] ?? '';
    if (line.length === 0) throw new Error('标准输入里没有口令');
    return line;
  }
  const a = await io.promptHidden('口令：');
  const b = await io.promptHidden('再输一次：');
  if (a !== b) throw new Error('两次输入不一致');
  if (a.length === 0) throw new Error('口令不能为空');
  return a;
}

/** 返回进程退出码 */
export async function runAccessCli(argv: readonly string[], io: CliIo): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const now = io.now ?? (() => Date.now());
  const { cmd, flags } = args;
  try {
    switch (cmd) {
      case 'hash': {
        const params: ScryptParams = {
          N: num(flags, 'N', DEFAULT_SCRYPT.N),
          r: num(flags, 'r', DEFAULT_SCRYPT.r),
          p: num(flags, 'p', DEFAULT_SCRYPT.p),
        };
        const pass = await readPasscode(io, flags.has('stdin'));
        if ([...pass].length < PASSCODE_MIN_RECOMMENDED) {
          io.err(
            `警告：口令少于 ${PASSCODE_MIN_RECOMMENDED} 个字，建议用更长的口令（登录有退避限流，但弱口令仍可能被猜中）`,
          );
        }
        const h = await hashPasscode(pass, params);
        io.out(h);
        io.err(`写入部署环境（deploy/.env）：ACCESS_PASSCODE_HASH=${h}`);
        return 0;
      }
      case 'secret': {
        io.out(randomBytes(48).toString('base64url'));
        return 0;
      }
      case 'invite':
      case 'list':
      case 'revoke': {
        const dbPath = str(flags, 'db') ?? defaultAccessDbPath(io.env, io.cwd);
        const create = cmd === 'invite' && flags.has('create');
        let opened: ReturnType<typeof openAccessStore>;
        try {
          opened = openAccessStore(dbPath, { create });
        } catch (err) {
          if (!(err instanceof AccessDbMissingError)) throw err;
          io.err(
            `错误：门禁数据库不存在：${dbPath}\n` +
              '检查 DATA_DIR / STORE（与服务器一致）或用 --db 指定服务器实际使用的库' +
              (cmd === 'invite' ? '；服务器首次启动前预先生成邀请码可加 --create' : ''),
          );
          return 1;
        }
        const { store, db } = opened;
        try {
          if (cmd === 'invite') {
            const uses = num(flags, 'uses', 1);
            const days = flags.has('no-expiry') ? null : num(flags, 'days', 7);
            if (!Number.isInteger(uses) || uses < 1 || uses > 1000) throw new Error('--uses 应为 1–1000 的整数');
            if (days !== null && !(days > 0 && days <= 3650)) throw new Error('--days 应在 (0, 3650]');
            const note = str(flags, 'note') ?? '';
            const t = now();
            const r = store.createInvite({
              uses,
              expiresAt: days === null ? null : t + Math.round(days * 86_400_000),
              note,
              now: t,
            });
            io.out(r.code);
            io.err(
              `邀请码 ${r.invite.id}：可用 ${uses} 次，到期 ${fmtTime(r.invite.expiresAt)}（邀请码只显示这一次；数据库 ${dbPath}）`,
            );
            return 0;
          }
          if (cmd === 'list') {
            const t = now();
            io.out(`epoch ${store.epoch()}（数据库 ${dbPath}）`);
            const all = store.listInvites();
            if (all.length === 0) io.out('（没有邀请码）');
            for (const i of all) io.out(fmtInvite(i, t));
            return 0;
          }
          const id = str(flags, 'invite');
          if (id !== null) {
            if (!store.revokeInvite(id)) {
              io.err(`没有可撤销的邀请码 ${id}`);
              return 1;
            }
            io.out(
              `已撤销邀请码 ${id}（数据库 ${dbPath}；已用它登录的会话仍有效，需要时再执行 revoke 让全部会话失效）`,
            );
            return 0;
          }
          const before = store.epoch();
          const e = store.bumpEpoch();
          io.out(
            `已吊销全部会话与未兑换的房间授权：epoch ${before} → ${e}（数据库 ${dbPath}；使用这个库的服务器 1 秒内生效）`,
          );
          return 0;
        } finally {
          db.close();
        }
      }
      case null:
      case 'help':
        io.out(USAGE);
        return cmd === null ? 2 : 0;
      default:
        io.err(`未知命令：${cmd}\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    io.err(`错误：${(err as Error).message}`);
    return 1;
  }
}
