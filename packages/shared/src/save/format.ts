/**
 * 存档格式（architecture §5.12；design/net.md §8.3）。
 *
 * - 数据库存 gzip(JSON)，另存 HMAC-SHA256 签名；导出文件为 .r4save，内容 `R4S1.<b64url(gzip)>.<b64url(sig)>`。
 * - 兼容性：stateVersion 较旧 → engine.migrateState；mapHash 不符且无迁移 → SAVE_INCOMPATIBLE；tablesHash 不符只告警；
 *   签名无效仍可读取，但标记为「非官方存档」。
 * - shared/save 与 shared/net 互不依赖（architecture §3），所以 RoomSettings 与 ChatMessage 以泛型参数注入：
 *   服务器使用 `SaveFileV1<RoomSettings, ChatMessage>`。
 */
import type { CharacterId, DateNum, SeatAiConfig, SeatIndex } from '../engine/types/ids';
import type { GameState } from '../engine/types/state';

export const SAVE_FORMAT = 'rich4-save' as const;
export const SAVE_SCHEMA_VERSION = 1 as const;
/** 导出文本的前缀（版本 1） */
export const SAVE_EXPORT_PREFIX = 'R4S1' as const;
export const SAVE_FILE_EXT = '.r4save' as const;

export type SaveSeatKind = 'human' | 'ai';

export interface SaveSeat {
  index: SeatIndex;
  characterId: CharacterId;
  nickname: string;
  kind: SaveSeatKind;
  ai?: SeatAiConfig;
  /** sha256(token) 的 hex；读档时匹配的成员自动入座 */
  ownerTokenHash?: string;
}

/** 列表页用的摘要，不用解码 game */
export interface SaveMeta {
  mapId: string;
  gameDay: number;
  date: DateNum;
  seats: { characterId: CharacterId; nickname: string; kind: SaveSeatKind }[];
}

export interface SaveFileV1<TRoomSettings = unknown, TChatMessage = unknown> {
  format: typeof SAVE_FORMAT;
  schemaVersion: typeof SAVE_SCHEMA_VERSION;
  /** @rich4/shared 规则版本（ENGINE_VERSION） */
  engineVersion: string;
  /** 引擎的 STATE_SCHEMA_VERSION */
  stateVersion: number;
  mapRef: { id: string; mapHash: string };
  tablesHash: string;
  savedAt: number;
  name: string;
  meta: SaveMeta;
  roomSettings: TRoomSettings;
  seats: SaveSeat[];
  /** 完整权威状态，包括 secret.rng，读档后结果确定 */
  game: GameState;
  chatTail?: TChatMessage[];
}

/** 以后是 V1 | V2 …，统一经过 migrate.ts 的 migrateSave（M5 实现） */
export type SaveFile<TRoomSettings = unknown, TChatMessage = unknown> = SaveFileV1<TRoomSettings, TChatMessage>;

/** 读档时的兼容性结论 */
export type SaveCompat =
  | { ok: true; warnings: ('tablesHashMismatch' | 'unsigned' | 'needsMigration')[] }
  | { ok: false; reason: 'mapHashMismatch' | 'newerState' | 'badFormat' };

export function isSaveFileV1(x: unknown): x is SaveFileV1 {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return o.format === SAVE_FORMAT && o.schemaVersion === SAVE_SCHEMA_VERSION && typeof o.game === 'object';
}
