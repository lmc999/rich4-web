import type { GameAction } from '@rich4/shared/engine';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/infra/logger';
import { openPersistence } from '../../src/persistence/index';
import { type PersistableRoom, RoomPersister, SNAPSHOT_DEBOUNCE_MS } from '../../src/persistence/RoomPersister';
import type { RoomSnapshotRecord, RoomStore } from '../../src/persistence/types';
import { ManualScheduler } from '../helpers/manualScheduler';

const act = (n: number): GameAction => ({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: n } });

function fakeRoom(code = '100001') {
  const room = {
    code,
    epoch: 1,
    phase: 'playing' as string,
    seq: 0,
    snapshots: 0,
    snapshotRecord(): RoomSnapshotRecord {
      room.snapshots++;
      return {
        code,
        epoch: room.epoch,
        seq: room.seq,
        phase: 'playing',
        engineVersion: '0.1.0',
        stateVersion: 1,
        meta: {
          v: 1,
          createdAt: 0,
          settings: {} as RoomSnapshotRecord['meta']['settings'],
          hostToken: null,
          seats: [],
          spectators: [],
          chat: [],
          paused: null,
          loadedSaveId: null,
          sourceSaveId: null,
        },
        state: { seq: room.seq } as unknown as RoomSnapshotRecord['state'],
        updatedAt: 0,
      };
    },
  };
  return room satisfies PersistableRoom;
}

describe('RoomPersister', () => {
  it('每个 action 追加 journal，每 25 seq 写快照并清掉旧 journal', () => {
    const p = openPersistence({ kind: 'sqlite', location: ':memory:' });
    const sched = new ManualScheduler();
    const rp = new RoomPersister({ store: p.rooms, scheduler: sched, log: silentLogger });
    const room = fakeRoom();
    for (let i = 1; i <= 27; i++) {
      room.seq = i;
      rp.action(room, { seq: i, at: i, by: 'player', action: act(i) });
    }
    expect(room.snapshots).toBe(1);
    expect(p.rooms.readJournal(room.code, 1, 0).map((r) => r.seq)).toEqual([26, 27]);
    expect(p.rooms.listActive(0)[0]).toMatchObject({ seq: 25, state: { seq: 25 } });
    expect(rp.stats).toEqual({ journal: 27, snapshots: 1, errors: 0 });
    p.close();
  });

  it('touch 防抖 2 秒；立即快照取消防抖；closed 删除；dispose 之后忽略', () => {
    const p = openPersistence({ kind: 'sqlite', location: ':memory:' });
    const sched = new ManualScheduler();
    const rp = new RoomPersister({ store: p.rooms, scheduler: sched, log: silentLogger });
    const room = fakeRoom();
    rp.touch(room);
    rp.touch(room);
    sched.advance(SNAPSHOT_DEBOUNCE_MS - 1);
    expect(room.snapshots).toBe(0);
    sched.advance(1);
    expect(room.snapshots).toBe(1);
    rp.touch(room);
    rp.snapshot(room);
    sched.advance(SNAPSHOT_DEBOUNCE_MS);
    expect(room.snapshots).toBe(2);
    room.phase = 'closed';
    rp.touch(room);
    sched.advance(SNAPSHOT_DEBOUNCE_MS);
    expect(room.snapshots).toBe(2);
    rp.closed(room);
    expect(p.rooms.listActive(0)).toEqual([]);
    room.phase = 'playing';
    rp.dispose();
    rp.snapshot(room);
    rp.touch(room);
    sched.advance(SNAPSHOT_DEBOUNCE_MS);
    expect(room.snapshots).toBe(2);
    p.close();
  });

  it('存储出错只记数，不抛给对局', () => {
    const broken: RoomStore = {
      appendJournal: () => {
        throw new Error('disk full');
      },
      writeSnapshot: () => {
        throw new Error('disk full');
      },
      readJournal: () => [],
      listActive: () => [],
      deleteRoom: () => {
        throw new Error('disk full');
      },
      pruneBefore: () => 0,
    };
    const rp = new RoomPersister({ store: broken, scheduler: new ManualScheduler(), log: silentLogger });
    const room = fakeRoom();
    expect(() => rp.action(room, { seq: 25, at: 0, by: 'ai', action: act(1) })).not.toThrow();
    expect(() => rp.closed(room)).not.toThrow();
    expect(rp.stats.errors).toBe(3);
  });
});
