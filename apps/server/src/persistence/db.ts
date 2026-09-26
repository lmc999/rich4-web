/**
 * node:sqlite 数据库（design/net.md §8.1–§8.2）：打开、设置 PRAGMA、按 meta.schema_version 执行迁移建表。
 *
 * 与设计稿的差异：room_journal 增加 epoch 列（主键 (code, epoch, seq)），rematch / 读档 / 重启恢复后 seq 从头计也不会冲突；
 * saves 增加 verified 列（导入时的验签结论，列表页不必解码 blob）。
 * node:sqlite 在 Node 24.9 仍是实验特性：dev/start 脚本带 --disable-warning=ExperimentalWarning。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DB_SCHEMA_VERSION = 1;
export const MEMORY_DB = ':memory:';

/** MIGRATIONS[v]：把 schema_version 从 v-1 升到 v */
const MIGRATIONS: Readonly<Record<number, string>> = {
  1: `
CREATE TABLE IF NOT EXISTS saves(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('manual','auto')),
  room_code TEXT, schema_version INTEGER NOT NULL, engine_version TEXT NOT NULL, state_version INTEGER NOT NULL,
  map_id TEXT NOT NULL, game_day INTEGER NOT NULL, meta_json TEXT NOT NULL,
  blob BLOB NOT NULL, sig TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS save_owners(
  save_id TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE, token_hash TEXT NOT NULL,
  PRIMARY KEY(save_id, token_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_save_owners_token ON save_owners(token_hash);
CREATE TABLE IF NOT EXISTS room_snapshots(
  code TEXT PRIMARY KEY, epoch INTEGER NOT NULL, seq INTEGER NOT NULL, phase TEXT NOT NULL,
  engine_version TEXT NOT NULL, state_version INTEGER NOT NULL,
  meta_json TEXT NOT NULL, state_blob BLOB, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS room_journal(
  code TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
  actor TEXT NOT NULL, action_json TEXT NOT NULL,
  PRIMARY KEY(code, epoch, seq)
) STRICT, WITHOUT ROWID;
`,
};

export class DbVersionError extends Error {
  override name = 'DbVersionError';
}

export interface OpenDbOptions {
  /** 文件路径或 ':memory:' */
  path: string;
}

/** 打开数据库并迁移到 DB_SCHEMA_VERSION；文件库使用 WAL */
export function openDatabase(o: OpenDbOptions): DatabaseSync {
  if (o.path !== MEMORY_DB) mkdirSync(dirname(o.path), { recursive: true });
  const db = new DatabaseSync(o.path);
  try {
    if (o.path !== MEMORY_DB) db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
    db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function schemaVersionOf(db: DatabaseSync): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

function migrate(db: DatabaseSync): void {
  let v = schemaVersionOf(db);
  if (!Number.isInteger(v) || v < 0) throw new DbVersionError(`bad schema_version ${String(v)}`);
  if (v > DB_SCHEMA_VERSION) {
    throw new DbVersionError(`database schema_version ${v} is newer than this server (${DB_SCHEMA_VERSION})`);
  }
  while (v < DB_SCHEMA_VERSION) {
    const next = v + 1;
    const sql = MIGRATIONS[next];
    if (sql === undefined) throw new DbVersionError(`no migration to schema_version ${next}`);
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        'schema_version',
        String(next),
      );
    });
    v = next;
  }
}

/** 在事务里执行 fn（同步）；抛异常时回滚 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已被 SQLite 自动回滚
    }
    throw err;
  }
}

/** 数据库是否可用（/readyz） */
export function pingDatabase(db: DatabaseSync): boolean {
  try {
    db.prepare('SELECT 1 AS ok').get();
    return true;
  } catch {
    return false;
  }
}

/** meta 表的键值读写（schema_version 之外的键：HMAC 回退密钥等） */
export class SqliteMetaStore {
  constructor(private readonly db: DatabaseSync) {}

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}
