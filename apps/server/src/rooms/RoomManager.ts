/**
 * 房间管理（design/net.md §3.1）：创建、查找、回收、容量控制、公开房间列表。
 */
import { defaultGameConfig } from '@rich4/shared/engine';
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
import { applySettingsPatch, type Identity, Room, type RoomDeps } from './Room';
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

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

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

  /** 只读的建房检查（容量、过载、设置补丁）：handler 通过后才离开原大厅房间 */
  prepareCreate(patch: RoomSettingsPatch | undefined): Result<RoomSettings> {
    if (this.rooms.size >= this.deps.maxRooms || this.deps.busy?.()) return fail('SERVER_BUSY');
    const settings = this.defaultSettings();
    return patch ? applySettingsPatch(settings, patch, this.deps.maps) : ok(settings);
  }

  create(host: Identity, patch: RoomSettingsPatch | undefined): Result<{ room: Room }> {
    const prep = this.prepareCreate(patch);
    if (!prep.ok) return prep;
    const settings = prep.data;
    const code = this.deps.codes.allocate((c) => this.rooms.has(c));
    if (code === null) return fail('SERVER_BUSY');
    const room = new Room(
      code,
      {
        ...this.deps,
        onMemberRemoved: (tokenHash) => this.deps.onMemberRemoved(tokenHash, code),
        onClosed: (r, reason) => this.onClosed(r, reason),
      },
      settings,
      host,
    );
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

  stats(): { rooms: number; playing: number; members: number } {
    let playing = 0;
    let members = 0;
    for (const r of this.rooms.values()) {
      if (r.inGame) playing++;
      members += r.connectedMembers().length;
    }
    return { rooms: this.rooms.size, playing, members };
  }
}
