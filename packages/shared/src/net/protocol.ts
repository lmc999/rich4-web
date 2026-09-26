/**
 * Socket.IO 4.8 协议（architecture §5.8 为最终清单；基础语义见 design/net.md §4）。
 *
 * - C2S 全部带 ack，返回 Result<T>；服务端先广播 batch 再 ack。seat 只从 session 取，payload 里不带 seat。
 * - 事件名 domain:camelCase；异步错误用 app:error（error 是 Socket.IO 保留名）。
 * - 所有 C2S payload 在 shared/net/schemas.ts 有对应的 zod schema（M2 实现），服务端 guard 统一 safeParse，失败返回 BAD_REQUEST。
 * - 客户端：epoch 与本地不同或 seq !== lastSeq+1 → 丢弃 batch 并发 game:resync；seq <= lastSeq 视为重复直接忽略。
 */
import type { TrusteeSettings } from '../ai/types';
import type { DecisionKind } from '../engine/types/decision';
import type { GameEvent } from '../engine/types/events';
import type { CharacterId, DateNum, SeatAiConfig, SeatIndex } from '../engine/types/ids';
import type { DebugOp, IntentType, PlayerIntent, SystemActionType } from '../engine/types/intent';
import type { GameResult } from '../engine/types/state';
import type { InputEvent, MinigameTicket } from '../minigames/types';
import type { DecisionForYou, GameView, PendingView } from '../view/types';
import type { AppError, Result } from './errors';
import type { PublicRoomSummary, RoomClosedReason, RoomSettingsPatch, RoomView, RoomYou } from './room';

export type { TrusteeSettings } from '../ai/types';
export type { SeatControl } from '../view/types';
export type { AppError, ErrorCode, Result } from './errors';

export const PROTOCOL_VERSION = 1 as const;

export type Ack<T = void> = (res: Result<T>) => void;

/** 无参数的 C2S payload */
export type EmptyPayload = Record<string, never>;

/** Socket.IO 握手 auth（客户端 auth 回调每次重连都会重新取值） */
export interface HandshakeAuth {
  /** TOKEN_RE：16 字节 CSPRNG 转 base64url */
  token: string;
  /** 1..12 字，NFC 规范化，去掉控制字符和零宽字符 */
  nickname: string;
  /** 与 PROTOCOL_VERSION 不一致 → connect_error{data:{code:'PROTOCOL_MISMATCH'}} */
  protocolVersion: number;
  /** 构建号，只用于日志 */
  clientVersion: string;
}

export type ActorBy = 'player' | 'ai' | 'autopilot' | 'timeout' | 'system';

/** 批次起因的 intentType：玩家 intent 或系统 action 的 type */
export type CauseIntentType = IntentType | SystemActionType;

/** 本批的起因 */
export interface BatchCause {
  seat: SeatIndex | null;
  intentType: CauseIntentType;
  by: ActorBy;
}

/** 本人的决策（带小游戏票据）；用 view 的 isDecisionForYouOf / asAnyDecision 按 kind 收窄 */
export type YourDecision = DecisionForYou<DecisionKind, MinigameTicket>;
export type YourDecisionOf<K extends DecisionKind> = DecisionForYou<K, MinigameTicket>;

export interface GameBatchMsg {
  epoch: number;
  seq: number;
  cause: BatchCause;
  /** 已按观察者投影（projectEvent） */
  events: GameEvent[];
  /** estimateAnimMs(events)，服务端和客户端共用常量 */
  animMs: number;
  /** 应用 action 之后按观察者投影的完整快照（批尾对账用） */
  view: GameView;
  pending: PendingView[];
  yourDecision?: YourDecision;
  serverNow: number;
}

export interface GameSnapshotMsg {
  epoch: number;
  seq: number;
  view: GameView;
  pending: PendingView[];
  yourDecision?: YourDecision;
  serverNow: number;
}

/** 短暂断线后的补发：只补 events，最后带一份当前 view */
export interface GameCatchupMsg {
  epoch: number;
  batches: Pick<GameBatchMsg, 'seq' | 'cause' | 'events' | 'animMs'>[];
  seq: number;
  view: GameView;
  pending: PendingView[];
  yourDecision?: YourDecision;
  serverNow: number;
}

/** 截止时间或托管状态变了，但没有新的 action（暂停、恢复、重连、切换托管） */
export interface PendingChangedMsg {
  epoch: number;
  seq: number;
  pending: PendingView[];
  yourDecision?: YourDecision;
  serverNow: number;
}

export interface GameOverMsg {
  epoch: number;
  result: GameResult;
  ranking: { seat: SeatIndex; netWorth: number }[];
}

// ───────────────────────── 小游戏 ─────────────────────────

/** C2S：每 200ms 或攒够 8 条发一次；seq 从 0 连续递增，seq=0 可以不带事件，表示「已开局」 */
export interface MinigameInputMsg {
  sessionId: string;
  seq: number;
  events: InputEvent[];
}

/** C2S：inputs 必须以已上传的流为前缀；分数一律以服务器重放为准 */
export interface MinigameSubmitMsg {
  sessionId: string;
  inputs: InputEvent[];
  claimedScore: number;
  finalHash: number;
  clientElapsedMs: number;
}

/** S2C：输入帧实时转发给观战者和其他玩家 */
export interface MinigameFramesMsg {
  sessionId: string;
  seq: number;
  events: InputEvent[];
}

/**
 * S2C：观战票据。live 模式在会话开启时下发（log=null）；replay 模式在结算后下发完整日志（log 非 null）。
 */
export interface MinigameWatchMsg {
  ticket: MinigameTicket;
  mode: 'live' | 'replay';
  log: InputEvent[] | null;
}

// ───────────────────────── 聊天、表情、存档列表 ─────────────────────────

export type ChatSender =
  | { kind: 'seat'; seat: SeatIndex; nickname: string }
  | { kind: 'spectator'; id: string; nickname: string }
  | { kind: 'system' };

/** 系统消息 key（前端本地化，i18n 命名空间 ui:system.*） */
export type SystemMsgKey =
  | 'playerJoined'
  | 'playerLeft'
  | 'spectatorJoined'
  | 'spectatorLeft'
  | 'hostChanged'
  | 'autopilotOn'
  | 'autopilotOff'
  | 'disconnected'
  | 'reconnected'
  | 'kicked'
  | 'timeoutDefault'
  | 'gamePaused'
  | 'gameResumed'
  | 'gameSaved'
  | 'gameLoaded'
  | 'aiPaused'
  /** 对局内部错误（定时器或广播抛出非规则异常），房间已暂停；params 可带 seat */
  | 'internalError'
  /** 服务器重启后恢复了本房间（epoch 已加 1，房间暂停，等真人回来） */
  | 'serverRestored';

/** 全部系统消息 key（编译期对 SystemMsgKey 穷举；存档与快照里的聊天记录据此校验） */
export const SYSTEM_MSG_KEYS = Object.freeze(
  Object.keys({
    playerJoined: 1,
    playerLeft: 1,
    spectatorJoined: 1,
    spectatorLeft: 1,
    hostChanged: 1,
    autopilotOn: 1,
    autopilotOff: 1,
    disconnected: 1,
    reconnected: 1,
    kicked: 1,
    timeoutDefault: 1,
    gamePaused: 1,
    gameResumed: 1,
    gameSaved: 1,
    gameLoaded: 1,
    aiPaused: 1,
    internalError: 1,
    serverRestored: 1,
  } satisfies { readonly [K in SystemMsgKey]: 1 }) as SystemMsgKey[],
);

export interface ChatMessage {
  id: string;
  ts: number;
  from: ChatSender;
  /** 真人消息（≤ CHAT_MAX_CHARS） */
  text?: string;
  /** 系统消息，前端做本地化 */
  system?: { key: SystemMsgKey; params: Record<string, string | number> };
  audience: 'all' | 'spectators';
}

export interface EmoteMsg {
  id: string;
  ts: number;
  from: ChatSender;
  emoteId: string;
  targetSeat?: SeatIndex;
}

export interface SaveSummary {
  saveId: string;
  name: string;
  kind: 'manual' | 'auto';
  mapId: string;
  gameDay: number;
  date: DateNum;
  seats: { characterId: CharacterId; nickname: string; wasHuman: boolean }[];
  createdAt: number;
  /** mapHash 一致且 stateVersion 可迁移 */
  compatible: boolean;
  /** HMAC 签名有效；false 时显示「非官方存档」 */
  verified: boolean;
  /** 兼容性提示（仍可读档）：tablesHashMismatch = 存档的数据表与服务器当前数据不一致 */
  warnings?: SaveWarning[];
}

/** 读档兼容性提示（design/net.md §8.3：只告警、仍允许读取） */
export type SaveWarning = 'tablesHashMismatch' | 'needsMigration' | 'chatTailDropped';

export interface ServerNotice {
  kind: 'shutdown' | 'maintenance' | 'info';
  message: string;
  reconnectInMs?: number;
}

// ───────────────────────── 事件表 ─────────────────────────

export interface ClientToServerEvents {
  // 大厅
  'lobby:list': (p: EmptyPayload, ack: Ack<{ rooms: PublicRoomSummary[] }>) => void;
  // 房间
  'room:create': (p: { settings?: RoomSettingsPatch }, ack: Ack<{ code: string; inviteUrl: string }>) => void;
  'room:join': (p: { code: string; role: 'player' | 'spectator' }, ack: Ack<{ you: RoomYou }>) => void;
  'room:resume': (
    p: { code: string; lastSeq: number; epoch: number },
    ack: Ack<{ mode: 'lobby' | 'events' | 'snapshot' }>,
  ) => void;
  'room:leave': (p: EmptyPayload, ack: Ack) => void;
  /** 仅房主 */
  'room:dissolve': (p: EmptyPayload, ack: Ack) => void;
  /** 仅房主；大厅阶段可改全部，对局中只能改 IN_GAME_MUTABLE_SETTINGS */
  'room:updateSettings': (p: { patch: RoomSettingsPatch }, ack: Ack) => void;
  'room:takeSeat': (p: { seat: SeatIndex }, ack: Ack) => void;
  'room:toSpectator': (p: EmptyPayload, ack: Ack) => void;
  'room:selectCharacter': (p: { characterId: CharacterId }, ack: Ack) => void;
  'room:setReady': (p: { ready: boolean }, ack: Ack) => void;
  /** 仅房主：ai=null 撤掉电脑 */
  'room:setSeatAi': (p: { seat: SeatIndex; ai: SeatAiConfig | null }, ack: Ack) => void;
  'room:kick': (p: { target: { seat: SeatIndex } | { spectatorId: string } }, ack: Ack) => void;
  'room:transferHost': (p: { seat: SeatIndex }, ack: Ack) => void;
  'room:start': (p: EmptyPayload, ack: Ack) => void;
  'room:rematch': (p: EmptyPayload, ack: Ack) => void;
  /** 仅房主，仅大厅阶段 */
  'room:loadSave': (p: { saveId: string }, ack: Ack) => void;
  /** 认领读档后的座位 */
  'room:claimSeat': (p: { seat: SeatIndex }, ack: Ack) => void;
  // room:assignSeat 为可选功能，v1 不实现
  // 对局
  'game:act': (
    p: { decisionId: string; intent: PlayerIntent; clientActionId: string },
    ack: Ack<{ seq: number }>,
  ) => void;
  /** 手动托管开关；settings 经 SYS_SET_AI_TRAITS 写入 state */
  'game:autopilot': (p: { on: boolean; settings?: TrusteeSettings }, ack: Ack) => void;
  /** 仅房主 */
  'game:pause': (p: { paused: boolean }, ack: Ack) => void;
  /** 服务端回推 game:snapshot */
  'game:resync': (p: EmptyPayload, ack: Ack) => void;
  /** 仅房主 */
  'game:save': (p: { name: string }, ack: Ack<{ saveId: string }>) => void;
  'game:minigameInput': (p: MinigameInputMsg, ack: Ack) => void;
  'game:minigameSubmit': (p: MinigameSubmitMsg, ack: Ack<{ score: number }>) => void;
  // 存档
  'saves:list': (p: EmptyPayload, ack: Ack<{ saves: SaveSummary[] }>) => void;
  'saves:delete': (p: { saveId: string }, ack: Ack) => void;
  // 社交
  'chat:send': (p: { text: string }, ack: Ack) => void;
  'chat:emote': (p: { emoteId: string; targetSeat?: SeatIndex }, ack: Ack) => void;
  // 时钟
  'time:ping': (p: { t0: number }, ack: Ack<{ t0: number; serverNow: number }>) => void;
  /** 只在 RICH4_TEST_MODE=1 时注册；服务器提交 SYS_DEBUG */
  'debug:act': (p: { op: DebugOp }, ack: Ack<{ seq: number }>) => void;
}

export interface ServerToClientEvents {
  /** 房间任何变化都发全量（通常小于 2KB） */
  'room:state': (v: RoomView) => void;
  'room:closed': (p: { reason: RoomClosedReason }) => void;
  'game:snapshot': (p: GameSnapshotMsg) => void;
  'game:batch': (p: GameBatchMsg) => void;
  'game:catchup': (p: GameCatchupMsg) => void;
  'game:pending': (p: PendingChangedMsg) => void;
  'game:over': (p: GameOverMsg) => void;
  'game:minigameWatch': (p: MinigameWatchMsg) => void;
  'game:minigameFrames': (p: MinigameFramesMsg) => void;
  'chat:message': (m: ChatMessage) => void;
  /** 加入或恢复时发送 */
  'chat:history': (p: { messages: ChatMessage[] }) => void;
  'chat:emote': (e: EmoteMsg) => void;
  /** 同一 token 在别处登录 */
  'session:replaced': (p: EmptyPayload) => void;
  'server:notice': (p: ServerNotice) => void;
  /** 与请求无关的异步错误 */
  'app:error': (e: AppError) => void;
}

export type C2SEventName = keyof ClientToServerEvents;
export type S2CEventName = keyof ServerToClientEvents;

/** C2S 事件的 payload 类型 */
export type C2SPayload<E extends C2SEventName> = Parameters<ClientToServerEvents[E]>[0];
/** C2S 事件 ack 成功时的数据类型 */
export type C2SAckData<E extends C2SEventName> =
  Parameters<ClientToServerEvents[E]>[1] extends Ack<infer T> ? T : never;
/** S2C 事件的 payload 类型 */
export type S2CPayload<E extends S2CEventName> = Parameters<ServerToClientEvents[E]>[0];

/** 全部 C2S 事件名（编译期对 ClientToServerEvents 穷举） */
export const C2S_EVENTS = Object.freeze(
  Object.keys({
    'lobby:list': 1,
    'room:create': 1,
    'room:join': 1,
    'room:resume': 1,
    'room:leave': 1,
    'room:dissolve': 1,
    'room:updateSettings': 1,
    'room:takeSeat': 1,
    'room:toSpectator': 1,
    'room:selectCharacter': 1,
    'room:setReady': 1,
    'room:setSeatAi': 1,
    'room:kick': 1,
    'room:transferHost': 1,
    'room:start': 1,
    'room:rematch': 1,
    'room:loadSave': 1,
    'room:claimSeat': 1,
    'game:act': 1,
    'game:autopilot': 1,
    'game:pause': 1,
    'game:resync': 1,
    'game:save': 1,
    'game:minigameInput': 1,
    'game:minigameSubmit': 1,
    'saves:list': 1,
    'saves:delete': 1,
    'chat:send': 1,
    'chat:emote': 1,
    'time:ping': 1,
    'debug:act': 1,
  } satisfies { readonly [E in C2SEventName]: 1 }) as C2SEventName[],
);

/** 全部 S2C 事件名 */
export const S2C_EVENTS = Object.freeze(
  Object.keys({
    'room:state': 1,
    'room:closed': 1,
    'game:snapshot': 1,
    'game:batch': 1,
    'game:catchup': 1,
    'game:pending': 1,
    'game:over': 1,
    'game:minigameWatch': 1,
    'game:minigameFrames': 1,
    'chat:message': 1,
    'chat:history': 1,
    'chat:emote': 1,
    'session:replaced': 1,
    'server:notice': 1,
    'app:error': 1,
  } satisfies { readonly [E in S2CEventName]: 1 }) as S2CEventName[],
);
