/**
 * 存档服务（design/net.md §8.3–§8.4；architecture §5.12）：编码、签名、归属、配额、读档校验、导入导出。
 *
 * - 写入：blob = gzip(JSON(SaveFile))，sig = HMAC-SHA256(blob)；房间里所有真人参与者都是 owner；
 *   每个 owner 最多 MAX_MANUAL_SAVES_PER_OWNER 个手动存档，超出时移除其最旧的手动存档归属。
 * - 读档：migrateSave（信封）→ RoomSettings / chatTail 校验 → checkSaveCompat（mapHash、stateVersion）
 *   → engine.migrateState → engine.validateState → 座位与 state.players 对应；签名无效仍可读，verified=false。
 * - 导出与读档：存档所在对局（或由它读档的对局）仍在进行时拒绝（SAVE_FORBIDDEN{gameInProgress}）：
 *   导出文件里有 state.secret（随机数状态、牌堆顺序），另开房间读档试走也能预知进行中对局的随机结果。
 * - 导入：解码 → 同读档的全部校验 → 以导入者为 owner 重新编码入库；未验证的存档 sig 存空串（再导出仍是非官方存档）。
 * - 解压后 JSON 上限 SAVE_DECODE_MAX_JSON_BYTES（2MB），state.engine 必须是 semver：导入存档是任何匿名 token 都能提交的
 *   不可信输入，宽松字段里塞的垃圾会随每个 view、快照与自动存档放大。
 * - 由未验证存档读档开局的对局，之后的手动 / 自动存档同样不签名（store 的 verified=false）。
 */
import type { EngineApi, GameState, SeatIndex } from '@rich4/shared/engine';
import {
  type ChatMessage,
  ChatMessageSchema,
  fail,
  MAX_MANUAL_SAVES_PER_OWNER,
  ok,
  type Result,
  type RoomSettings,
  RoomSettingsSchema,
  SAVE_DECODE_MAX_JSON_BYTES,
  type SaveSummary,
  type SaveWarning,
  sanitizeSaveName,
} from '@rich4/shared/net';
import {
  checkSaveCompat,
  migrateSave,
  SAVE_CHAT_TAIL_MAX,
  SAVE_FILE_EXT,
  SAVE_FORMAT,
  SAVE_SCHEMA_VERSION,
  type SaveFile,
  SaveFormatError,
  type SaveSeat,
} from '@rich4/shared/save';
import type { MapCatalog } from '../data/DataRegistry';
import type { Clock } from '../infra/clock';
import type { Logger } from '../infra/logger';
import { CodecError, decodeR4S1, encodeR4S1, gunzipJson, gzipJson, type Signer } from './codec';
import type {
  PersistedOccupant,
  SaveKind,
  SaveListMeta,
  SaveRecord,
  SaveRepository,
  SaveRow,
  ServerSaveFile,
} from './types';

/** 读档得到的内容（game 已迁移并通过 validateState） */
export interface LoadedSave {
  saveId: string;
  name: string;
  verified: boolean;
  file: ServerSaveFile;
  warnings: SaveWarning[];
}

/** state.engine 的形状（ENGINE_VERSION 为 semver）：挡住导入存档里塞进去的超长字符串（它会随每个 view 下发） */
const ENGINE_VERSION_RE = /^\d{1,4}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,16})?$/;

export interface SaveServiceDeps {
  repo: SaveRepository;
  signer: Signer;
  engine: EngineApi | null;
  catalog: MapCatalog;
  clock: Clock;
  log: Logger;
  /** 手动存档 id（随机） */
  newId(): string;
  /** 存档是否正被进行中的对局使用（RoomManager.isSaveInPlay）；缺省视为否 */
  inPlay?(saveId: string, roomCode: string | null): boolean;
}

export interface BuildSaveInput {
  name: string;
  savedAt: number;
  engine: Pick<EngineApi, 'ENGINE_VERSION' | 'STATE_SCHEMA_VERSION'>;
  settings: RoomSettings;
  seats: SaveSeat[];
  state: GameState;
  chat: readonly ChatMessage[];
}

export const AUTO_SAVE_PREFIX = 'auto:';

export function autoSaveId(roomCode: string): string {
  return `${AUTO_SAVE_PREFIX}${roomCode}`;
}

/** 由 state.players 与各座位的占用者生成 SaveSeat（真人带 ownerTokenHash，电脑带 ai 配置） */
export function saveSeatsOf(state: GameState, occupantOf: (seat: SeatIndex) => PersistedOccupant | null): SaveSeat[] {
  return state.players.map((p): SaveSeat => {
    const o = occupantOf(p.seat);
    if (o?.kind === 'human') {
      return {
        index: p.seat,
        characterId: p.character,
        nickname: o.nickname,
        kind: 'human',
        ownerTokenHash: o.tokenHash,
      };
    }
    if (o?.kind === 'ai') {
      const ai = o.ai.overrides ? { preset: o.ai.preset, overrides: { ...o.ai.overrides } } : { preset: o.ai.preset };
      return { index: p.seat, characterId: p.character, nickname: o.name, kind: 'ai', ai };
    }
    return { index: p.seat, characterId: p.character, nickname: '', kind: p.controller === 'ai' ? 'ai' : 'human' };
  });
}

/** 组装 SaveFileV1（Room 存档与重启恢复失败时转存档共用） */
export function buildSaveFile(i: BuildSaveInput): ServerSaveFile {
  const s = i.state;
  const seats = [...i.seats].sort((a, b) => a.index - b.index);
  return {
    format: SAVE_FORMAT,
    schemaVersion: SAVE_SCHEMA_VERSION,
    engineVersion: i.engine.ENGINE_VERSION,
    stateVersion: i.engine.STATE_SCHEMA_VERSION,
    mapRef: { id: s.dataRef.mapId, mapHash: s.dataRef.mapHash },
    tablesHash: s.dataRef.tablesHash,
    savedAt: i.savedAt,
    name: i.name,
    meta: {
      mapId: s.dataRef.mapId,
      gameDay: s.clock.elapsedDays,
      date: s.clock.date,
      seats: seats.map((x) => ({ characterId: x.characterId, nickname: x.nickname, kind: x.kind })),
    },
    roomSettings: i.settings,
    seats,
    game: s,
    chatTail: i.chat.slice(-SAVE_CHAT_TAIL_MAX),
  };
}

function incompatible(reason: string, extra: Record<string, unknown> = {}): Result<never> {
  return fail('SAVE_INCOMPATIBLE', { reason, ...extra });
}

/** Content-Disposition 里用的 ASCII 文件名 */
function asciiName(id: string): string {
  return `rich4-${id.replace(/[^A-Za-z0-9_-]+/g, '-')}${SAVE_FILE_EXT}`;
}

export class SaveService {
  constructor(private readonly d: SaveServiceDeps) {}

  // ───────────────────────── 写入 ─────────────────────────

  private encode(file: ServerSaveFile, verified: boolean): { blob: Uint8Array; sig: string } {
    const blob = gzipJson(file);
    return { blob, sig: verified ? this.d.signer.sign(blob) : '' };
  }

  private record(
    id: string,
    file: ServerSaveFile,
    o: { kind: SaveKind; roomCode: string | null; verified: boolean },
  ): SaveRecord {
    const { blob, sig } = this.encode(file, o.verified);
    const now = this.d.clock.now();
    const meta: SaveListMeta = { ...file.meta, mapHash: file.mapRef.mapHash, tablesHash: file.tablesHash };
    return {
      id,
      name: file.name,
      kind: o.kind,
      roomCode: o.roomCode,
      schemaVersion: file.schemaVersion,
      engineVersion: file.engineVersion,
      stateVersion: file.stateVersion,
      mapId: file.mapRef.id,
      gameDay: file.meta.gameDay,
      meta,
      verified: o.verified,
      blob,
      sig,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 写入房间存档（手动：新 id；自动：覆盖 auto:<roomCode>）。
   * verified=false：对局来自未验证（非官方）的存档，产出的存档同样不签名，「非官方」标记不能靠读档再存一次洗掉。
   */
  store(
    file: ServerSaveFile,
    o: { kind: SaveKind; roomCode: string; owners: readonly string[]; verified?: boolean },
  ): Result<{ saveId: string }> {
    const id = o.kind === 'auto' ? autoSaveId(o.roomCode) : this.d.newId();
    try {
      this.d.repo.put(
        this.record(id, file, { kind: o.kind, roomCode: o.roomCode, verified: o.verified ?? true }),
        o.owners,
      );
      if (o.kind === 'manual') {
        for (const owner of new Set(o.owners)) this.d.repo.trimManual(owner, MAX_MANUAL_SAVES_PER_OWNER);
      }
    } catch (err) {
      this.d.log.error({ err, id, room: o.roomCode }, 'save write failed');
      return fail('INTERNAL', { reason: 'saveWriteFailed' });
    }
    return ok({ saveId: id });
  }

  addOwners(saveId: string, owners: readonly string[]): void {
    try {
      this.d.repo.addOwners(saveId, owners);
    } catch (err) {
      this.d.log.error({ err, saveId }, 'save addOwners failed');
    }
  }

  // ───────────────────────── 列表与删除 ─────────────────────────

  private hasMap(id: string, mapHash: string): boolean {
    if (!this.d.catalog.isPlayable(id)) return false;
    try {
      this.d.catalog.registry.getMap(id, mapHash);
      return true;
    } catch {
      return false;
    }
  }

  private summary(r: SaveRow): SaveSummary {
    const stateVersion = this.d.engine?.STATE_SCHEMA_VERSION ?? 0;
    return {
      saveId: r.id,
      name: r.name,
      kind: r.kind,
      mapId: r.mapId,
      gameDay: r.gameDay,
      date: r.meta.date,
      seats: r.meta.seats.map((x) => ({
        characterId: x.characterId,
        nickname: x.nickname,
        wasHuman: x.kind === 'human',
      })),
      createdAt: r.updatedAt,
      compatible: r.stateVersion <= stateVersion && this.hasMap(r.mapId, r.meta.mapHash),
      verified: r.verified,
      warnings: this.rowWarnings(r, stateVersion),
    };
  }

  /** 列表页不解码 blob：只按行元数据判断 */
  private rowWarnings(r: SaveRow, stateVersion: number): SaveWarning[] {
    const out: SaveWarning[] = [];
    if (r.meta.tablesHash !== this.d.catalog.registry.tablesHash) out.push('tablesHashMismatch');
    if (r.stateVersion < stateVersion) out.push('needsMigration');
    return out;
  }

  list(tokenHash: string): SaveSummary[] {
    return this.d.repo.listByOwner(tokenHash).map((r) => this.summary(r));
  }

  /** 移除自己的归属（没有 owner 时删除存档）；不是 owner 与不存在同样返回 SAVE_NOT_FOUND */
  remove(tokenHash: string, saveId: string): Result<void> {
    return this.d.repo.removeOwner(saveId, tokenHash) ? ok(undefined) : fail('SAVE_NOT_FOUND');
  }

  // ───────────────────────── 读档 ─────────────────────────

  /** 解码 + 全部校验（读档与导入共用） */
  private decode(blob: Uint8Array, sig: string, fallbackName: string): Result<Omit<LoadedSave, 'saveId'>> {
    const engine = this.d.engine;
    if (!engine) return fail('INTERNAL', { reason: 'engineUnavailable' });
    let raw: unknown;
    try {
      raw = gunzipJson(blob, SAVE_DECODE_MAX_JSON_BYTES);
    } catch (err) {
      return incompatible(err instanceof CodecError ? err.reason : 'badEncoding');
    }
    let save: SaveFile;
    try {
      save = migrateSave(raw);
    } catch (err) {
      if (err instanceof SaveFormatError) return incompatible(err.reason, { message: err.message });
      throw err;
    }
    const settings = RoomSettingsSchema.safeParse(save.roomSettings);
    if (!settings.success) return incompatible('badFormat', { message: 'roomSettings' });
    const warnings: SaveWarning[] = [];
    const chat: ChatMessage[] = [];
    for (const m of save.chatTail ?? []) {
      const r = ChatMessageSchema.safeParse(m);
      if (r.success) chat.push(r.data);
    }
    if (chat.length !== (save.chatTail ?? []).length) warnings.push('chatTailDropped');
    const verified = this.d.signer.verify(blob, sig);
    const compat = checkSaveCompat(save, {
      stateVersion: engine.STATE_SCHEMA_VERSION,
      hasMap: (id, h) => this.hasMap(id, h),
      tablesHash: this.d.catalog.registry.tablesHash,
      verified,
    });
    if (!compat.ok) return incompatible(compat.reason);
    // 'unsigned' 已由 verified 表达
    for (const w of compat.warnings) if (w !== 'unsigned') warnings.push(w);
    let game: unknown = save.game;
    if (save.stateVersion < engine.STATE_SCHEMA_VERSION) {
      try {
        game = engine.migrateState(game, save.stateVersion);
      } catch (err) {
        this.d.log.warn({ err }, 'save migrateState failed');
        return incompatible('migrationFailed');
      }
    }
    let valid = false;
    try {
      valid = engine.validateState(game);
    } catch {
      valid = false;
    }
    // state 自带的版本号必须与（迁移后的）引擎版本一致
    if (!valid || (game as { v?: unknown }).v !== engine.STATE_SCHEMA_VERSION) return incompatible('invalidState');
    const state = game as GameState;
    if (!ENGINE_VERSION_RE.test(state.engine)) return incompatible('invalidState', { field: 'engine' });
    if (state.dataRef.mapId !== save.mapRef.id || state.dataRef.mapHash !== save.mapRef.mapHash) {
      return incompatible('mapRefMismatch');
    }
    for (const seat of save.seats) {
      const p = state.players.find((x) => x.seat === seat.index);
      if (!p || p.character !== seat.characterId) return incompatible('seatMismatch', { seat: seat.index });
    }
    if (save.seats.length !== state.players.length) return incompatible('seatMismatch');
    const name = sanitizeSaveName(save.name) || fallbackName;
    const file: ServerSaveFile = {
      ...save,
      name,
      stateVersion: engine.STATE_SCHEMA_VERSION,
      roomSettings: settings.data as RoomSettings,
      game: state,
      chatTail: chat,
    };
    return ok({ name, verified, file, warnings });
  }

  /**
   * 读取存档（room:loadSave）。tokenHash=null 时不校验归属（重启恢复读档中的大厅用）。
   * 不存在 → SAVE_NOT_FOUND；不是 owner → SAVE_FORBIDDEN；不兼容 → SAVE_INCOMPATIBLE{reason}。
   */
  open(tokenHash: string | null, saveId: string): Result<LoadedSave> {
    const rec = this.d.repo.get(saveId);
    if (!rec) return fail('SAVE_NOT_FOUND');
    if (tokenHash !== null) {
      if (!this.d.repo.isOwner(saveId, tokenHash)) return fail('SAVE_FORBIDDEN');
      if (this.d.inPlay?.(saveId, rec.roomCode)) return fail('SAVE_FORBIDDEN', { reason: 'gameInProgress' });
    }
    const r = this.decode(rec.blob, rec.sig, rec.name);
    if (!r.ok) return r;
    // 库里记的 verified 是写入 / 导入时的结论；签名密钥轮换后以当前校验结果为准
    return ok({ saveId, ...r.data, verified: r.data.verified && rec.verified });
  }

  // ───────────────────────── 导入导出 ─────────────────────────

  /** 导出文本；存档正被进行中的对局使用时拒绝 */
  exportText(tokenHash: string, saveId: string): Result<{ text: string; filename: string; name: string }> {
    const rec = this.d.repo.get(saveId);
    if (!rec || !this.d.repo.isOwner(saveId, tokenHash)) return fail('SAVE_NOT_FOUND');
    if (this.d.inPlay?.(saveId, rec.roomCode)) return fail('SAVE_FORBIDDEN', { reason: 'gameInProgress' });
    return ok({ text: encodeR4S1(rec.blob, rec.sig), filename: asciiName(rec.id), name: rec.name });
  }

  /** 导入 .r4save 文本：以导入者为 owner 入库，返回摘要（verified=false 即「非官方存档」） */
  importText(tokenHash: string, text: string): Result<SaveSummary> {
    let blob: Uint8Array;
    let sig: string;
    try {
      ({ blob, sig } = decodeR4S1(text));
    } catch (err) {
      return incompatible(err instanceof CodecError ? err.reason : 'badEncoding');
    }
    const r = this.decode(blob, sig, '导入的存档');
    if (!r.ok) return r;
    const id = this.d.newId();
    // decode 已按码点清洗并截到 SAVE_NAME_MAX 字；这里不能再按 UTF-16 截断（会截短名字、留下孤立代理项）
    const file: ServerSaveFile = r.data.file;
    try {
      this.d.repo.put(this.record(id, file, { kind: 'manual', roomCode: null, verified: r.data.verified }), [
        tokenHash,
      ]);
      this.d.repo.trimManual(tokenHash, MAX_MANUAL_SAVES_PER_OWNER);
    } catch (err) {
      this.d.log.error({ err }, 'save import write failed');
      return fail('INTERNAL', { reason: 'saveWriteFailed' });
    }
    const row = this.d.repo.listByOwner(tokenHash).find((x) => x.id === id);
    if (!row) return fail('INTERNAL', { reason: 'saveWriteFailed' });
    this.d.log.info({ id, verified: r.data.verified, warnings: r.data.warnings }, 'save imported');
    return ok(this.summary(row));
  }
}
