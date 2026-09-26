/**
 * 存档仓库的 SQLite 实现（design/net.md §8.2–§8.3）。接口见 ./types（SaveRepository）。
 *
 * - saves 存 gzip(JSON(SaveFile)) 与签名；meta_json 存列表页用的摘要，列存档不必解码 blob。
 * - save_owners：房间里所有真人参与者都是 owner，任何一位都能读档；某人删除只是移除自己的归属，
 *   没有 owner 的存档随之删除。
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { transaction } from './db';
import type { SaveKind, SaveListMeta, SaveRecord, SaveRepository, SaveRow } from './types';

export type { SaveRepository } from './types';

interface SaveDbRow {
  id: string;
  name: string;
  kind: string;
  room_code: string | null;
  schema_version: number;
  engine_version: string;
  state_version: number;
  map_id: string;
  game_day: number;
  meta_json: string;
  verified: number;
  created_at: number;
  updated_at: number;
  blob?: Uint8Array;
  sig?: string;
}

const ROW_COLS =
  's.id, s.name, s.kind, s.room_code, s.schema_version, s.engine_version, s.state_version, s.map_id, s.game_day, ' +
  's.meta_json, s.verified, s.created_at, s.updated_at';

function toRow(r: SaveDbRow): SaveRow {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as SaveKind,
    roomCode: r.room_code,
    schemaVersion: r.schema_version,
    engineVersion: r.engine_version,
    stateVersion: r.state_version,
    mapId: r.map_id,
    gameDay: r.game_day,
    meta: JSON.parse(r.meta_json) as SaveListMeta,
    verified: r.verified !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class SqliteSaveRepository implements SaveRepository {
  private readonly upsert: StatementSync;
  private readonly delOwners: StatementSync;
  private readonly insOwner: StatementSync;
  private readonly selOne: StatementSync;
  private readonly selByOwner: StatementSync;
  private readonly selIsOwner: StatementSync;
  private readonly delOwner: StatementSync;
  private readonly delOrphan: StatementSync;
  private readonly selManual: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.upsert = db.prepare(
      `INSERT INTO saves(id, name, kind, room_code, schema_version, engine_version, state_version, map_id, game_day,
         meta_json, blob, sig, verified, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, room_code = excluded.room_code,
         schema_version = excluded.schema_version, engine_version = excluded.engine_version,
         state_version = excluded.state_version, map_id = excluded.map_id, game_day = excluded.game_day,
         meta_json = excluded.meta_json, blob = excluded.blob, sig = excluded.sig, verified = excluded.verified,
         updated_at = excluded.updated_at`,
    );
    this.delOwners = db.prepare('DELETE FROM save_owners WHERE save_id = ?');
    this.insOwner = db.prepare('INSERT OR IGNORE INTO save_owners(save_id, token_hash) VALUES(?, ?)');
    this.selOne = db.prepare(`SELECT ${ROW_COLS}, s.blob, s.sig FROM saves s WHERE s.id = ?`);
    this.selByOwner = db.prepare(
      `SELECT ${ROW_COLS} FROM saves s JOIN save_owners o ON o.save_id = s.id WHERE o.token_hash = ?
       ORDER BY s.updated_at DESC, s.id`,
    );
    this.selIsOwner = db.prepare('SELECT 1 AS ok FROM save_owners WHERE save_id = ? AND token_hash = ?');
    this.delOwner = db.prepare('DELETE FROM save_owners WHERE save_id = ? AND token_hash = ?');
    this.delOrphan = db.prepare(
      'DELETE FROM saves WHERE id = ? AND NOT EXISTS (SELECT 1 FROM save_owners WHERE save_id = ?)',
    );
    this.selManual = db.prepare(
      `SELECT s.id FROM saves s JOIN save_owners o ON o.save_id = s.id
       WHERE o.token_hash = ? AND s.kind = 'manual' ORDER BY s.updated_at DESC, s.id`,
    );
  }

  put(rec: SaveRecord, owners: readonly string[]): void {
    transaction(this.db, () => {
      this.upsert.run(
        rec.id,
        rec.name,
        rec.kind,
        rec.roomCode,
        rec.schemaVersion,
        rec.engineVersion,
        rec.stateVersion,
        rec.mapId,
        rec.gameDay,
        JSON.stringify(rec.meta),
        rec.blob,
        rec.sig,
        rec.verified ? 1 : 0,
        rec.createdAt,
        rec.updatedAt,
      );
      this.delOwners.run(rec.id);
      for (const o of new Set(owners)) this.insOwner.run(rec.id, o);
    });
  }

  get(id: string): SaveRecord | null {
    const r = this.selOne.get(id) as SaveDbRow | undefined;
    if (!r) return null;
    return { ...toRow(r), blob: new Uint8Array(r.blob!), sig: r.sig ?? '' };
  }

  listByOwner(tokenHash: string): SaveRow[] {
    return (this.selByOwner.all(tokenHash) as unknown as SaveDbRow[]).map(toRow);
  }

  isOwner(id: string, tokenHash: string): boolean {
    return this.selIsOwner.get(id, tokenHash) !== undefined;
  }

  addOwners(id: string, owners: readonly string[]): void {
    transaction(this.db, () => {
      for (const o of new Set(owners)) this.insOwner.run(id, o);
    });
  }

  removeOwner(id: string, tokenHash: string): boolean {
    return transaction(this.db, () => {
      const n = Number(this.delOwner.run(id, tokenHash).changes);
      this.delOrphan.run(id, id);
      return n > 0;
    });
  }

  trimManual(tokenHash: string, keep: number): string[] {
    const ids = (this.selManual.all(tokenHash) as { id: string }[]).map((r) => r.id);
    const drop = ids.slice(Math.max(0, keep));
    for (const id of drop) this.removeOwner(id, tokenHash);
    return drop;
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM saves').get() as { n: number }).n);
  }
}
