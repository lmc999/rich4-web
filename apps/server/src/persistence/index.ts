/**
 * 持久化入口：按配置打开 SQLite（默认）或 JSON 文件存储，得到 RoomStore + SaveRepository + MetaStore。
 * 上层（RoomPersister、SaveService、恢复流程）只依赖接口，换实现不影响上层（design/net.md §8.1）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../infra/logger';
import { randomSecret } from './codec';
import { MEMORY_DB, openDatabase, pingDatabase, SqliteMetaStore } from './db';
import { JsonFileStore } from './JsonFileStore';
import { SqliteRoomStore } from './RoomStore';
import { SqliteSaveRepository } from './SaveRepository';
import type { MetaStore, RoomStore, SaveRepository } from './types';

export type StoreKind = 'sqlite' | 'json';

export interface Persistence {
  readonly kind: StoreKind;
  /** 数据库文件路径、':memory:' 或 JSON 目录 */
  readonly location: string;
  readonly rooms: RoomStore;
  readonly saves: SaveRepository;
  readonly meta: MetaStore;
  /** SQLite 句柄（备份用）；JSON 存储为 null */
  readonly db: DatabaseSync | null;
  healthy(): boolean;
  close(): void;
}

export interface OpenPersistenceOptions {
  kind: StoreKind;
  /** sqlite：文件路径或 ':memory:'；json：目录 */
  location: string;
}

export function openPersistence(o: OpenPersistenceOptions): Persistence {
  if (o.kind === 'json') {
    const store = new JsonFileStore(o.location);
    return {
      kind: 'json',
      location: o.location,
      rooms: store,
      saves: store,
      meta: store,
      db: null,
      healthy: () => true,
      close: () => {},
    };
  }
  const db = openDatabase({ path: o.location });
  let closed = false;
  return {
    kind: 'sqlite',
    location: o.location,
    rooms: new SqliteRoomStore(db),
    saves: new SqliteSaveRepository(db),
    meta: new SqliteMetaStore(db),
    db,
    healthy: () => !closed && pingDatabase(db),
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

export const HMAC_META_KEY = 'save_hmac_secret';

/**
 * 存档签名密钥：优先 SAVE_HMAC_SECRET；未配置（仅开发，生产由 config 强制）时使用存储 meta 里的随机密钥，
 * 没有就生成一个并保存，这样开发机重启后旧存档仍是「官方」存档。内存库每次进程都不同。
 */
export function resolveHmacSecret(configured: string | null, p: Persistence, log: Logger): string {
  if (configured) return configured;
  let s = p.meta.getMeta(HMAC_META_KEY);
  if (!s) {
    s = randomSecret();
    p.meta.setMeta(HMAC_META_KEY, s);
  }
  if (p.location !== MEMORY_DB) log.warn('SAVE_HMAC_SECRET 未设置：使用存储里的随机密钥（仅限开发）');
  return s;
}

export { MEMORY_DB } from './db';
export type * from './types';
