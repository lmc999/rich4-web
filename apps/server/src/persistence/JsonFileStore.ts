/**
 * JSON 文件实现（design/net.md §8.1：备用 / 单测 / 极简部署）。同时实现 RoomStore、SaveRepository 与 MetaStore。
 *
 * 目录结构：
 *   <dir>/meta.json                          键值元数据
 *   <dir>/rooms/<code>.json                  房间快照（state 为 gzip 后的 base64url）
 *   <dir>/rooms/<code>.journal.jsonl         journal（每行一个 {epoch, seq, ts, actor, action}，追加写）
 *   <dir>/saves/<encodeURIComponent(id)>.json 存档（blob 为 base64url，owners 数组）
 * 整文件写入先写临时文件再 rename；并发写与大数据量性能都不如 SQLite，只作备用。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { GameState } from '@rich4/shared/engine';
import { b64url, fromB64url, gunzipJson, gzipJson } from './codec';
import type {
  JournalRow,
  MetaStore,
  RoomSnapshotRecord,
  RoomStore,
  SaveRecord,
  SaveRepository,
  SaveRow,
} from './types';

interface SnapshotFile extends Omit<RoomSnapshotRecord, 'state'> {
  state: string | null;
}

interface JournalLine extends JournalRow {
  epoch: number;
}

interface SaveFileJson extends SaveRow {
  blob: string;
  sig: string;
  owners: string[];
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

export class JsonFileStore implements RoomStore, SaveRepository, MetaStore {
  private readonly roomsDir: string;
  private readonly savesDir: string;
  private readonly metaPath: string;

  constructor(readonly dir: string) {
    this.roomsDir = join(dir, 'rooms');
    this.savesDir = join(dir, 'saves');
    this.metaPath = join(dir, 'meta.json');
    mkdirSync(this.roomsDir, { recursive: true });
    mkdirSync(this.savesDir, { recursive: true });
  }

  // ───────────────────────── meta ─────────────────────────

  getMeta(key: string): string | null {
    return readJson<Record<string, string>>(this.metaPath)?.[key] ?? null;
  }

  setMeta(key: string, value: string): void {
    const m = readJson<Record<string, string>>(this.metaPath) ?? {};
    m[key] = value;
    writeAtomic(this.metaPath, JSON.stringify(m));
  }

  // ───────────────────────── RoomStore ─────────────────────────

  private snapPath(code: string): string {
    return join(this.roomsDir, `${code}.json`);
  }

  private journalPath(code: string): string {
    return join(this.roomsDir, `${code}.journal.jsonl`);
  }

  private readLines(code: string): JournalLine[] {
    let text: string;
    try {
      text = readFileSync(this.journalPath(code), 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
    const out: JournalLine[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as JournalLine);
      } catch {
        // 崩溃时写了一半的最后一行：丢弃
      }
    }
    return out;
  }

  appendJournal(code: string, epoch: number, row: JournalRow): void {
    const line: JournalLine = { epoch, ...row };
    appendFileSync(this.journalPath(code), `${JSON.stringify(line)}\n`);
  }

  writeSnapshot(rec: RoomSnapshotRecord): void {
    const file: SnapshotFile = { ...rec, state: rec.state === null ? null : b64url(gzipJson(rec.state)) };
    writeAtomic(this.snapPath(rec.code), JSON.stringify(file));
    const keep = this.readLines(rec.code).filter((l) => l.epoch === rec.epoch && l.seq > rec.seq);
    writeAtomic(this.journalPath(rec.code), keep.map((l) => `${JSON.stringify(l)}\n`).join(''));
  }

  readJournal(code: string, epoch: number, afterSeq: number): JournalRow[] {
    const bySeq = new Map<number, JournalRow>();
    for (const l of this.readLines(code)) {
      if (l.epoch === epoch && l.seq > afterSeq)
        bySeq.set(l.seq, { seq: l.seq, ts: l.ts, actor: l.actor, action: l.action });
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  listActive(sinceMs: number, onError?: (code: string, err: unknown) => void): RoomSnapshotRecord[] {
    const out: RoomSnapshotRecord[] = [];
    for (const f of readdirSync(this.roomsDir).sort()) {
      if (!f.endsWith('.json')) continue;
      const code = f.slice(0, -'.json'.length);
      try {
        const s = readJson<SnapshotFile>(join(this.roomsDir, f));
        if (!s || s.updatedAt < sinceMs) continue;
        out.push({ ...s, state: s.state === null ? null : (gunzipJson(fromB64url(s.state)) as GameState) });
      } catch (err) {
        onError?.(code, err);
      }
    }
    return out;
  }

  deleteRoom(code: string): void {
    rmSync(this.snapPath(code), { force: true });
    rmSync(this.journalPath(code), { force: true });
  }

  pruneBefore(beforeMs: number): number {
    let n = 0;
    for (const f of readdirSync(this.roomsDir)) {
      if (!f.endsWith('.json')) continue;
      const s = readJson<SnapshotFile>(join(this.roomsDir, f));
      if (s && s.updatedAt < beforeMs) {
        this.deleteRoom(s.code);
        n++;
      }
    }
    return n;
  }

  // ───────────────────────── SaveRepository ─────────────────────────

  private savePath(id: string): string {
    return join(this.savesDir, `${encodeURIComponent(id)}.json`);
  }

  private readSave(id: string): SaveFileJson | null {
    return readJson<SaveFileJson>(this.savePath(id));
  }

  private allSaves(): SaveFileJson[] {
    const out: SaveFileJson[] = [];
    for (const f of readdirSync(this.savesDir)) {
      if (!f.endsWith('.json')) continue;
      const s = readJson<SaveFileJson>(join(this.savesDir, f));
      if (s) out.push(s);
    }
    return out;
  }

  private static row(s: SaveFileJson): SaveRow {
    const { blob: _b, sig: _s, owners: _o, ...row } = s;
    return row;
  }

  put(rec: SaveRecord, owners: readonly string[]): void {
    const prev = this.readSave(rec.id);
    const file: SaveFileJson = {
      ...rec,
      createdAt: prev?.createdAt ?? rec.createdAt,
      blob: b64url(rec.blob),
      owners: [...new Set(owners)],
    };
    writeAtomic(this.savePath(rec.id), JSON.stringify(file));
  }

  get(id: string): SaveRecord | null {
    const s = this.readSave(id);
    if (!s) return null;
    return { ...JsonFileStore.row(s), blob: fromB64url(s.blob), sig: s.sig };
  }

  listByOwner(tokenHash: string): SaveRow[] {
    return this.allSaves()
      .filter((s) => s.owners.includes(tokenHash))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
      .map((s) => JsonFileStore.row(s));
  }

  isOwner(id: string, tokenHash: string): boolean {
    return this.readSave(id)?.owners.includes(tokenHash) ?? false;
  }

  addOwners(id: string, owners: readonly string[]): void {
    const s = this.readSave(id);
    if (!s) return;
    s.owners = [...new Set([...s.owners, ...owners])];
    writeAtomic(this.savePath(id), JSON.stringify(s));
  }

  removeOwner(id: string, tokenHash: string): boolean {
    const s = this.readSave(id);
    if (!s?.owners.includes(tokenHash)) return false;
    s.owners = s.owners.filter((o) => o !== tokenHash);
    if (s.owners.length === 0) rmSync(this.savePath(id), { force: true });
    else writeAtomic(this.savePath(id), JSON.stringify(s));
    return true;
  }

  trimManual(tokenHash: string, keep: number): string[] {
    const ids = this.listByOwner(tokenHash)
      .filter((r) => r.kind === 'manual')
      .map((r) => r.id);
    const drop = ids.slice(Math.max(0, keep));
    for (const id of drop) this.removeOwner(id, tokenHash);
    return drop;
  }

  count(): number {
    return existsSync(this.savesDir) ? readdirSync(this.savesDir).filter((f) => f.endsWith('.json')).length : 0;
  }
}
