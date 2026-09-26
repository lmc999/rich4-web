/**
 * 全部 C2S payload 与握手 auth 的 zod schema（design/net.md §4.1、§6.2；architecture §5.8）。
 *
 * - 服务端 guard 统一 safeParse，失败返回 BAD_REQUEST；客户端也可以复用做提交前校验。
 * - intent 直接复用引擎导出的 PlayerIntentSchema（只含玩家 intent，不含 MINIGAME_RESULT 等系统 action）；
 *   debug:act 复用 DebugOpSchema。
 * - 一律 strictObject：未知字段直接拒绝。握手 auth 例外（容忍将来客户端追加的字段）。
 * - 文本清洗（sanitizeNickname / sanitizeChatText）按「字」（Unicode 码点）计长度。
 */
import { z } from 'zod';
import { AI_PRESETS, CHARACTER_IDS, INITIAL_FUND_OPTIONS, START_VEHICLES, TENURE_OPTIONS } from '../data/tables/ids';
import type { TimeLimitDays, WinMultiple } from '../engine/types/ids';
import { DebugOpSchema, PlayerIntentSchema } from '../engine/types/intent';
import { InputCode, MINIGAME_MAX_LOG } from '../minigames/types';
import {
  CHAT_MAX_CHARS,
  MAX_SPECTATORS_LIMIT,
  NICKNAME_MAX,
  NICKNAME_MIN,
  ROOM_CODE_RE,
  SAVE_NAME_MAX,
  TOKEN_RE,
} from './limits';
import { type C2SEventName, type C2SPayload, type ChatMessage, type HandshakeAuth, SYSTEM_MSG_KEYS } from './protocol';
import { RECONNECT_GRACE_MAX_S, RECONNECT_GRACE_MIN_S } from './timing';

// ───────────────────────── 文本清洗 ─────────────────────────

/**
 * 去掉的码点：控制字符、零宽字符、双向控制符、BOM，以及其他从不需要显示的默认可忽略码点——软连字符 U+00AD、
 * CGJ U+034F、阿拉伯字母标记 U+061C、Hangul 填充符（U+115F/1160/3164/FFA0，常被用来造「空白」昵称）、
 * 高棉元音 U+17B4/17B5、蒙古文变体选择符与元音分隔符 U+180B–180F、U+FFF0–FFF8、速记格式 U+1BCA0–1BCA3、
 * 音乐格式 U+1D173–1D17A。
 * 保留变体选择符 U+FE00–FE0F / U+E0100–E01EF（emoji 与异体字需要）与 tag 字符 U+E0000–E007F（旗帜子区域）：
 * 它们插在敏感词中间的情况由服务器的敏感词过滤在比对时跳过（apps/server/src/rooms/chatFilter.ts）。
 */
function isStrippedCodePoint(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xad ||
    cp === 0x34f ||
    cp === 0x61c ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 ||
    cp === 0xfeff ||
    cp === 0xffa0 ||
    (cp >= 0xfff0 && cp <= 0xfff8) ||
    (cp >= 0x1bca0 && cp <= 0x1bca3) ||
    (cp >= 0x1d173 && cp <= 0x1d17a)
  );
}

function cleanText(raw: string, keepNewlines: boolean): string[] {
  const out: string[] = [];
  for (const ch of raw.normalize('NFC')) {
    const cp = ch.codePointAt(0) ?? 0;
    if (keepNewlines && cp === 0x0a) out.push(' ');
    else if (!isStrippedCodePoint(cp)) out.push(ch);
  }
  return out;
}

/** NFC 规范化，去掉控制和零宽字符，首尾空白去掉、中间连续空白合并为 1 个，截到 NICKNAME_MAX 字；结果可能为空串 */
export function sanitizeNickname(raw: string): string {
  const s = cleanText(raw, false).join('').trim().replace(/\s+/g, ' ');
  return Array.from(s).slice(0, NICKNAME_MAX).join('');
}

/** 聊天文本：NFC、去控制和零宽字符（换行变空格）、去首尾空白、截到 CHAT_MAX_CHARS 字；结果可能为空串 */
export function sanitizeChatText(raw: string): string {
  return Array.from(cleanText(raw, true).join('').trim()).slice(0, CHAT_MAX_CHARS).join('');
}

/** 存档名：与昵称相同的清洗规则，截到 SAVE_NAME_MAX 字；结果可能为空串 */
export function sanitizeSaveName(raw: string): string {
  const s = cleanText(raw, true).join('').trim().replace(/\s+/g, ' ');
  return Array.from(s).slice(0, SAVE_NAME_MAX).join('');
}

// ───────────────────────── 基础 ─────────────────────────

const int = (min: number, max: number) => z.int().min(min).max(max);

export const SeatSchema = z.literal([0, 1, 2, 3]);
export const CharacterIdSchema = z.literal(CHARACTER_IDS);
export const RoomCodeSchema = z.string().regex(ROOM_CODE_RE);
export const TokenSchema = z.string().regex(TOKEN_RE);
/** 客户端生成的幂等 id */
export const ClientActionIdSchema = z.string().min(1).max(64);
/** 引擎决策 id（`d${n}`），只限长度，由 GameRunner 判断是否存在 */
export const DecisionIdSchema = z.string().min(1).max(32);
export const MapIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
export const SaveIdSchema = z.string().min(1).max(64);

/** 无参数的 C2S payload：只接受 {} */
export const EmptyPayloadSchema = z.strictObject({});

export const HandshakeAuthSchema = z.object({
  token: TokenSchema,
  /** 原始昵称；服务端用 sanitizeNickname 清洗后再检查 NICKNAME_MIN */
  nickname: z.string().min(1).max(64),
  protocolVersion: z.int(),
  clientVersion: z.string().max(64),
});

// ───────────────────────── AI 与托管 ─────────────────────────

const RatioSchema = int(0, 100);

export const AiTraitsPatchSchema = z.strictObject({
  personality: z.literal([0, 1, 2]).optional(),
  useCards: z.boolean().optional(),
  useItems: z.boolean().optional(),
  loanRatio: RatioSchema.optional(),
  cashRatio: RatioSchema.optional(),
  stockRatio: RatioSchema.optional(),
});

export const SeatAiConfigSchema = z.strictObject({
  preset: z.enum(AI_PRESETS),
  overrides: AiTraitsPatchSchema.optional(),
});

/** 与 ai/types.ts 的 isValidTrusteeSettings 一致：比例 0..100 且为 10 的倍数 */
export const TrusteeSettingsSchema = z.strictObject({
  personality: z.literal([0, 1, 2]),
  useCards: z.boolean(),
  useItems: z.boolean(),
  cashRatio: RatioSchema.multipleOf(10),
  stockRatio: RatioSchema.multipleOf(10),
});

// ───────────────────────── 房间设置 ─────────────────────────

export const RuleConfigSchema = z.strictObject({
  preset: z.enum(['program', 'manual', 'custom']),
  redBlack: z.enum(['program', 'manual']),
  fortuneGodLand: z.enum(['program', 'manual']),
  smallPoorToll: z.enum(['x1.5', 'x2']),
  engineeringVehicle: z.enum(['program', 'manual']),
  bombBlast: z.enum(['program', 'manual3x3']),
  sundayBankClosed: z.boolean(),
  handFull: z.enum(['autoCheapest', 'choose']),
  blessingOnNews: z.boolean(),
  deathGodDispellable: z.boolean(),
  freeCardOnFines: z.boolean(),
  stockSuspendDays: z.literal([15, 10]),
  constructionChairmanLevels: z.literal([1, 2]),
  targetRange: z.enum(['window', 'global']),
  windowHalf: int(32, 2048),
  timeMachine: z.enum(['global', 'perSeat', 'disabled']),
  intOverflow: z.enum(['saturate', 'wrap']),
  endWhenNoHumans: z.boolean(),
});

const TIME_LIMIT_VALUES = [0, 730, 365, 182, 91, 30] as const satisfies readonly TimeLimitDays[];
const WIN_MULTIPLE_VALUES = [0, 100, 50, 10, 5, 3] as const satisfies readonly WinMultiple[];

/** 客户端可提交的对局配置（GameConfigInput：不含 startDate 与 debug） */
const gameConfigInputShape = {
  mapId: MapIdSchema,
  initialFund: z.literal(INITIAL_FUND_OPTIONS),
  vehicle: z.enum(START_VEHICLES),
  tenure: z.enum(TENURE_OPTIONS),
  timeLimitDays: z.literal(TIME_LIMIT_VALUES),
  winMultiple: z.literal(WIN_MULTIPLE_VALUES),
  minigames: z.enum(['play', 'skip']),
};

export const GameConfigSchema = z.strictObject({
  ...gameConfigInputShape,
  rules: RuleConfigSchema,
  startDate: int(19000101, 29991231),
  debug: z.boolean(),
});

export const GameConfigPatchSchema = z
  .strictObject({ ...gameConfigInputShape, rules: RuleConfigSchema.partial() })
  .partial();

const roomSettingsShape = {
  visibility: z.enum(['private', 'public']),
  allowSpectators: z.boolean(),
  maxSpectators: int(0, MAX_SPECTATORS_LIMIT),
  spectatorChat: z.enum(['all', 'spectators', 'off']),
  handVisibility: z.enum(['public', 'private']),
  timerPreset: z.enum(['fast', 'normal', 'slow', 'off']),
  timeoutPolicy: z.enum(['default', 'ai']),
  pauseWhenAllAway: z.boolean(),
  aiPace: z.enum(['normal', 'fast']),
  minigameSpectate: z.enum(['live', 'replay']),
  allowMinigameDecline: z.boolean(),
};

/** 完整房间设置（服务端内部与存档导入用；reconnectGraceSec 允许测试用的小数秒） */
export const RoomSettingsSchema = z.strictObject({
  ...roomSettingsShape,
  reconnectGraceSec: z.number().min(0).max(600),
  game: GameConfigSchema,
});

/** room:create / room:updateSettings 的补丁；客户端只能把断线宽限设为 5..120 秒 */
export const RoomSettingsPatchSchema = z
  .strictObject({
    ...roomSettingsShape,
    reconnectGraceSec: int(RECONNECT_GRACE_MIN_S, RECONNECT_GRACE_MAX_S),
    game: GameConfigPatchSchema,
  })
  .partial();

// ───────────────────────── 小游戏 ─────────────────────────

const INPUT_CODES = [InputCode.PickCell, InputCode.Click, InputCode.CursorX] as const;
const TickSchema = int(0, 1_000_000);
const CoordSchema = int(-100_000, 100_000);

export const InputEventSchema = z.tuple([TickSchema, z.literal(INPUT_CODES), CoordSchema, CoordSchema.optional()]);
const SessionIdSchema = z.string().min(1).max(64);

export const MinigameInputMsgSchema = z.strictObject({
  sessionId: SessionIdSchema,
  seq: int(0, 1_000_000),
  events: z.array(InputEventSchema).max(64),
});

export const MinigameSubmitMsgSchema = z.strictObject({
  sessionId: SessionIdSchema,
  inputs: z.array(InputEventSchema).max(MINIGAME_MAX_LOG),
  claimedScore: int(0, 1_000_000),
  finalHash: int(0, 0xffffffff),
  clientElapsedMs: int(0, 3_600_000),
});

// ───────────────────────── 聊天记录（存档 chatTail 与房间快照） ─────────────────────────

const ChatSenderSchema = z.union([
  z.strictObject({ kind: z.literal('seat'), seat: SeatSchema, nickname: z.string().max(64) }),
  z.strictObject({ kind: z.literal('spectator'), id: z.string().min(1).max(64), nickname: z.string().max(64) }),
  z.strictObject({ kind: z.literal('system') }),
]);

/** 一条聊天消息（服务器产生的数据：导入存档与恢复快照时校验，不用于 C2S） */
export const ChatMessageSchema = z.strictObject({
  id: z.string().min(1).max(64),
  ts: z.number().finite(),
  from: ChatSenderSchema,
  text: z
    .string()
    .max(CHAT_MAX_CHARS * 4)
    .optional(),
  system: z
    .strictObject({
      key: z.enum(SYSTEM_MSG_KEYS),
      params: z.record(z.string(), z.union([z.string().max(256), z.number()])),
    })
    .optional(),
  audience: z.enum(['all', 'spectators']),
});

/** ChatMessageSchema 的输出类型必须能赋给协议里的 ChatMessage */
const chatMessageOk: z.infer<typeof ChatMessageSchema> extends ChatMessage ? true : false = true;
void chatMessageOk;

// ───────────────────────── C2S 事件表 ─────────────────────────

/** 全部 C2S 事件的 payload schema（对 ClientToServerEvents 穷举，输出类型必须能赋给协议类型） */
export const C2S_SCHEMAS = Object.freeze({
  'lobby:list': EmptyPayloadSchema,
  'room:create': z.strictObject({ settings: RoomSettingsPatchSchema.optional() }),
  'room:join': z.strictObject({ code: RoomCodeSchema, role: z.enum(['player', 'spectator']) }),
  'room:resume': z.strictObject({ code: RoomCodeSchema, lastSeq: int(0, 2 ** 31 - 1), epoch: int(0, 2 ** 31 - 1) }),
  'room:leave': EmptyPayloadSchema,
  'room:dissolve': EmptyPayloadSchema,
  'room:updateSettings': z.strictObject({ patch: RoomSettingsPatchSchema }),
  'room:takeSeat': z.strictObject({ seat: SeatSchema }),
  'room:toSpectator': EmptyPayloadSchema,
  'room:selectCharacter': z.strictObject({ characterId: CharacterIdSchema }),
  'room:setReady': z.strictObject({ ready: z.boolean() }),
  'room:setSeatAi': z.strictObject({ seat: SeatSchema, ai: SeatAiConfigSchema.nullable() }),
  'room:kick': z.strictObject({
    target: z.union([z.strictObject({ seat: SeatSchema }), z.strictObject({ spectatorId: z.string().min(1).max(64) })]),
  }),
  'room:transferHost': z.strictObject({ seat: SeatSchema }),
  'room:start': EmptyPayloadSchema,
  'room:rematch': EmptyPayloadSchema,
  'room:loadSave': z.strictObject({ saveId: SaveIdSchema }),
  'room:claimSeat': z.strictObject({ seat: SeatSchema }),
  'game:act': z.strictObject({
    decisionId: DecisionIdSchema,
    intent: PlayerIntentSchema,
    clientActionId: ClientActionIdSchema,
  }),
  'game:autopilot': z.strictObject({ on: z.boolean(), settings: TrusteeSettingsSchema.optional() }),
  'game:pause': z.strictObject({ paused: z.boolean() }),
  'game:resync': EmptyPayloadSchema,
  'game:save': z.strictObject({ name: z.string().min(1).max(SAVE_NAME_MAX) }),
  'game:minigameInput': MinigameInputMsgSchema,
  'game:minigameSubmit': MinigameSubmitMsgSchema,
  'saves:list': EmptyPayloadSchema,
  'saves:delete': z.strictObject({ saveId: SaveIdSchema }),
  /** 原始文本上限放宽到 4 倍，服务端清洗后截到 CHAT_MAX_CHARS 字 */
  'chat:send': z.strictObject({
    text: z
      .string()
      .min(1)
      .max(CHAT_MAX_CHARS * 4),
  }),
  'chat:emote': z.strictObject({
    emoteId: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/),
    targetSeat: SeatSchema.optional(),
  }),
  'time:ping': z.strictObject({ t0: z.number().finite() }),
  'debug:act': z.strictObject({ op: DebugOpSchema }),
} as const satisfies { readonly [E in C2SEventName]: z.ZodType<C2SPayload<E>> });

export type C2SSchemas = typeof C2S_SCHEMAS;

/** 握手 auth 的类型必须能赋给协议里的 HandshakeAuth */
const handshakeOk: z.infer<typeof HandshakeAuthSchema> extends HandshakeAuth ? true : false = true;
void handshakeOk;

/** 昵称清洗后的最短长度检查 */
export function isValidNickname(nickname: string): boolean {
  return Array.from(nickname).length >= NICKNAME_MIN;
}
