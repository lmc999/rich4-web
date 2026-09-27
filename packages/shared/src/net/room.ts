/**
 * 房间设置与房间视图（architecture §5.8 RoomSettings；design/net.md §3、§4.3）。
 */
import type { GameConfig, RuleConfig } from '../engine/types/config';
import type { CharacterId, DateNum, SeatAiConfig, SeatIndex } from '../engine/types/ids';
import type { SeatControl } from '../view/types';
import { DEFAULT_MAX_SPECTATORS } from './limits';
import type { SaveWarning } from './protocol';
import { type AiPace, DEFAULT_PACING, DEFAULT_RECONNECT_GRACE_S, type PacingProfile, type TimerPreset } from './timing';

export type RoomPhase = 'lobby' | 'playing' | 'paused' | 'ended';

export type SpectatorChat = 'all' | 'spectators' | 'off';
/** default：单次超时执行 defaultIntent（DEV-09）；ai：超时由 AI 代决。托管状态一律由 AI 代打 */
export type TimeoutPolicy = 'default' | 'ai';
/** live：实时转发输入帧并下发观战票据；replay：结算后才下发 seed + log */
export type MinigameSpectate = 'live' | 'replay';

export interface RoomSettings {
  /** public 会出现在大厅列表里 */
  visibility: 'private' | 'public';
  allowSpectators: boolean;
  /** 0..MAX_SPECTATORS_LIMIT */
  maxSpectators: number;
  spectatorChat: SpectatorChat;
  /** 默认 public（还原原版同屏体验） */
  handVisibility: 'public' | 'private';
  /** 默认 normal；单机默认 off */
  timerPreset: TimerPreset;
  /** 默认 default */
  timeoutPolicy: TimeoutPolicy;
  reconnectGraceSec: number;
  pauseWhenAllAway: boolean;
  aiPace: AiPace;
  /** 默认 live */
  minigameSpectate: MinigameSpectate;
  /** 真人可在小游戏倒计时阶段主动跳过（DEV-06），默认 true */
  allowMinigameDecline: boolean;
  /** 演出节奏（original-skin.md U3），默认 original；开局后不可改（截止时间按它计算） */
  pacing: PacingProfile;
  game: GameConfig;
}

/** 客户端可提交的对局配置：startDate 由服务器填当天日期，debug 只由服务器在测试模式下打开 */
export type GameConfigInput = Omit<GameConfig, 'startDate' | 'debug'>;

/** room:create / room:updateSettings 的补丁（服务器合并到当前设置后再校验） */
export type RoomSettingsPatch = Partial<Omit<RoomSettings, 'game'>> & {
  game?: Partial<Omit<GameConfigInput, 'rules'>> & { rules?: Partial<RuleConfig> };
};

/** 除 game 外的默认房间设置 */
export const DEFAULT_ROOM_SETTINGS: Readonly<Omit<RoomSettings, 'game'>> = Object.freeze({
  visibility: 'private',
  allowSpectators: true,
  maxSpectators: DEFAULT_MAX_SPECTATORS,
  spectatorChat: 'all',
  handVisibility: 'public',
  timerPreset: 'normal',
  timeoutPolicy: 'default',
  reconnectGraceSec: DEFAULT_RECONNECT_GRACE_S,
  pauseWhenAllAway: true,
  aiPace: 'normal',
  minigameSpectate: 'live',
  allowMinigameDecline: true,
  pacing: DEFAULT_PACING,
});

/** /solo：私密房、不许观战、不限时（随后 3 次 room:setSeatAi 再 room:start） */
export const SOLO_ROOM_OVERRIDES = Object.freeze({
  visibility: 'private',
  allowSpectators: false,
  timerPreset: 'off',
} as const satisfies RoomSettingsPatch);

/** 默认房间设置（每次返回新对象） */
export function defaultRoomSettings(game: GameConfig): RoomSettings {
  return { ...DEFAULT_ROOM_SETTINGS, game: { ...game, rules: { ...game.rules } } };
}

/** 对局中 room:updateSettings 只允许改这些字段（design/net.md §9） */
export const IN_GAME_MUTABLE_SETTINGS = Object.freeze([
  'spectatorChat',
  'allowSpectators',
] as const) satisfies readonly (keyof RoomSettings)[];

export type SeatOccupantView =
  | { kind: 'human'; nickname: string; connected: boolean; ready: boolean; isYou: boolean }
  | { kind: 'ai'; ai: SeatAiConfig; name: string };

export interface SeatView {
  index: SeatIndex;
  occupant: SeatOccupantView | null;
  characterId: CharacterId | null;
  control: SeatControl;
  isHost: boolean;
  /** 读档后等待认领的座位 */
  savedSeat?: { nickname: string; characterId: CharacterId; wasHuman: boolean; claimableByYou: boolean };
}

export type RoomYou =
  | { role: 'player'; seat: SeatIndex; isHost: boolean }
  | { role: 'spectator'; id: string; isHost: false };

export interface RoomView {
  code: string;
  inviteUrl: string;
  phase: RoomPhase;
  epoch: number;
  seats: [SeatView, SeatView, SeatView, SeatView];
  spectators: { id: string; nickname: string }[];
  settings: RoomSettings;
  you: RoomYou;
  loadedSave?: {
    saveId: string;
    name: string;
    gameDay: number;
    date: DateNum;
    verified: boolean;
    /** 兼容性提示（数据表不一致等），仍可开局 */
    warnings?: SaveWarning[];
  };
  paused?: { reason: 'host' | 'all_away'; since: number };
  serverNow: number;
}

export interface PublicRoomSummary {
  code: string;
  hostName: string;
  phase: RoomPhase;
  mapId: string;
  humans: number;
  ais: number;
  spectators: number;
  allowSpectators: boolean;
  createdAt: number;
}

export type RoomClosedReason = 'dissolved' | 'kicked' | 'idle' | 'server';
