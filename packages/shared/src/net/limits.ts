/**
 * 限流与大小限制（design/net.md §4.8、§9；architecture §5.8）。服务端 rateLimit 与客户端输入框引用同一份常量。
 */

/** 令牌桶：每 perMs 补 count 个，桶容量 burst */
export interface RateRule {
  count: number;
  perMs: number;
  burst: number;
}

export const RATE_LIMITS = Object.freeze({
  'game:act': { count: 10, perMs: 1000, burst: 20 },
  'game:minigameInput': { count: 10, perMs: 1000, burst: 10 },
  'game:minigameSubmit': { count: 1, perMs: 2000, burst: 1 },
  'chat:send': { count: 5, perMs: 10_000, burst: 5 },
  'chat:emote': { count: 1, perMs: 1500, burst: 1 },
  /** room:* 与 lobby:* 共用 */
  room: { count: 20, perMs: 10_000, burst: 20 },
  'time:ping': { count: 2, perMs: 1000, burst: 2 },
  'debug:act': { count: 20, perMs: 1000, burst: 40 },
} as const satisfies Record<string, RateRule>);

/** 每 IP 每分钟 room:join 失败上限（防扫房间号） */
export const JOIN_FAIL_PER_IP_PER_MIN = 20;
/** 每 IP 每分钟建房上限；同一 token 同时只能有 1 个活跃房间 */
export const CREATE_ROOM_PER_IP_PER_MIN = 5;
/** 同一 IP 并发连接上限 */
export const MAX_CONNECTIONS_PER_IP = 30;
/** 单条消息上限（字节） */
export const MAX_MESSAGE_BYTES = 128 * 1024;
/** 全服房间上限默认值（环境变量 MAX_ROOMS） */
export const DEFAULT_MAX_ROOMS = 500;

// 聊天与表情
export const CHAT_MAX_CHARS = 200;
export const CHAT_RATE = Object.freeze({ count: 5, windowMs: 10_000 });
/** ChatLog 保留条数，加入或恢复时经 chat:history 下发 */
export const CHAT_HISTORY_SIZE = 100;
export const EMOTE_COOLDOWN_MS = 1500;

// 身份
export const NICKNAME_MIN = 1;
export const NICKNAME_MAX = 12;
/** 前端生成：16 字节 CSPRNG 转 base64url */
export const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
export const ROOM_CODE_RE = /^[1-9]\d{5}$/;
export const ROOM_CODE_MIN = 100000;
export const ROOM_CODE_MAX = 999999;

// 观战
export const MAX_SPECTATORS_LIMIT = 20;
export const DEFAULT_MAX_SPECTATORS = 10;

// 对局编排
/** 环形缓冲保存的原始 batch 数 */
export const RING_BUFFER_BATCHES = 256;
/** 落后不超过这么多 batch 时 catchup 以 2–4 倍速播放，否则直接 reset */
export const CATCHUP_FAST_MAX = 8;
/** 每个座位记住最近多少个 clientActionId（幂等） */
export const CLIENT_ACTION_LRU = 32;
/** 每多少个 seq 写一次快照 */
export const SNAPSHOT_EVERY_SEQ = 25;

// 小游戏输入流
/** 客户端每 200ms 或攒够 8 条发一次 game:minigameInput */
export const MINIGAME_INPUT_FLUSH_MS = 200;
export const MINIGAME_INPUT_BATCH_MAX = 8;
/** 不允许来自「未来」的 tick：tick ≤ floor((now − startsAt)/tickMs) + 20 */
export const MINIGAME_FUTURE_TICK_TOLERANCE = 20;
/** 提交时序下限：now − startsAt ≥ endTick × tickMs × 0.85 − 500 */
export const MINIGAME_SUBMIT_MIN_RATIO = 0.85;
export const MINIGAME_SUBMIT_SLACK_MS = 500;

// 存档
export const SAVE_NAME_MAX = 40;
export const MAX_MANUAL_SAVES_PER_OWNER = 20;
/** POST /api/saves/import 请求体上限 */
export const SAVE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
/**
 * 读档 / 导入时解压后 JSON 的上限：gzip 压缩比极高，2MB 的请求体上限挡不住膨胀；
 * 一个 GameState 约 50–150KB（时光机锚点另算），留足余量
 */
export const SAVE_DECODE_MAX_JSON_BYTES = 2 * 1024 * 1024;
