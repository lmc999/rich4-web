/**
 * 房间快照与 journal 的 SQLite 实现（design/net.md §8.2、§8.5）。接口见 ./types（RoomStore）。
 *
 * - journal：每应用一个 action 同步 INSERT 一条（WAL 下约 0.1ms）。
 * - 快照：state 以 gzip(JSON) 存 state_blob（大厅为 NULL），meta 为 RoomMetaV1 的 JSON；
 *   写快照与删除旧 journal 在同一事务里完成。
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { GameAction, GameState } from '@rich4/shared/engine';
import type { RoomPhase } from '@rich4/shared/net';
import { gunzipJson, gzipJson } from './codec';
import { transaction } from './db';
import type { JournalRow, RoomMetaV1, RoomSnapshotRecord, RoomStore } from './types';

export type { RoomStore } from './types';

interface SnapshotRow {
  code: string;
  epoch: number;
  seq: number;
  phase: string;
  engine_version: string;
  state_version: number;
  meta_json: string;
  state_blob: Uint8Array | null;
  updated_at: number;
}

interface JournalDbRow {
  seq: number;
  ts: number;
  actor: string;
  action_json: string;
}

export function decodeSnapshotRow(r: SnapshotRow): RoomSnapshotRecord {
  return {
    code: r.code,
    epoch: r.epoch,
    seq: r.seq,
    phase: r.phase as RoomPhase,
    engineVersion: r.engine_version,
    stateVersion: r.state_version,
    meta: JSON.parse(r.meta_json) as RoomMetaV1,
    state: r.state_blob === null ? null : (gunzipJson(r.state_blob) as GameState),
    updatedAt: r.updated_at,
  };
}

export class SqliteRoomStore implements RoomStore {
  private readonly insJournal: StatementSync;
  private readonly upSnap: StatementSync;
  private readonly delJournalOld: StatementSync;
  private readonly selJournal: StatementSync;
  private readonly selActive: StatementSync;
  private readonly delSnap: StatementSync;
  private readonly delJournalAll: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.insJournal = db.prepare(
      'INSERT OR REPLACE INTO room_journal(code, epoch, seq, ts, actor, action_json) VALUES(?, ?, ?, ?, ?, ?)',
    );
    this.upSnap = db.prepare(
      `INSERT INTO room_snapshots(code, epoch, seq, phase, engine_version, state_version, meta_json, state_blob, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET epoch = excluded.epoch, seq = excluded.seq, phase = excluded.phase,
         engine_version = excluded.engine_version, state_version = excluded.state_version,
         meta_json = excluded.meta_json, state_blob = excluded.state_blob, updated_at = excluded.updated_at`,
    );
    this.delJournalOld = db.prepare('DELETE FROM room_journal WHERE code = ? AND (epoch <> ? OR seq <= ?)');
    this.selJournal = db.prepare(
      'SELECT seq, ts, actor, action_json FROM room_journal WHERE code = ? AND epoch = ? AND seq > ? ORDER BY seq',
    );
    this.selActive = db.prepare('SELECT * FROM room_snapshots WHERE updated_at >= ? ORDER BY code');
    this.delSnap = db.prepare('DELETE FROM room_snapshots WHERE code = ?');
    this.delJournalAll = db.prepare('DELETE FROM room_journal WHERE code = ?');
  }

  appendJournal(code: string, epoch: number, row: JournalRow): void {
    this.insJournal.run(code, epoch, row.seq, row.ts, row.actor, JSON.stringify(row.action));
  }

  writeSnapshot(rec: RoomSnapshotRecord): void {
    const blob = rec.state === null ? null : gzipJson(rec.state);
    const meta = JSON.stringify(rec.meta);
    transaction(this.db, () => {
      this.upSnap.run(
        rec.code,
        rec.epoch,
        rec.seq,
        rec.phase,
        rec.engineVersion,
        rec.stateVersion,
        meta,
        blob,
        rec.updatedAt,
      );
      this.delJournalOld.run(rec.code, rec.epoch, rec.seq);
    });
  }

  readJournal(code: string, epoch: number, afterSeq: number): JournalRow[] {
    return (this.selJournal.all(code, epoch, afterSeq) as unknown as JournalDbRow[]).map((r) => ({
      seq: r.seq,
      ts: r.ts,
      actor: r.actor,
      action: JSON.parse(r.action_json) as GameAction,
    }));
  }

  listActive(sinceMs: number, onError?: (code: string, err: unknown) => void): RoomSnapshotRecord[] {
    const out: RoomSnapshotRecord[] = [];
    for (const r of this.selActive.all(sinceMs) as unknown as SnapshotRow[]) {
      try {
        out.push(decodeSnapshotRow(r));
      } catch (err) {
        onError?.(r.code, err);
      }
    }
    return out;
  }

  deleteRoom(code: string): void {
    transaction(this.db, () => {
      this.delSnap.run(code);
      this.delJournalAll.run(code);
    });
  }

  pruneBefore(beforeMs: number): number {
    return transaction(this.db, () => {
      const codes = this.db.prepare('SELECT code FROM room_snapshots WHERE updated_at < ?').all(beforeMs) as {
        code: string;
      }[];
      for (const { code } of codes) {
        this.delSnap.run(code);
        this.delJournalAll.run(code);
      }
      // 没有快照的孤儿 journal 一并清掉
      this.db.prepare('DELETE FROM room_journal WHERE code NOT IN (SELECT code FROM room_snapshots)').run();
      return codes.length;
    });
  }
}
