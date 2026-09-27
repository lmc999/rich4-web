/**
 * 协议错误码与中文默认文案（design/net.md §4.2）。客户端优先按 code 走 i18n，缺失时回退到这里的文案。
 */

export type ErrorCode =
  // 连接与通用
  | 'BAD_HANDSHAKE'
  | 'PROTOCOL_MISMATCH'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED'
  | 'SERVER_BUSY'
  | 'INTERNAL'
  // 房间
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_IN_GAME'
  | 'ALREADY_IN_ROOM'
  | 'NOT_IN_ROOM'
  | 'NOT_HOST'
  | 'NOT_A_PLAYER'
  | 'SEAT_TAKEN'
  | 'CHARACTER_TAKEN'
  | 'NOT_ALL_READY'
  | 'NOT_ENOUGH_PLAYERS'
  | 'SPECTATORS_DISABLED'
  | 'MAP_UNAVAILABLE'
  // 对局
  | 'GAME_PAUSED'
  | 'GAME_OVER'
  | 'NOT_YOUR_DECISION'
  | 'STALE_DECISION'
  | 'INVALID_ACTION'
  // 小游戏
  | 'MINIGAME_INVALID'
  | 'MINIGAME_TOO_EARLY'
  | 'MINIGAME_TOO_LATE'
  // 存档
  | 'SAVE_NOT_FOUND'
  | 'SAVE_INCOMPATIBLE'
  | 'SAVE_FORBIDDEN'
  // 社交
  | 'CHAT_DISABLED'
  // 访问控制（原版素材包门禁：共享口令或房间邀请授权，docs/design/original-skin.md U4）
  | 'ACCESS_REQUIRED';

export const ERROR_MESSAGES_ZH = Object.freeze({
  BAD_HANDSHAKE: '连接参数无效，请刷新页面',
  PROTOCOL_MISMATCH: '客户端版本过旧，请刷新页面',
  BAD_REQUEST: '请求格式不正确',
  RATE_LIMITED: '操作太频繁，请稍后再试',
  SERVER_BUSY: '服务器繁忙，请稍后再试',
  INTERNAL: '服务器内部错误',
  ROOM_NOT_FOUND: '房间不存在或已关闭',
  ROOM_FULL: '房间已满',
  ROOM_IN_GAME: '对局已开始，只能观战',
  ALREADY_IN_ROOM: '你已在另一个进行中的房间里，请先离开',
  NOT_IN_ROOM: '你不在这个房间里',
  NOT_HOST: '只有房主可以这样做',
  NOT_A_PLAYER: '观战者不能进行此操作',
  SEAT_TAKEN: '座位已被占用',
  CHARACTER_TAKEN: '角色已被其他人选择',
  NOT_ALL_READY: '还有玩家没有准备',
  NOT_ENOUGH_PLAYERS: '至少需要 2 名参与者',
  SPECTATORS_DISABLED: '房间不允许观战',
  MAP_UNAVAILABLE: '地图不可用',
  GAME_PAUSED: '对局已暂停',
  GAME_OVER: '对局已结束',
  NOT_YOUR_DECISION: '现在不是你的决策',
  STALE_DECISION: '决策已失效（可能已超时）',
  INVALID_ACTION: '操作不合法',
  MINIGAME_INVALID: '小游戏数据无效',
  MINIGAME_TOO_EARLY: '小游戏提交过早',
  MINIGAME_TOO_LATE: '小游戏已超时',
  SAVE_NOT_FOUND: '存档不存在',
  SAVE_INCOMPATIBLE: '存档与当前版本或地图不兼容',
  SAVE_FORBIDDEN: '你无权读取这个存档',
  CHAT_DISABLED: '聊天已关闭',
  ACCESS_REQUIRED: '需要访问口令或邀请链接才能进入',
} as const satisfies { readonly [C in ErrorCode]: string });

export const ERROR_CODES: readonly ErrorCode[] = Object.freeze(Object.keys(ERROR_MESSAGES_ZH) as ErrorCode[]);

export interface AppError {
  code: ErrorCode;
  message: string;
  /** 例如 INVALID_ACTION 的 { rule }；不得含 secret */
  details?: unknown;
}

export type Result<T = void> = { ok: true; data: T } | { ok: false; error: AppError };

export function appError(code: ErrorCode, details?: unknown, message: string = ERROR_MESSAGES_ZH[code]): AppError {
  return details === undefined ? { code, message } : { code, message, details };
}

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail(code: ErrorCode, details?: unknown): Result<never> {
  return { ok: false, error: appError(code, details) };
}

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === 'string' && Object.hasOwn(ERROR_MESSAGES_ZH, x);
}
