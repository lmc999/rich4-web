/**
 * 持久化存储契约：SQLite（内存与文件）与 JSON 文件实现跑同一套用例；数据库迁移与 HMAC 回退密钥。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GameAction, GameState } from '@rich4/shared/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/infra/logger';
import { DB_SCHEMA_VERSION, DbVersionError, openDatabase, schemaVersionOf } from '../../src/persistence/db';
import { HMAC_META_KEY, openPersistence, type Persistence, resolveHmacSecret } from '../../src/persistence/index';
import type { RoomMetaV1, RoomSnapshotRecord, SaveRecord } from '../../src/persistence/types';

const dirs: string[] = [];
const opened: Persistence[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rich4-persist-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const p of opened.splice(0)) p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Kind = 'sqlite-memory' | 'sqlite-file' | 'json';

function open(kind: Kind, dir = tmp()): Persistence {
  const p =
    kind === 'json'
      ? openPersistence({ kind: 'json', location: join(dir, 'store') })
      : openPersistence({ kind: 'sqlite', location: kind === 'sqlite-memory' ? ':memory:' : join(dir, 'rich4.db') });
  opened.push(p);
  return p;
}

const meta = (): RoomMetaV1 => ({
  v: 1,
  createdAt: 1,
  settings: {} as RoomMetaV1['settings'],
  hostToken: 'h',
  seats: [],
  spectators: [],
  chat: [],
  paused: null,
  loadedSaveId: null,
  sourceSaveId: null,
});

function snap(
  code: string,
  epoch: number,
  seq: number,
  updatedAt: number,
  state: unknown = { s: seq },
): RoomSnapshotRecord {
  return {
    code,
    epoch,
    seq,
    phase: state === null ? 'lobby' : 'playing',
    engineVersion: '0.1.0',
    stateVersion: 1,
    meta: meta(),
    state: state as GameState | null,
    updatedAt,
  };
}

const act = (n: number): GameAction => ({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: n } });

function save(id: string, updatedAt: number, kind: 'manual' | 'auto' = 'manual'): SaveRecord {
  return {
    id,
    name: id,
    kind,
    roomCode: '123456',
    schemaVersion: 1,
    engineVersion: '0.1.0',
    stateVersion: 1,
    mapId: 'test',
    gameDay: 3,
    meta: { mapId: 'test', gameDay: 3, date: 19980104, seats: [], mapHash: 'm', tablesHash: 't' },
    verified: true,
    blob: new Uint8Array([1, 2, 3, updatedAt % 256]),
    sig: 'sig',
    createdAt: updatedAt,
    updatedAt,
  };
}

describe.each<Kind>(['sqlite-memory', 'sqlite-file', 'json'])('存储契约：%s', (kind) => {
  it('journal 追加与读取；写快照删除快照之前与其他 epoch 的 journal', () => {
    const p = open(kind);
    const r = p.rooms;
    for (let i = 1; i <= 5; i++) r.appendJournal('100001', 1, { seq: i, ts: i, actor: 'player', action: act(i) });
    r.appendJournal('100001', 0, { seq: 9, ts: 0, actor: 'ai', action: act(9) });
    expect(r.readJournal('100001', 1, 2).map((x) => x.seq)).toEqual([3, 4, 5]);
    expect(r.readJournal('100001', 1, 0)[0]).toEqual({ seq: 1, ts: 1, actor: 'player', action: act(1) });
    r.writeSnapshot(snap('100001', 1, 3, 1000));
    expect(r.readJournal('100001', 1, 0).map((x) => x.seq)).toEqual([4, 5]);
    expect(r.readJournal('100001', 0, 0)).toEqual([]);
    const [s] = r.listActive(0);
    expect(s).toMatchObject({ code: '100001', epoch: 1, seq: 3, phase: 'playing', state: { s: 3 }, meta: meta() });
  });

  it('listActive 按 updatedAt 过滤；大厅快照 state 为 null；deleteRoom 与 pruneBefore', () => {
    const p = open(kind);
    const r = p.rooms;
    r.writeSnapshot(snap('100001', 1, 0, 1000, null));
    r.writeSnapshot(snap('100002', 2, 7, 5000));
    r.appendJournal('100002', 2, { seq: 8, ts: 1, actor: 'ai', action: act(8) });
    expect(r.listActive(0).map((x) => [x.code, x.state])).toEqual([
      ['100001', null],
      ['100002', { s: 7 }],
    ]);
    expect(r.listActive(2000).map((x) => x.code)).toEqual(['100002']);
    expect(r.pruneBefore(2000)).toBe(1);
    expect(r.listActive(0).map((x) => x.code)).toEqual(['100002']);
    r.deleteRoom('100002');
    expect(r.listActive(0)).toEqual([]);
    expect(r.readJournal('100002', 2, 0)).toEqual([]);
  });

  it('存档：put 覆盖并替换 owners；按 owner 列出（新的在前）；移除最后一个 owner 时删除', () => {
    const p = open(kind);
    const s = p.saves;
    s.put(save('a', 10), ['T1', 'T2']);
    s.put(save('b', 20), ['T1']);
    expect(s.listByOwner('T1').map((x) => x.id)).toEqual(['b', 'a']);
    expect(s.listByOwner('T2').map((x) => x.id)).toEqual(['a']);
    expect(s.get('a')).toMatchObject({ id: 'a', verified: true, sig: 'sig', meta: { mapHash: 'm' } });
    expect([...s.get('a')!.blob]).toEqual([1, 2, 3, 10]);
    expect(s.isOwner('a', 'T2')).toBe(true);
    // auto 存档覆盖写：owners 整体替换
    s.put({ ...save('a', 30), name: 'a2' }, ['T3']);
    expect(s.get('a')!.name).toBe('a2');
    expect(s.isOwner('a', 'T1')).toBe(false);
    s.addOwners('a', ['T1']);
    expect(s.isOwner('a', 'T1')).toBe(true);
    expect(s.removeOwner('a', 'T9')).toBe(false);
    expect(s.removeOwner('a', 'T1')).toBe(true);
    expect(s.get('a')).not.toBeNull();
    expect(s.removeOwner('a', 'T3')).toBe(true);
    expect(s.get('a')).toBeNull();
    expect(s.count()).toBe(1);
  });

  it('trimManual 只移除超出配额的最旧手动存档', () => {
    const p = open(kind);
    const s = p.saves;
    for (let i = 1; i <= 5; i++) s.put(save(`m${i}`, i * 10), ['T1']);
    s.put(save('auto:1', 1, 'auto'), ['T1']);
    expect(s.trimManual('T1', 3)).toEqual(['m2', 'm1']);
    expect(s.listByOwner('T1').map((x) => x.id)).toEqual(['m5', 'm4', 'm3', 'auto:1']);
  });

  it('meta 键值与 HMAC 回退密钥：生成一次后保持不变', () => {
    const p = open(kind);
    expect(p.meta.getMeta('x')).toBeNull();
    p.meta.setMeta('x', '1');
    p.meta.setMeta('x', '2');
    expect(p.meta.getMeta('x')).toBe('2');
    const s1 = resolveHmacSecret(null, p, silentLogger);
    expect(s1.length).toBeGreaterThanOrEqual(32);
    expect(resolveHmacSecret(null, p, silentLogger)).toBe(s1);
    expect(p.meta.getMeta(HMAC_META_KEY)).toBe(s1);
    expect(resolveHmacSecret('configured-secret-configured-secret', p, silentLogger)).toBe(
      'configured-secret-configured-secret',
    );
  });
});

describe('数据库迁移', () => {
  it('新库迁移到 DB_SCHEMA_VERSION，WAL 模式；重新打开保留数据', () => {
    const d = tmp();
    const path = join(d, 'rich4.db');
    const p1 = openPersistence({ kind: 'sqlite', location: path });
    p1.rooms.writeSnapshot(snap('100001', 1, 0, 1, null));
    p1.close();
    const db = openDatabase({ path });
    expect(schemaVersionOf(db)).toBe(DB_SCHEMA_VERSION);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    db.close();
    const p2 = open('sqlite-file', d);
    expect(p2.rooms.listActive(0).map((x) => x.code)).toEqual(['100001']);
    expect(p2.healthy()).toBe(true);
    p2.close();
    expect(p2.healthy()).toBe(false);
  });

  it('库的 schema_version 比服务器新：拒绝打开', () => {
    const d = tmp();
    const path = join(d, 'rich4.db');
    openDatabase({ path }).close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    raw.close();
    expect(() => openDatabase({ path })).toThrow(DbVersionError);
  });
});
