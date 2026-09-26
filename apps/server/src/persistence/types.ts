/**
 * 持久化层的数据类型（design/net.md §8.2–§8.5；architecture §5.12）。
 * 存储实现（SqliteRoomStore / SqliteSaveRepository / JsonFileStore）只认这里的形状，房间与服务层不直接接触 SQL。
 */
import type { CharacterId, GameAction, GameState, SeatAiConfig, SeatIndex } from '@rich4/shared/engine';
import type { ChatMessage, RoomPhase, RoomSettings } from '@rich4/shared/net';
import type { SaveFileV1, SaveMeta } from '@rich4/shared/save';
import type { SeatControl } from '@rich4/shared/view';

/** 服务器使用的存档文件（RoomSettings 与 ChatMessage 以泛型注入，见 shared/save/format.ts） */
export type ServerSaveFile = SaveFileV1<RoomSettings, ChatMessage>;

// ───────────────────────── 房间快照与 journal ─────────────────────────

/** journal 一行：每应用一个 action 追加一条（actor 为 ActorBy） */
export interface JournalRow {
  seq: number;
  ts: number;
  actor: string;
  action: GameAction;
}

export type PersistedOccupant =
  | { kind: 'human'; tokenHash: string; nickname: string; ready: boolean }
  | { kind: 'ai'; ai: SeatAiConfig; name: string };

export interface PersistedSeat {
  index: SeatIndex;
  characterId: CharacterId | null;
  occupant: PersistedOccupant | null;
  /** 对局中 GameRunner 的控制方（大厅为 null） */
  control: SeatControl | null;
}

/** 房间元数据（room_snapshots.meta_json）：设置、座位（含 tokenHash/control/AI 配置）、房主、观战者、聊天尾部 */
export interface RoomMetaV1 {
  v: 1;
  createdAt: number;
  settings: RoomSettings;
  hostToken: string | null;
  seats: PersistedSeat[];
  spectators: { id: string; tokenHash: string; nickname: string }[];
  chat: ChatMessage[];
  paused: { reason: 'host' | 'all_away'; since: number } | null;
  /** 大厅里已读取、尚未开局的存档（恢复时按 id 重新读取） */
  loadedSaveId: string | null;
  /** 本局由哪个存档读档而来（导出保护用） */
  sourceSaveId: string | null;
  /** 本局来源是否可信（读档来源存档的 verified；新开的对局为 true）。旧快照没有该字段，见 Room.sourceVerifiedOf */
  sourceVerified?: boolean;
}

/** 一个房间的快照（room_snapshots 一行，state 已解码） */
export interface RoomSnapshotRecord {
  code: string;
  epoch: number;
  seq: number;
  phase: RoomPhase;
  engineVersion: string;
  stateVersion: number;
  meta: RoomMetaV1;
  /** 大厅阶段为 null */
  state: GameState | null;
  updatedAt: number;
}

export interface RoomStore {
  /** 追加一条 journal（同一 (code, epoch, seq) 重复写入时覆盖） */
  appendJournal(code: string, epoch: number, row: JournalRow): void;
  /** 写快照，并删除该房间快照之前（seq ≤ 快照 seq 或 epoch 不同）的 journal */
  writeSnapshot(rec: RoomSnapshotRecord): void;
  /** 读取 epoch 内 seq > afterSeq 的 journal（按 seq 升序） */
  readJournal(code: string, epoch: number, afterSeq: number): JournalRow[];
  /** updated_at ≥ sinceMs 的快照；单个房间解码失败时交给 onError 并跳过 */
  listActive(sinceMs: number, onError?: (code: string, err: unknown) => void): RoomSnapshotRecord[];
  /** 删除房间的快照与 journal（房间关闭） */
  deleteRoom(code: string): void;
  /** 删除 updated_at < beforeMs 的快照及其 journal（过期房间），返回删除数 */
  pruneBefore(beforeMs: number): number;
}

// ───────────────────────── 存档 ─────────────────────────

export type SaveKind = 'manual' | 'auto';

/** saves.meta_json：列表页用的摘要（不解码 blob） */
export interface SaveListMeta extends SaveMeta {
  mapHash: string;
  tablesHash: string;
}

export interface SaveRow {
  id: string;
  name: string;
  kind: SaveKind;
  roomCode: string | null;
  schemaVersion: number;
  engineVersion: string;
  stateVersion: number;
  mapId: string;
  gameDay: number;
  meta: SaveListMeta;
  /** HMAC 签名有效（导入的非官方存档为 false） */
  verified: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SaveRecord extends SaveRow {
  /** gzip(JSON(SaveFile)) */
  blob: Uint8Array;
  /** base64url(HMAC-SHA256(blob))；未验证的导入存档为空串 */
  sig: string;
}

export interface SaveRepository {
  /** 插入或覆盖（同 id 覆盖，例如 auto:<roomCode>）；owners 整体替换为给定集合 */
  put(rec: SaveRecord, owners: readonly string[]): void;
  get(id: string): SaveRecord | null;
  /** 某 owner 的存档，按 updatedAt 降序 */
  listByOwner(tokenHash: string): SaveRow[];
  isOwner(id: string, tokenHash: string): boolean;
  addOwners(id: string, owners: readonly string[]): void;
  /** 移除一个 owner；没有 owner 的存档随之删除。返回是否移除了 */
  removeOwner(id: string, tokenHash: string): boolean;
  /** 某 owner 的手动存档超过 keep 个时，移除其最旧的若干个（返回移除的 id） */
  trimManual(tokenHash: string, keep: number): string[];
  count(): number;
}

/** 键值元数据（HMAC 回退密钥等） */
export interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}
