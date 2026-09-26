/**
 * 存档迁移与信封校验（architecture §5.12；design/net.md §8.3）。
 *
 * - migrateSave(raw)：按 schemaVersion 依次执行迁移链，再用 zod 校验信封（元数据、座位、mapRef 等）。
 *   game 只校验为对象：GameState 的结构与不变量由服务器调用 engine.validateState（shared/save 不得依赖引擎实现）；
 *   roomSettings 与 chatTail 的具体结构由调用方用 shared/net 的 schema 校验（save 与 net 互不依赖）。
 * - checkSaveCompat：读档前的兼容性结论（mapHash 不符且无迁移 → 不兼容；stateVersion 更新 → 不兼容；
 *   tablesHash 不符、未签名、需要迁移 state → 只给警告）。
 */
import { z } from 'zod';
import { AI_PRESETS, CHARACTER_IDS } from '../data/tables/ids';
import { SAVE_FORMAT, SAVE_SCHEMA_VERSION, type SaveCompat, type SaveFile } from './format';

export type SaveFormatErrorReason = 'badFormat' | 'newerFormat';

export class SaveFormatError extends Error {
  override name = 'SaveFormatError';
  constructor(
    readonly reason: SaveFormatErrorReason,
    message: string,
  ) {
    super(message);
  }
}

/** 存档里 sha256(token) 的 hex */
const TokenHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const RatioSchema = z.int().min(0).max(100);

const SaveSeatAiSchema = z.strictObject({
  preset: z.enum(AI_PRESETS),
  overrides: z
    .strictObject({
      personality: z.literal([0, 1, 2]).optional(),
      useCards: z.boolean().optional(),
      useItems: z.boolean().optional(),
      loanRatio: RatioSchema.optional(),
      cashRatio: RatioSchema.optional(),
      stockRatio: RatioSchema.optional(),
    })
    .optional(),
});

const SeatIndexSchema = z.literal([0, 1, 2, 3]);
const CharacterIdSchema = z.literal(CHARACTER_IDS);
const SeatKindSchema = z.enum(['human', 'ai']);
/** 昵称与存档名在写入时已清洗；这里只限长度，防止导入超长文本 */
const ShortText = (max: number) => z.string().max(max);

export const SaveSeatSchema = z.strictObject({
  index: SeatIndexSchema,
  characterId: CharacterIdSchema,
  nickname: ShortText(64),
  kind: SeatKindSchema,
  ai: SaveSeatAiSchema.optional(),
  ownerTokenHash: TokenHashSchema.optional(),
});

export const SaveMetaSchema = z.strictObject({
  mapId: ShortText(64).min(1),
  gameDay: z.int().min(0),
  date: z.int().min(19000101).max(29991231),
  seats: z
    .array(z.strictObject({ characterId: CharacterIdSchema, nickname: ShortText(64), kind: SeatKindSchema }))
    .max(4),
});

/** 存档里最多保留的聊天条数（与 CHAT_HISTORY_SIZE 一致；save 不依赖 net，这里单独写死） */
export const SAVE_CHAT_TAIL_MAX = 100;

export const SaveFileV1Schema = z
  .strictObject({
    format: z.literal(SAVE_FORMAT),
    schemaVersion: z.literal(1),
    engineVersion: ShortText(32).min(1),
    stateVersion: z.int().min(1),
    mapRef: z.strictObject({ id: ShortText(64).min(1), mapHash: ShortText(128).min(1) }),
    tablesHash: ShortText(128),
    savedAt: z.number().finite(),
    name: ShortText(64),
    meta: SaveMetaSchema,
    roomSettings: z.unknown(),
    seats: z.array(SaveSeatSchema).min(1).max(4),
    game: z.record(z.string(), z.unknown()),
    chatTail: z.array(z.unknown()).max(SAVE_CHAT_TAIL_MAX).optional(),
  })
  .superRefine((f, ctx) => {
    const idx = f.seats.map((s) => s.index);
    if (new Set(idx).size !== idx.length) ctx.addIssue({ code: 'custom', path: ['seats'], message: 'duplicate seat' });
    const chars = f.seats.map((s) => s.characterId);
    if (new Set(chars).size !== chars.length) {
      ctx.addIssue({ code: 'custom', path: ['seats'], message: 'duplicate character' });
    }
    if (f.meta.mapId !== f.mapRef.id) ctx.addIssue({ code: 'custom', path: ['meta', 'mapId'], message: 'mapId' });
  });

type RawSave = Record<string, unknown>;

/**
 * 迁移链：SAVE_MIGRATIONS[v] 把 schemaVersion=v 的原始对象升到 v+1（纯函数，返回新对象）。
 * v1 是首个版本，目前没有迁移；将来加 V2 时在这里登记 1 → 2。
 */
export const SAVE_MIGRATIONS: Readonly<Record<number, (raw: RawSave) => RawSave>> = Object.freeze({});

function isRecord(x: unknown): x is RawSave {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** 版本迁移链 + zod 信封校验；失败抛 SaveFormatError */
export function migrateSave(raw: unknown): SaveFile {
  if (!isRecord(raw) || raw.format !== SAVE_FORMAT) throw new SaveFormatError('badFormat', 'not a rich4 save');
  let cur: RawSave = raw;
  let v = cur.schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new SaveFormatError('badFormat', 'bad schemaVersion');
  }
  if (v > SAVE_SCHEMA_VERSION) throw new SaveFormatError('newerFormat', `schemaVersion ${v} > ${SAVE_SCHEMA_VERSION}`);
  while (v < SAVE_SCHEMA_VERSION) {
    const step = SAVE_MIGRATIONS[v];
    if (!step) throw new SaveFormatError('badFormat', `no migration from schemaVersion ${v}`);
    cur = step(cur);
    v = cur.schemaVersion;
    if (typeof v !== 'number') throw new SaveFormatError('badFormat', 'migration dropped schemaVersion');
  }
  const r = SaveFileV1Schema.safeParse(cur);
  if (!r.success) {
    const where = r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new SaveFormatError('badFormat', where);
  }
  // game 的 GameState 结构由调用方用 engine.validateState 把关
  return r.data as unknown as SaveFile;
}

export interface SaveCompatEnv {
  /** 当前引擎的 STATE_SCHEMA_VERSION */
  stateVersion: number;
  /** 地图 (id, mapHash) 是否可用（没有地图迁移时 mapHash 必须完全一致） */
  hasMap(id: string, mapHash: string): boolean;
  /** 当前的 tablesHash */
  tablesHash: string;
  /** HMAC 签名是否有效 */
  verified: boolean;
}

/** 读档兼容性结论（format.ts 的 SaveCompat） */
export function checkSaveCompat(save: SaveFile, env: SaveCompatEnv): SaveCompat {
  if (save.stateVersion > env.stateVersion) return { ok: false, reason: 'newerState' };
  if (!env.hasMap(save.mapRef.id, save.mapRef.mapHash)) return { ok: false, reason: 'mapHashMismatch' };
  const warnings: ('tablesHashMismatch' | 'unsigned' | 'needsMigration')[] = [];
  if (save.stateVersion < env.stateVersion) warnings.push('needsMigration');
  if (save.tablesHash !== env.tablesHash) warnings.push('tablesHashMismatch');
  if (!env.verified) warnings.push('unsigned');
  return { ok: true, warnings };
}
