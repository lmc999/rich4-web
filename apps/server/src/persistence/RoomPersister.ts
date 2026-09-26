/**
 * 房间持久化策略（design/net.md §8.5）：
 * - 每应用一个 action 同步追加一条 journal；
 * - 每 SNAPSHOT_EVERY_SEQ 个 seq、phase 变化、暂停、停机时立即写快照（同时删掉快照之前的 journal）；
 * - 其余房间变化（大厅的座位与设置、聊天、对局中的进出与托管）2 秒防抖后写快照；
 * - 房间关闭时删除快照与 journal；停机时先刷快照再释放（不删除，重启后恢复）。
 * 存储出错只记日志，不影响对局（下一次快照会补上）。
 */
import { SNAPSHOT_EVERY_SEQ } from '@rich4/shared/net';
import type { JournalEntry } from '../game/GameRunner';
import type { Scheduler, TimerHandle } from '../infra/clock';
import type { Logger } from '../infra/logger';
import type { RoomSnapshotRecord, RoomStore } from './types';

export const SNAPSHOT_DEBOUNCE_MS = 2000;

/** 被持久化的房间（Room 实现） */
export interface PersistableRoom {
  readonly code: string;
  readonly epoch: number;
  readonly phase: string;
  /** 当前快照内容 */
  snapshotRecord(): RoomSnapshotRecord;
}

/** Room 看到的持久化接口（单测可以注入空实现） */
export interface RoomPersistence {
  action(room: PersistableRoom, entry: JournalEntry): void;
  snapshot(room: PersistableRoom): void;
  touch(room: PersistableRoom): void;
  closed(room: PersistableRoom): void;
}

export const NO_PERSISTENCE: RoomPersistence = Object.freeze({
  action() {},
  snapshot() {},
  touch() {},
  closed() {},
});

export interface RoomPersisterOptions {
  store: RoomStore;
  scheduler: Scheduler;
  log: Logger;
  debounceMs?: number;
  snapshotEvery?: number;
}

export class RoomPersister implements RoomPersistence {
  private readonly timers = new Map<string, TimerHandle>();
  private readonly debounceMs: number;
  private readonly every: number;
  private disposed = false;
  /** 统计（/admin/stats） */
  readonly stats = { journal: 0, snapshots: 0, errors: 0 };

  constructor(private readonly o: RoomPersisterOptions) {
    this.debounceMs = o.debounceMs ?? SNAPSHOT_DEBOUNCE_MS;
    this.every = o.snapshotEvery ?? SNAPSHOT_EVERY_SEQ;
  }

  private guard(what: string, code: string, fn: () => void): void {
    if (this.disposed) return;
    try {
      fn();
    } catch (err) {
      this.stats.errors++;
      this.o.log.error({ err, code, what }, 'room persistence failed');
    }
  }

  action(room: PersistableRoom, entry: JournalEntry): void {
    this.guard('journal', room.code, () => {
      this.o.store.appendJournal(room.code, room.epoch, {
        seq: entry.seq,
        ts: entry.at,
        actor: entry.by,
        action: entry.action,
      });
      this.stats.journal++;
    });
    if (entry.seq % this.every === 0) this.snapshot(room);
  }

  snapshot(room: PersistableRoom): void {
    this.cancel(room.code);
    if (room.phase === 'closed') return;
    this.guard('snapshot', room.code, () => {
      this.o.store.writeSnapshot(room.snapshotRecord());
      this.stats.snapshots++;
    });
  }

  touch(room: PersistableRoom): void {
    if (this.disposed || this.timers.has(room.code)) return;
    this.timers.set(
      room.code,
      this.o.scheduler.after(this.debounceMs, () => {
        this.timers.delete(room.code);
        if (room.phase !== 'closed') this.snapshot(room);
      }),
    );
  }

  closed(room: PersistableRoom): void {
    this.cancel(room.code);
    this.guard('delete', room.code, () => this.o.store.deleteRoom(room.code));
  }

  private cancel(code: string): void {
    this.timers.get(code)?.cancel();
    this.timers.delete(code);
  }

  /** 停止全部防抖定时器，之后的调用都忽略（停机时在刷完快照之后调用） */
  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) t.cancel();
    this.timers.clear();
  }
}
