/**
 * 访问门禁的持久化（docs/design/original-skin.md U4；design-draft §5.3）：
 * - access_meta：`epoch`（+1 即吊销全部 cookie 与未兑换的房间授权）；
 * - access_invites：管理员生成的邀请码（只存 sha256，可限次、限期、单独撤销；撤销同时让用它登录的会话失效，
 *   所以用完、撤销的邀请码都留到到期才清理，不过期的一直保留）；
 * - access_grants：房间邀请授权（只存 token 的 sha256；30 分钟、1 次、绑定签发时的 epoch 与房间实例 room_iid）。
 *   room_iid 列是 architecture §35 加的（旧库启动时 ALTER TABLE 补上，旧授权的 room_iid 为空串、一律不能再兑换）。
 *
 * 表用 CREATE TABLE IF NOT EXISTS 建立，不占用 persistence/db.ts 的 schema_version（与房间、存档的迁移互不影响）。
 * STORE=sqlite 时与 rich4.db 同库；STORE=json 时单独使用 DATA_DIR/access.db（见 accessDbPath）。
 * scripts/access.ts 可以在服务器运行时打开同一个库（WAL + busy_timeout）：服务器每秒至多缓存一次 epoch。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MEMORY_DB, transaction } from '../persistence/db';

export interface InviteRecord {
  id: string;
  usesLeft: number;
  /** 毫秒时间戳；null 表示不过期 */
  expiresAt: number | null;
  createdAt: number;
  note: string;
  revoked: boolean;
}

export interface GrantRecord {
  room: string;
  /** 房间实例（net/accessScope.ts 的 roomInstanceOf）；兑换得到的 g cookie 绑定它 */
  instance: string;
  usesLeft: number;
  expiresAt: number;
  epoch: number;
}

export interface AccessStore {
  epoch(): number;
  /** epoch + 1，返回新值 */
  bumpEpoch(): number;
  /** 生成邀请码；code 只在这里返回一次（库里只有哈希） */
  createInvite(o: { uses: number; expiresAt: number | null; note?: string; now: number }): {
    code: string;
    invite: InviteRecord;
  };
  /** 兑换邀请码（成功时次数 −1，返回它的 id 与到期时间）；无效、用完、过期、已撤销返回 null */
  redeemInvite(code: string, now: number): { id: string; expiresAt: number | null } | null;
  listInvites(): InviteRecord[];
  /** 撤销单个邀请码：不能再登录，用它登录的会话（cookie 带这个 id）也随之失效 */
  revokeInvite(id: string): boolean;
  /** 已撤销的邀请码 id（AccessControl 按秒缓存，用来让这些会话失效） */
  revokedInviteIds(): string[];
  /** 生成房间授权（绑定房间实例）；token 只在这里返回一次 */
  createGrant(o: {
    room: string;
    instance: string;
    uses: number;
    expiresAt: number;
    epoch: number;
    now: number;
  }): string;
  /** 兑换房间授权：存在、未过期、有剩余次数、epoch 与当前一致、带房间实例时次数 −1 并返回记录 */
  redeemGrant(token: string, now: number, epoch: number): GrantRecord | null;
  /** 只查询（不消耗次数）；条件同 redeemGrant */
  peekGrant(token: string, now: number, epoch: number): GrantRecord | null;
  /** 删除过期或用完的授权，以及过期的邀请码（用完、撤销而未过期的邀请码保留：撤销状态还要用来拦会话） */
  prune(now: number): number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS access_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS access_invites(
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, uses_left INTEGER NOT NULL,
  expires_at INTEGER, created_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', revoked INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS access_grants(
  token_hash TEXT PRIMARY KEY, room TEXT NOT NULL, uses_left INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, epoch INTEGER NOT NULL, created_at INTEGER NOT NULL,
  room_iid TEXT NOT NULL DEFAULT ''
) STRICT, WITHOUT ROWID;
`;

/** 旧库（§35 之前建的 access_grants 没有 room_iid）补列；已有的授权 room_iid 为空串，兑换时不认 */
function migrateGrants(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(access_grants)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'room_iid')) {
    db.exec("ALTER TABLE access_grants ADD COLUMN room_iid TEXT NOT NULL DEFAULT ''");
  }
}

/** 邀请码字母表：Crockford base32（去掉 I L O U，输入时容错映射） */
const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 邀请码：16 个字符（80 位熵），显示为 XXXX-XXXX-XXXX-XXXX */
export const INVITE_CODE_LEN = 16;

/** 规范化用户输入的邀请码：去掉空白与连字符、转大写、O→0、I/L→1；字符不合法或长度不对返回 null */
export function normalizeInviteCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== INVITE_CODE_LEN) return null;
  for (const ch of s) if (!INVITE_ALPHABET.includes(ch)) return null;
  return s;
}

function newInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LEN);
  let s = '';
  for (let i = 0; i < INVITE_CODE_LEN; i++) s += INVITE_ALPHABET[bytes[i]! & 31];
  return s.match(/.{4}/g)!.join('-');
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

type InviteRow = {
  id: string;
  uses_left: number;
  expires_at: number | null;
  created_at: number;
  note: string;
  revoked: number;
};

const GRANT_COLS = 'room, room_iid, uses_left, expires_at, epoch';

type GrantRow = { room: string; room_iid: string; uses_left: number; expires_at: number; epoch: number };

function grantOf(r: GrantRow): GrantRecord {
  return { room: r.room, instance: r.room_iid, usesLeft: r.uses_left, expiresAt: r.expires_at, epoch: r.epoch };
}

function inviteOf(r: InviteRow): InviteRecord {
  return {
    id: r.id,
    usesLeft: r.uses_left,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    note: r.note,
    revoked: r.revoked !== 0,
  };
}

export class SqliteAccessStore implements AccessStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA);
    migrateGrants(db);
  }

  epoch(): number {
    const row = this.db.prepare("SELECT value FROM access_meta WHERE key = 'epoch'").get() as
      | { value: string }
      | undefined;
    const n = row ? Number(row.value) : 0;
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }

  bumpEpoch(): number {
    return transaction(this.db, () => {
      const next = this.epoch() + 1;
      this.db
        .prepare(
          "INSERT INTO access_meta(key, value) VALUES('epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(next));
      // 旧 epoch 的授权已经不能兑换，顺手删掉
      this.db.prepare('DELETE FROM access_grants WHERE epoch < ?').run(next);
      return next;
    });
  }

  createInvite(o: { uses: number; expiresAt: number | null; note?: string; now: number }): {
    code: string;
    invite: InviteRecord;
  } {
    if (!Number.isInteger(o.uses) || o.uses < 1) throw new Error('uses 必须是正整数');
    const code = newInviteCode();
    const id = randomBytes(4).toString('hex');
    const note = (o.note ?? '').slice(0, 200);
    this.db
      .prepare(
        'INSERT INTO access_invites(id, code_hash, uses_left, expires_at, created_at, note) VALUES(?, ?, ?, ?, ?, ?)',
      )
      .run(id, sha256(normalizeInviteCode(code)!), o.uses, o.expiresAt, o.now, note);
    return { code, invite: { id, usesLeft: o.uses, expiresAt: o.expiresAt, createdAt: o.now, note, revoked: false } };
  }

  redeemInvite(code: string, now: number): { id: string; expiresAt: number | null } | null {
    const norm = normalizeInviteCode(code);
    if (!norm) return null;
    const h = sha256(norm);
    return transaction(this.db, () => {
      const r = this.db
        .prepare(
          `UPDATE access_invites SET uses_left = uses_left - 1
           WHERE code_hash = ? AND revoked = 0 AND uses_left > 0 AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .run(h, now);
      if (Number(r.changes) !== 1) return null;
      const row = this.db.prepare('SELECT id, expires_at FROM access_invites WHERE code_hash = ?').get(h) as {
        id: string;
        expires_at: number | null;
      };
      return { id: row.id, expiresAt: row.expires_at };
    });
  }

  listInvites(): InviteRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, uses_left, expires_at, created_at, note, revoked FROM access_invites ORDER BY created_at, id',
      )
      .all() as InviteRow[];
    return rows.map(inviteOf);
  }

  revokeInvite(id: string): boolean {
    const r = this.db.prepare('UPDATE access_invites SET revoked = 1 WHERE id = ? AND revoked = 0').run(id);
    return Number(r.changes) === 1;
  }

  revokedInviteIds(): string[] {
    const rows = this.db.prepare('SELECT id FROM access_invites WHERE revoked = 1').all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  createGrant(o: {
    room: string;
    instance: string;
    uses: number;
    expiresAt: number;
    epoch: number;
    now: number;
  }): string {
    if (o.instance === '') throw new Error('房间授权必须绑定房间实例');
    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO access_grants(token_hash, room, room_iid, uses_left, expires_at, epoch, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sha256(token), o.room, o.instance, o.uses, o.expiresAt, o.epoch, o.now);
    return token;
  }

  redeemGrant(token: string, now: number, epoch: number): GrantRecord | null {
    return transaction(this.db, () => {
      const h = sha256(token);
      const r = this.db
        .prepare(
          `UPDATE access_grants SET uses_left = uses_left - 1
           WHERE token_hash = ? AND uses_left > 0 AND expires_at > ? AND epoch = ? AND room_iid != ''`,
        )
        .run(h, now, epoch);
      if (Number(r.changes) !== 1) return null;
      const row = this.db.prepare(`SELECT ${GRANT_COLS} FROM access_grants WHERE token_hash = ?`).get(h) as GrantRow;
      return grantOf(row);
    });
  }

  peekGrant(token: string, now: number, epoch: number): GrantRecord | null {
    const row = this.db
      .prepare(
        `SELECT ${GRANT_COLS} FROM access_grants
         WHERE token_hash = ? AND uses_left > 0 AND expires_at > ? AND epoch = ? AND room_iid != ''`,
      )
      .get(sha256(token), now, epoch) as GrantRow | undefined;
    return row ? grantOf(row) : null;
  }

  prune(now: number): number {
    const a = this.db
      .prepare("DELETE FROM access_grants WHERE expires_at <= ? OR uses_left <= 0 OR room_iid = ''")
      .run(now);
    // 邀请码只在过期后删除：用它登录的会话不会晚于邀请码到期（cap），之前都可能还要按撤销状态拦下
    const b = this.db.prepare('DELETE FROM access_invites WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
    return Number(a.changes) + Number(b.changes);
  }
}

/** 门禁数据库路径：STORE=sqlite 与 rich4.db 同库，否则 DATA_DIR/access.db */
export function accessDbPath(o: { store: 'sqlite' | 'json'; storePath: string; dataDir: string }): string {
  return o.store === 'sqlite' ? o.storePath : join(o.dataDir, 'access.db');
}

export class AccessDbMissingError extends Error {
  override name = 'AccessDbMissingError';
}

/**
 * 打开门禁数据库（CLI、JSON 存储时的服务器）；调用方负责 db.close()。
 * 只建 access_* 表，不跑房间与存档的迁移（与 rich4.db 同库时由服务器自己迁移，CREATE IF NOT EXISTS 互不影响）。
 * create=false 时库文件不存在就抛 AccessDbMissingError（CLI 默认：DATA_DIR 打错时不能新建一个空库并假装吊销成功）。
 */
export function openAccessStore(
  path: string,
  o: { create?: boolean } = {},
): { store: SqliteAccessStore; db: DatabaseSync } {
  if (path !== MEMORY_DB && o.create === false && !existsSync(path)) {
    throw new AccessDbMissingError(`门禁数据库不存在：${path}`);
  }
  if (path !== MEMORY_DB) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    if (path !== MEMORY_DB) db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;');
    return { store: new SqliteAccessStore(db), db };
  } catch (err) {
    db.close();
    throw err;
  }
}
