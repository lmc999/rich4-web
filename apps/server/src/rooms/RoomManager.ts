/**
 * 房间管理（design/net.md §3.1、§8.5）：创建、查找、回收、容量控制、公开房间列表；
 * 启动时从快照 + journal 恢复房间，停机时挂起全部房间（刷快照、自动存档）。
 */
import { defaultGameConfig, type GameState } from '@rich4/shared/engine';
import {
  defaultRoomSettings,
  fail,
  ok,
  type PublicRoomSummary,
  type Result,
  type RoomClosedReason,
  type RoomSettings,
  type RoomSettingsPatch,
} from '@rich4/shared/net';
import { dateNumOf } from '../infra/clock';
import { autoSaveId, buildSaveFile, type LoadedSave, saveSeatsOf } from '../persistence/SaveService';
import type { RoomSnapshotRecord, RoomStore, ServerSaveFile } from '../persistence/types';
import { applySettingsPatch, type Identity, Room, type RoomDeps, sourceVerifiedOf } from './Room';
import type { RoomCodeAllocator } from './roomCode';

export interface RoomManagerDeps extends Omit<RoomDeps, 'onMemberRemoved' | 'onClosed'> {
  codes: RoomCodeAllocator;
  maxRooms: number;
  /** 服务端对新房间默认设置的覆盖（测试用：缩短断线宽限等） */
  settingsOverrides?: Partial<Omit<RoomSettings, 'game'>>;
  /** 成员离开房间（会话层据此清掉 roomCode） */
  onMemberRemoved(tokenHash: string, code: string): void;
  /** 堆内存等过载判断；返回 true 时拒绝建房 */
  busy?(): boolean;
}

/** 一个房间的恢复结果（启动日志与测试用） */
export interface RestoreReport {
  code: string;
  /** 快照里的 phase */
  phase: string;
  /**
   * lobby：大厅；journal：快照 + journal 尾部重放；migrated：引擎主版本或 state 版本不同，只迁移快照；
   * converted：迁移失败、状态无效或地图缺失，转为存档 auto:<code>；skipped：引擎不可用，快照原样保留待下次启动；
   * failed：无法恢复（已删除）
   */
  mode: 'lobby' | 'journal' | 'migrated' | 'converted' | 'skipped' | 'failed';
  replayed: number;
  epoch: number;
  seq: number;
  error?: string;
}

export interface RestoreOptions {
  store: RoomStore;
  /** 只恢复这么久之内更新过的房间（更早的删除） */
  maxAgeMs: number;
  /** 大厅里已读取的存档按 id 重新读取；迁移失败时转存档 */
  openSave?(saveId: string): Result<LoadedSave>;
  /** verified=false：对局来自未验证的存档，转成的存档同样不签名 */
  storeSave?(
    file: ServerSaveFile,
    roomCode: string,
    owners: readonly string[],
    verified: boolean,
  ): Result<{ saveId: string }>;
}

/**
 * 规则版本（major.minor）：engine/version.ts 约定「规则或数据变化时升次版本号」，journal 里的 action 是按旧规则产生的，
 * 用新规则重放可能得到与玩家所见不同的状态（或中途抛错、静默丢掉之后的 action），所以次版本不同就不重放 journal。
 */
export function rulesVersion(v: string): string {
  const [a = v, b = ''] = v.split('.');
  return `${a}.${b}`;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /** 停机中：拒绝建房与入房 */
  draining = false;

  constructor(private readonly deps: RoomManagerDeps) {}

  get size(): number {
    return this.rooms.size;
  }

  get(code: string): Room | undefined {
    const r = this.rooms.get(code);
    return r && r.phase !== 'closed' ? r : undefined;
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  defaultSettings(): RoomSettings {
    const game = defaultGameConfig(this.deps.maps.defaultMap, dateNumOf(this.deps.clock.now()));
    return { ...defaultRoomSettings(game), ...this.deps.settingsOverrides };
  }

  /** 只读的建房检查（容量、过载、停机、设置补丁）：handler 通过后才离开原大厅房间 */
  prepareCreate(patch: RoomSettingsPatch | undefined): Result<RoomSettings> {
    if (this.draining || this.rooms.size >= this.deps.maxRooms || this.deps.busy?.()) return fail('SERVER_BUSY');
    const settings = this.defaultSettings();
    return patch ? applySettingsPatch(settings, patch, this.deps.maps) : ok(settings);
  }

  private roomDeps(code: string): RoomDeps {
    return {
      ...this.deps,
      onMemberRemoved: (tokenHash) => this.deps.onMemberRemoved(tokenHash, code),
      onClosed: (r, reason) => this.onClosed(r, reason),
    };
  }

  create(host: Identity, patch: RoomSettingsPatch | undefined): Result<{ room: Room }> {
    const prep = this.prepareCreate(patch);
    if (!prep.ok) return prep;
    const settings = prep.data;
    const code = this.deps.codes.allocate((c) => this.rooms.has(c));
    if (code === null) return fail('SERVER_BUSY');
    const room = new Room(code, this.roomDeps(code), settings, host);
    this.rooms.set(code, room);
    this.deps.log.info({ code, host: host.tokenHash.slice(0, 8) }, 'room created');
    return ok({ room });
  }

  private onClosed(room: Room, reason: RoomClosedReason): void {
    if (this.rooms.get(room.code) !== room) return;
    this.rooms.delete(room.code);
    this.deps.codes.release(room.code);
    this.deps.log.info({ code: room.code, reason }, 'room closed');
  }

  listPublic(): PublicRoomSummary[] {
    return [...this.rooms.values()]
      .filter((r) => r.phase !== 'closed' && r.settings.visibility === 'public')
      .map((r) => r.summary())
      .sort((a, b) => b.createdAt - a.createdAt || (a.code < b.code ? -1 : 1));
  }

  closeAll(reason: RoomClosedReason): void {
    for (const r of [...this.rooms.values()]) r.close(reason);
  }

  /** 停机：挂起全部房间（可选自动存档与刷快照），不删除持久化数据 */
  suspendAll(o: { flush: boolean; autosave: boolean }): void {
    for (const r of this.rooms.values()) {
      try {
        r.suspend(o);
      } catch (err) {
        this.deps.log.error({ err, code: r.code }, 'room suspend failed');
      }
    }
  }

  /** 存档是否正被进行中的对局使用（存档所在房间仍在对局，或某房间由它读档而来）：此时禁止导出 */
  isSaveInPlay(saveId: string, roomCode: string | null): boolean {
    for (const r of this.rooms.values()) {
      if (!r.inGame) continue;
      if ((roomCode !== null && r.code === roomCode) || r.sourceSaveId === saveId) return true;
    }
    return false;
  }

  stats(): { rooms: number; playing: number; members: number } {
    let playing = 0;
    let members = 0;
    for (const r of this.rooms.values()) {
      if (r.inGame) playing++;
      members += r.connectedMembers().length;
    }
    return { rooms: this.rooms.size, playing, members };
  }

  // ───────────────────────── 重启恢复 ─────────────────────────

  /**
   * 启动时恢复房间（design/net.md §8.5）：
   * 1. 过期（maxAgeMs 之前）的快照删除；逐个加载其余快照。
   * 2. 引擎主版本与 state 版本都一致：重放 epoch 内 seq > 快照 seq 的 journal；否则只 migrateState（不重放 journal），
   *    迁移失败或状态校验不过则转为存档 auto:<code>（「服务器升级，请读档继续」）并删除房间。
   * 3. 恢复出的对局 epoch+1、全员视为断线、暂停；随即写一次新快照（清掉已重放的 journal）。
   */
  restore(o: RestoreOptions): RestoreReport[] {
    const out: RestoreReport[] = [];
    const now = this.deps.clock.now();
    const since = now - o.maxAgeMs;
    try {
      const pruned = o.store.pruneBefore(since);
      if (pruned > 0) this.deps.log.info({ pruned }, 'expired room snapshots removed');
    } catch (err) {
      this.deps.log.error({ err }, 'prune room snapshots failed');
    }
    const recs = o.store.listActive(since, (code, err) => {
      this.deps.log.error({ err, code }, 'room snapshot unreadable; dropped');
      out.push({ code, phase: 'unknown', mode: 'failed', replayed: 0, epoch: 0, seq: 0, error: String(err) });
      this.safeDelete(o.store, code);
    });
    for (const rec of recs) {
      if (this.rooms.has(rec.code)) continue;
      let rep: RestoreReport;
      try {
        rep = this.restoreOne(o, rec);
      } catch (err) {
        this.deps.log.error({ err, code: rec.code }, 'room restore failed; dropped');
        this.rooms.delete(rec.code);
        this.safeDelete(o.store, rec.code);
        rep = {
          code: rec.code,
          phase: rec.phase,
          mode: 'failed',
          replayed: 0,
          epoch: rec.epoch,
          seq: rec.seq,
          error: String(err),
        };
      }
      out.push(rep);
    }
    if (out.length > 0) this.deps.log.info({ rooms: out.map((r) => `${r.code}:${r.mode}`) }, 'rooms restored');
    return out;
  }

  private safeDelete(store: RoomStore, code: string): void {
    try {
      store.deleteRoom(code);
    } catch (err) {
      this.deps.log.error({ err, code }, 'delete room snapshot failed');
    }
  }

  private adopt(room: Room): void {
    this.rooms.set(room.code, room);
    this.deps.persist?.snapshot(room);
  }

  private restoreOne(o: RestoreOptions, rec: RoomSnapshotRecord): RestoreReport {
    const base = { code: rec.code, phase: rec.phase };
    if (rec.phase === 'lobby' || rec.state === null) {
      let loaded: LoadedSave | null = null;
      const id = rec.meta.loadedSaveId;
      if (id && o.openSave) {
        const r = o.openSave(id);
        if (r.ok) loaded = r.data;
        else this.deps.log.warn({ code: rec.code, saveId: id, error: r.error }, 'loaded save no longer available');
      }
      const room = Room.restore(this.roomDeps(rec.code), { ...rec, phase: 'lobby' }, null, loaded);
      this.adopt(room);
      return { ...base, mode: 'lobby', replayed: 0, epoch: room.epoch, seq: 0 };
    }
    const engine = this.deps.engine;
    if (!engine) {
      // 引擎不可用（例如数据加载失败）：不删快照，下次启动再恢复
      this.deps.log.error({ code: rec.code }, 'engine unavailable; room snapshot kept for next start');
      return { ...base, mode: 'skipped', replayed: 0, epoch: rec.epoch, seq: rec.seq, error: 'engineUnavailable' };
    }
    const ref = rec.state.dataRef;
    try {
      this.deps.maps.registry.getMap(ref.mapId, ref.mapHash);
    } catch {
      return this.convert(o, rec, `map ${ref.mapId} unavailable`);
    }
    let state: GameState = rec.state;
    let seq = rec.seq;
    let replayed = 0;
    let mode: RestoreReport['mode'];
    let error: string | undefined;
    if (
      rulesVersion(rec.engineVersion) === rulesVersion(engine.ENGINE_VERSION) &&
      rec.stateVersion === engine.STATE_SCHEMA_VERSION
    ) {
      mode = 'journal';
      for (const row of o.store.readJournal(rec.code, rec.epoch, rec.seq)) {
        if (row.seq !== seq + 1) {
          error = `journal gap at seq ${row.seq} (expected ${seq + 1})`;
          break;
        }
        try {
          state = engine.applyAction(state, row.action).state;
        } catch (err) {
          error = `journal replay failed at seq ${row.seq}: ${String(err)}`;
          break;
        }
        seq = row.seq;
        replayed++;
      }
      if (error) this.deps.log.error({ code: rec.code, error }, 'journal replay stopped early');
    } else {
      mode = 'migrated';
      try {
        state = engine.migrateState(rec.state, rec.stateVersion);
      } catch (err) {
        return this.convert(o, rec, String(err));
      }
    }
    let valid = false;
    try {
      valid = engine.validateState(state);
    } catch {
      valid = false;
    }
    if (!valid) return this.convert(o, rec, 'validateState failed');
    const room = Room.restore(this.roomDeps(rec.code), rec, { state, seq }, null);
    this.adopt(room);
    return { ...base, mode, replayed, epoch: room.epoch, seq, ...(error ? { error } : {}) };
  }

  /** 无法恢复的对局转为存档 auto:<code>，owner 为座位上的真人；然后删除房间快照 */
  private convert(o: RestoreOptions, rec: RoomSnapshotRecord, reason: string): RestoreReport {
    const state = rec.state!;
    const owners = rec.meta.seats.flatMap((s) => (s.occupant?.kind === 'human' ? [s.occupant.tokenHash] : []));
    let mode: RestoreReport['mode'] = 'failed';
    if (o.storeSave && owners.length > 0) {
      const file = buildSaveFile({
        name: '服务器升级前的对局（请读档继续）',
        savedAt: this.deps.clock.now(),
        engine: { ENGINE_VERSION: rec.engineVersion, STATE_SCHEMA_VERSION: rec.stateVersion },
        settings: rec.meta.settings,
        seats: saveSeatsOf(state, (seat) => rec.meta.seats.find((s) => s.index === seat)?.occupant ?? null),
        state,
        // 观战者专属聊天不进存档（存档可被玩家导出）
        chat: rec.meta.chat.filter((m) => m.audience === 'all'),
      });
      const r = o.storeSave(file, rec.code, owners, sourceVerifiedOf(rec.meta));
      if (r.ok) mode = 'converted';
      else this.deps.log.error({ code: rec.code, error: r.error }, 'convert room to save failed');
    }
    this.deps.log.warn({ code: rec.code, reason, saveId: autoSaveId(rec.code), mode }, 'room not restorable');
    this.safeDelete(o.store, rec.code);
    return { code: rec.code, phase: rec.phase, mode, replayed: 0, epoch: rec.epoch, seq: rec.seq, error: reason };
  }
}
